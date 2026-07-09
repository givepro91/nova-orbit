/**
 * Agent Activity Log — in-memory ring buffer of recent agent activity.
 *
 * Purpose: the dashboard "라이브 활동" view needs to show what an agent is
 * actively doing (running a command, reading/editing a file, thinking) so the
 * user can tell a busy agent apart from a stuck one. Claude Code CLI already
 * streams stream-json output through `session.on("output")`; this module turns
 * those events into a bounded, human-readable activity feed per agent.
 *
 * Design is split into pure, testable pieces:
 *   - `parseActivityEvents(line)` — pure stream-json line → activity events
 *   - `AgentActivityRing`         — pure bounded ring buffer (last 50)
 *   - `ActivityLogStore`          — per-agent rings + throttled broadcast
 */

export interface ActivityEvent {
  /** ISO timestamp when recorded */
  ts: string;
  /** command | file_read | file_edit | search | browser | web | subagent | plan | text | tool */
  kind: string;
  /** Short human-readable detail, truncated to ACTIVITY_DETAIL_MAX chars */
  detail: string;
  /**
   * Semantic action key within the kind (e.g. browser "click"/"navigate").
   * Data only — the dashboard maps this to a localized label (i18n rule:
   * user-facing labels are translated on the frontend, never stored here).
   */
  action?: string;
}

/** Parsed-but-not-yet-stored event (no timestamp). */
export interface ActivityInput {
  kind: string;
  detail: string;
  action?: string;
}

export interface ActivitySnapshot {
  lastEventAt: string | null;
  events: ActivityEvent[];
}

/** Keep the most recent N activity events per agent. */
export const ACTIVITY_RING_SIZE = 50;
/** Details longer than this are truncated (single-line, whitespace-collapsed). */
export const ACTIVITY_DETAIL_MAX = 200;

