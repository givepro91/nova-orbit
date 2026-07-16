import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { TERMINAL_AGENT_PROMPT } from "../shared/terminal-agent.js";

const apiBase = process.env.CREWDECK_API_URL?.replace(/\/$/, "");
const apiKey = process.env.CREWDECK_API_KEY;
const workspaceId = process.env.CREWDECK_WORKSPACE_ID;
const terminalSessionId = process.env.CREWDECK_TERMINAL_ID;

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, any>;
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!apiBase || !apiKey || !workspaceId || !terminalSessionId) {
    throw new Error("Crewdeck terminal environment is missing");
  }
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String((body as { error?: unknown }).error ?? `HTTP ${response.status}`));
  return body;
}

const tools = [
  {
    name: "crewdeck_get_context",
    description: "MANDATORY first step before file changes or verification: read the current Crewdeck Workspace, selected activeGoal/activeTasks, agent organization, and remaining project goals so work is attached to the user's visible non-duplicate goal.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "crewdeck_create_goal",
    description: "Create and immediately surface a Crewdeck goal before editing for a new user-requested objective. Include implementation and verification/review tasks. Call exactly once unless the context already contains an equivalent unfinished goal.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
        tasks: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              assignee: { type: "string", description: "Crewdeck agent name or role from crewdeck_get_context" },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "crewdeck_create_task",
    description: "Add an actionable task to an existing Crewdeck goal when the plan expands.",
    inputSchema: {
      type: "object",
      properties: {
        goalId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, assignee: { type: "string" },
      },
      required: ["goalId", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "crewdeck_update_task",
    description: "MANDATORY lifecycle update. Use the exact sequence todo -> in_progress before work -> in_review after implementation -> done only after diff inspection and verification. Include changed files/checks in the final summary. Use blocked with a concrete reason when work cannot continue.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        status: { type: "string", enum: ["todo", "pending_approval", "in_progress", "in_review", "done", "blocked"] },
        summary: { type: "string" },
      },
      required: ["taskId", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "crewdeck_record_decision",
    description: "Record the user's resolution in the bound terminal session. If the active task was blocked, this resumes it as in_progress so the same agent conversation can continue.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "crewdeck_report_activity",
    description: "Record structured, redacted evidence for the currently bound Goal, Task, Agent, and Terminal. IDs are derived by Crewdeck; never include credentials in summary or metadata.",
    inputSchema: {
      type: "object",
      properties: {
        idempotencyKey: { type: "string", description: "Stable retry key (1-128 URL-safe characters). Reuse it when retrying the same event." },
        kind: {
          type: "string",
          enum: ["task_claimed", "provider_launch_requested", "provider_started", "command_finished", "file_changed", "verification_run", "blocked", "decision_recorded", "completion_requested", "quality_gate_result"],
        },
        summary: { type: "string" },
        metadata: { type: "object", additionalProperties: true },
      },
      required: ["kind", "summary"],
      additionalProperties: false,
    },
  },
];

async function callTool(name: string, args: Record<string, any>): Promise<unknown> {
  const clientRequestId = randomUUID();
  if (name === "crewdeck_get_context") {
    return api(`/terminal-bridge/context?workspaceId=${encodeURIComponent(workspaceId!)}&terminalSessionId=${encodeURIComponent(terminalSessionId!)}`);
  }
  if (name === "crewdeck_create_goal") {
    return api("/terminal-bridge/goals", {
      method: "POST",
      body: JSON.stringify({ workspaceId, terminalSessionId, clientRequestId, ...args }),
    });
  }
  if (name === "crewdeck_create_task") {
    return api("/terminal-bridge/tasks", {
      method: "POST",
      body: JSON.stringify({
        workspaceId, terminalSessionId, clientRequestId, goalId: args.goalId,
        task: { title: args.title, description: args.description, assignee: args.assignee },
      }),
    });
  }
  if (name === "crewdeck_update_task") {
    return api(`/terminal-bridge/tasks/${encodeURIComponent(args.taskId)}`, {
      method: "PATCH",
      body: JSON.stringify({ workspaceId, terminalSessionId, clientRequestId, status: args.status, summary: args.summary }),
    });
  }
  if (name === "crewdeck_record_decision") {
    if (!terminalSessionId) throw new Error("Crewdeck terminal session is missing");
    return api("/terminal-bridge/decisions", {
      method: "POST",
      body: JSON.stringify({ workspaceId, terminalSessionId, message: args.message }),
    });
  }
  if (name === "crewdeck_report_activity") {
    if (!terminalSessionId) throw new Error("Crewdeck terminal session is missing");
    return api("/terminal-bridge/activity", {
      method: "POST",
      body: JSON.stringify({
        workspaceId,
        terminalSessionId,
        idempotencyKey: args.idempotencyKey ?? clientRequestId,
        kind: args.kind,
        summary: args.summary,
        metadata: args.metadata ?? {},
      }),
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}

function send(id: string | number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendError(id: string | number, error: unknown): void {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
  })}\n`);
}

async function handle(message: RpcRequest): Promise<void> {
  if (message.id == null) return;
  try {
    if (message.method === "initialize") {
      send(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "crewdeck-terminal", version: "0.1.0" },
        instructions: TERMINAL_AGENT_PROMPT,
      });
      return;
    }
    if (message.method === "ping") { send(message.id, {}); return; }
    if (message.method === "tools/list") { send(message.id, { tools }); return; }
    if (message.method === "tools/call") {
      const result = await callTool(String(message.params?.name ?? ""), message.params?.arguments ?? {});
      send(message.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result });
      return;
    }
    sendError(message.id, new Error(`Method not found: ${message.method}`));
  } catch (error) {
    send(message.id, {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    });
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  try { void handle(JSON.parse(line) as RpcRequest); } catch { /* malformed input */ }
});