/** Collapse whitespace to a single line and hard-cap length. Pure. */
export function truncateDetail(raw: unknown, max = ACTIVITY_DETAIL_MAX): string {
  const clean = String(raw ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

/** Claude Code tool name → activity kind. Unknown tools fall back to "tool". */
const TOOL_KIND: Record<string, string> = {
  Bash: "command",
  Read: "file_read",
  Edit: "file_edit",
  Write: "file_edit",
  MultiEdit: "file_edit",
  NotebookEdit: "file_edit",
  Grep: "search",
  Glob: "search",
};

const str = (v: unknown): string => (v == null ? "" : String(v));
const firstLine = (s: string): string => s.split("\n")[0].trim();

/** Best-effort detail for tools we don't specifically know. Pure. */
function genericDetail(inp: Record<string, unknown>): string {
  const detail = str(
    inp.description ?? inp.command ?? inp.file_path ?? inp.path ?? inp.url ??
    inp.query ?? inp.pattern ?? inp.element ?? inp.name ?? "",
  );
  if (detail) return detail;
  if (Object.keys(inp).length === 0) return "";
  try { return JSON.stringify(inp); } catch { return ""; }
}

/**
 * Extract the human-relevant argument of a Playwright browser_* tool.
 * The raw input JSON ({"element":"...","target":"e31"}) is meaningless to
 * users — pull out the one field a person would ask about. Pure.
 */
function browserDetail(action: string, inp: Record<string, unknown>): string {
  switch (action) {
    case "navigate": return str(inp.url);
    case "click":
    case "hover": return str(inp.element);
    case "type":
      return [str(inp.element), inp.text ? `"${str(inp.text)}"` : ""].filter(Boolean).join(" — ");
    case "press_key": return str(inp.key);
    case "select_option":
      return [str(inp.element), Array.isArray(inp.values) ? inp.values.join(", ") : ""]
        .filter(Boolean).join(" — ");
    case "fill_form":
      return Array.isArray(inp.fields)
        ? inp.fields.map((f: any) => str(f?.name)).filter(Boolean).join(", ")
        : "";
    case "wait_for":
      return str(inp.text ?? inp.textGone ?? (inp.time != null ? `${inp.time}s` : ""));
    case "console_messages": return str(inp.level ?? "");
    case "evaluate":
    case "run_code_unsafe": return firstLine(str(inp.function ?? inp.code ?? ""));
    case "take_screenshot": return str(inp.filename ?? inp.element ?? "");
    default: return genericDetail(inp);
  }
}

/** mcp__<server>__<tool> → tool part, or null if not an MCP tool name. */
function mcpToolName(name: string): string | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  return parts.length >= 3 ? parts[parts.length - 1] : null;
}

/**
 * Summarize a tool_use block into { kind, detail, action? }. Pure.
 * `action` is a semantic key the dashboard localizes; `detail` is data only.
 */
function summarizeTool(name: string, input: unknown): ActivityInput {
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  // MCP tools (mcp__server__tool) — Playwright browser tools get first-class
  // treatment (they dominate QA sessions); other MCP tools keep their short name.
  const mcpTool = mcpToolName(name);
  if (mcpTool) {
    if (mcpTool.startsWith("browser_")) {
      const action = mcpTool.slice("browser_".length);
      return { kind: "browser", action, detail: browserDetail(action, inp) };
    }
    return { kind: "tool", action: mcpTool, detail: genericDetail(inp) };
  }

  // Native tools with a semantic mapping beyond the basic four kinds
  switch (name) {
    case "WebSearch": return { kind: "web", action: "search", detail: str(inp.query) };
    case "WebFetch": return { kind: "web", action: "fetch", detail: str(inp.url) };
    case "Agent":
    case "Task":
      return {
        kind: "subagent",
        action: "delegate",
        detail: str(inp.description ?? "") || str(inp.prompt ?? "").slice(0, 80),
      };
    case "TodoWrite": {
      const todos = Array.isArray(inp.todos) ? inp.todos : [];
      const active = todos.find((t: any) => t?.status === "in_progress") ?? todos[0];
      return { kind: "plan", action: "todo", detail: str(active?.content ?? "") };
    }
    case "Skill": return { kind: "tool", action: "skill", detail: str(inp.skill ?? inp.name) };
  }

  const kind = TOOL_KIND[name] ?? "tool";
  let detail = "";
  if (name === "Bash") {
    detail = str(inp.command);
  } else if (kind === "file_edit" || name === "Read") {
    detail = str(inp.file_path ?? inp.notebook_path ?? inp.path ?? "");
  } else if (name === "Grep" || name === "Glob") {
    detail = [inp.pattern, inp.path].filter(Boolean).join(" ");
  } else {
    // Unknown native tool — keep its name as the action so the UI can label it.
    return { kind: "tool", action: name, detail: genericDetail(inp) };
  }
  return { kind, detail: detail || name };
}

/** Codex 명령의 셸 래퍼(`/bin/zsh -lc '...'`)를 벗겨 실제 명령만 남긴다. Pure. */
function stripShellWrapper(cmd: string): string {
  const m = cmd.match(/^\/bin\/(?:zsh|bash|sh)\s+-l?c\s+'([\s\S]*)'$/);
  return m ? m[1] : cmd;
}

/**
 * Extract human-readable activity events from a single stream-json line.
 * Claude(stream-json)와 Codex(`codex exec --json`) 두 포맷을 모두 인식한다 —
 * 두 CLI의 이벤트 `type`이 겹치지 않아 형식 무관하게 처리 가능.
 * Returns 0+ events. Pure — never throws on malformed input.
 */
export function parseActivityEvents(line: string): ActivityInput[] {
  const out: ActivityInput[] = [];
  let parsed: any;
  try { parsed = JSON.parse(line); } catch { return out; }
  if (!parsed || typeof parsed !== "object") return out;

  // ── Claude Code stream-json ──
  // Assistant turns carry text + tool_use blocks in message.content[]
  const content = parsed?.message?.content;
  if ((parsed.type === "assistant" || parsed.type === "message") && Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        out.push({ kind: "text", detail: block.text });
      } else if (block.type === "tool_use") {
        out.push(summarizeTool(String(block.name ?? "tool"), block.input));
      }
    }
  }

  // Alternative top-level tool_use shape
  if (parsed.type === "tool_use" || parsed.subtype === "tool_use") {
    out.push(summarizeTool(String(parsed.name ?? parsed.tool_name ?? "tool"), parsed.input ?? parsed.tool_input));
  }

  // ── Codex `codex exec --json` ──
  // item.started(command 시작 → 실시간 표시) / item.completed(agent_message 내레이션).
  // command_execution completed는 started와 중복이라 스킵, error item은 비치명 경고라 스킵.
  if (parsed.type === "item.started" || parsed.type === "item.completed") {
    const item = parsed.item;
    if (item && typeof item === "object") {
      if (item.type === "command_execution" && parsed.type === "item.started" && typeof item.command === "string") {
        out.push({ kind: "command", detail: stripShellWrapper(item.command) });
      } else if (item.type === "agent_message" && parsed.type === "item.completed" && typeof item.text === "string" && item.text.trim()) {
        out.push({ kind: "text", detail: item.text });
      }
    }
  }

  return out;
}

/** Bounded, in-memory ring buffer of one agent's recent activity. Pure. */
export class AgentActivityRing {
  private events: ActivityEvent[] = [];
  private _lastEventAt: string | null = null;

  /** Append an event, evicting the oldest beyond capacity. Returns the stored event. */
  push(input: ActivityInput, ts: string = new Date().toISOString()): ActivityEvent {
    const ev: ActivityEvent = { ts, kind: input.kind, detail: truncateDetail(input.detail) };
    if (input.action) ev.action = input.action;
    this.events.push(ev);
    if (this.events.length > ACTIVITY_RING_SIZE) {
      this.events.splice(0, this.events.length - ACTIVITY_RING_SIZE);
    }
    this._lastEventAt = ts;
    return ev;
  }

  get lastEventAt(): string | null { return this._lastEventAt; }
  get size(): number { return this.events.length; }

  /** Chronological (oldest → newest) copy. */
  list(): ActivityEvent[] { return this.events.slice(); }

  snapshot(): ActivitySnapshot {
    return { lastEventAt: this._lastEventAt, events: this.events.slice() };
  }

  clear(): void {
    this.events = [];
    this._lastEventAt = null;
  }
}

type Broadcaster = (event: string, data: unknown) => void;

/**
 * Per-agent activity rings plus a throttled WebSocket broadcaster.
 *
 * Session boundary decision: rings are keyed by agentId and are NOT reset when
 * a new CLI session spawns for the same agent. A single task routinely spans
 * multiple sessions (resume, rate-limit retry, fix cycles); clearing on each
 * respawn would blank the "라이브 활동" panel exactly when a retry begins,
 * making a working agent look reset/stuck. The ring is self-bounding (last 50),
 * so a genuinely new task's output naturally evicts the previous one, and
 * `lastEventAt` drives the staleness indicator regardless of session churn.
 */
export class ActivityLogStore {
  private rings = new Map<string, AgentActivityRing>();
  private lastBroadcastAt = new Map<string, number>();
  private pending = new Map<string, ActivityEvent[]>();
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private broadcaster: Broadcaster | null = null;
  private readonly throttleMs: number;

  constructor(opts: { throttleMs?: number } = {}) {
    this.throttleMs = opts.throttleMs ?? 1000;
  }

  /** Wire the WS broadcaster (set once at server startup). Pass null to detach. */
  setBroadcaster(fn: Broadcaster | null): void {
    this.broadcaster = fn;
  }

  private ring(agentId: string): AgentActivityRing {
    let r = this.rings.get(agentId);
    if (!r) { r = new AgentActivityRing(); this.rings.set(agentId, r); }
    return r;
  }

  /**
   * Record one event. Broadcasts `agent:activity` at most once per throttle
   * window per agent, but never drops events: within a window they accumulate
   * and flush as a batch on the trailing edge. Lossless delivery matters —
   * the dashboard groups the feed by narration events, and a dropped event
   * would silently corrupt that flow view.
   */
  record(agentId: string, input: ActivityInput, ts?: string): ActivityEvent {
    const ev = this.ring(agentId).push(input, ts);
    if (!this.broadcaster) return ev;
    const queue = this.pending.get(agentId) ?? [];
    queue.push(ev);
    this.pending.set(agentId, queue);
    const now = Date.now();
    const elapsed = now - (this.lastBroadcastAt.get(agentId) ?? 0);
    if (elapsed >= this.throttleMs) {
      this.flush(agentId, now);
    } else if (!this.flushTimers.has(agentId)) {
      const timer = setTimeout(() => {
        this.flushTimers.delete(agentId);
        this.flush(agentId, Date.now());
      }, this.throttleMs - elapsed);
      timer.unref?.();
      this.flushTimers.set(agentId, timer);
    }
    return ev;
  }

  private flush(agentId: string, now: number): void {
    const events = this.pending.get(agentId);
    if (!events?.length || !this.broadcaster) return;
    this.pending.set(agentId, []);
    this.lastBroadcastAt.set(agentId, now);
    const last = events[events.length - 1];
    // `event` (singular) kept alongside `events` for older dashboard bundles.
    this.broadcaster("agent:activity", { agentId, events, event: last, lastEventAt: last.ts });
  }

  snapshot(agentId: string): ActivitySnapshot {
    return this.rings.get(agentId)?.snapshot() ?? { lastEventAt: null, events: [] };
  }

  reset(agentId: string): void {
    this.rings.get(agentId)?.clear();
    this.pending.delete(agentId);
    const timer = this.flushTimers.get(agentId);
    if (timer) { clearTimeout(timer); this.flushTimers.delete(agentId); }
  }
}

/** Process-wide singleton — recorded from session.ts, read by the agents route. */
export const agentActivityLog = new ActivityLogStore();
