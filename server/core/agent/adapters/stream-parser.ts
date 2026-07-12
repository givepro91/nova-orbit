/**
 * Parse Claude Code stream-json output to extract useful data.
 *
 * Claude Code with `--output-format stream-json` outputs one JSON object per line:
 * - type: "system" — hooks, session info
 * - type: "assistant" — model responses (message.content[].text)
 * - type: "result" — final result text + usage + cost
 * - type: "tool_use" / "tool_result" — tool calls
 */
import { parseCodexJson } from "../codex-stream-parser.js";
import type { AgentHandoff, AgentHandoffStage } from "../../../../shared/types.js";
import {
  validateAgentHandoff,
  type AgentHandoffDiagnostic,
} from "../handoff.js";

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  durationMs: number;
  numTurns: number;
  tokenUsageReported: boolean;
  costUsdReported: boolean;
}

export interface RateLimitInfo {
  /** "allowed" (normal) | "allowed_warning" (approaching) | "rejected" (hard block) */
  status: "allowed" | "allowed_warning" | "rejected" | string;
  /** Unix timestamp when the window resets */
  resetsAt: number | null;
  /** Which window: "seven_day", "five_hour", etc. */
  rateLimitType: string | null;
  /** 0.0 ~ 1.0+ (can exceed 1 with overage) */
  utilization: number | null;
  isUsingOverage: boolean;
}

export interface ParsedStreamOutput {
  /** Extracted text from assistant messages */
  text: string;
  /** Session ID if found */
  sessionId: string | null;
  /** Total raw lines parsed */
  lineCount: number;
  /** Tool uses detected */
  toolUses: Array<{ name: string; input: unknown }>;
  /** Any errors from the stream */
  errors: string[];
  /** Token usage and cost (from result event) */
  usage: UsageInfo | null;
  /** Most recent rate_limit_event info (informational — does NOT imply failure) */
  rateLimit: RateLimitInfo | null;
  /** Validated producer handoff when an expected stage was requested. */
  handoff: AgentHandoff | null;
  /** Field-level reasons why a requested handoff could not be accepted. */
  handoffDiagnostics: AgentHandoffDiagnostic[];
}

export function parseStreamJson(rawOutput: string): ParsedStreamOutput {
  const result: ParsedStreamOutput = {
    text: "",
    sessionId: null,
    lineCount: 0,
    toolUses: [],
    errors: [],
    usage: null,
    rateLimit: null,
    handoff: null,
    handoffDiagnostics: [],
  };

  if (!rawOutput || rawOutput.trim() === "") {
    result.errors.push("Empty stdout from Claude Code CLI — no output received");
    return result;
  }

  const lines = rawOutput.split("\n").filter(Boolean);
  result.lineCount = lines.length;

  let jsonParsed = 0;
  let jsonFailed = 0;
  const typesFound = new Set<string>();

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      jsonParsed++;

      const eventType = parsed.type ?? "unknown";
      typesFound.add(eventType);

      // Extract session ID
      if (parsed.session_id && !result.sessionId) {
        result.sessionId = parsed.session_id;
      }

      // Extract assistant text — support multiple content structures
      if (parsed.type === "assistant" && parsed.message?.content) {
        for (const block of parsed.message.content) {
          if (block.type === "text") {
            result.text += block.text;
          }
        }
      }

      // content_block_delta — streaming text chunks (Claude Code v3.14+)
      if (parsed.type === "content_block_delta" && parsed.delta?.text) {
        result.text += parsed.delta.text;
      }

      // message_delta with text — alternative streaming format
      if (parsed.type === "message" && parsed.content) {
        for (const block of Array.isArray(parsed.content) ? parsed.content : []) {
          if (block.type === "text" && block.text) {
            result.text += block.text;
          }
        }
      }

      // Extract final result + usage data
      if (parsed.type === "result") {
        if (parsed.result) {
          // Use result text only if it's longer (more complete) than accumulated assistant text,
          // otherwise keep assistant text which may contain structured output (e.g. JSON blocks)
          if (parsed.result.length > result.text.length) {
            result.text = parsed.result;
          }
        }
        // Also check subtype text
        if (parsed.subtype === "text" && parsed.text) {
          if (parsed.text.length > result.text.length) {
            result.text = parsed.text;
          }
        }

        // Extract usage from result event
        const u = parsed.usage;
        if (u || parsed.total_cost_usd !== undefined) {
          const tokenUsageReported = Number.isFinite(u?.input_tokens)
            && u!.input_tokens >= 0
            && Number.isFinite(u?.output_tokens)
            && u!.output_tokens >= 0;
          const costUsdReported = Number.isFinite(parsed.total_cost_usd)
            && parsed.total_cost_usd >= 0;
          result.usage = {
            inputTokens: u?.input_tokens ?? 0,
            outputTokens: u?.output_tokens ?? 0,
            cacheReadTokens: u?.cache_read_input_tokens ?? 0,
            cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
            totalCostUsd: parsed.total_cost_usd ?? 0,
            durationMs: parsed.duration_ms ?? 0,
            numTurns: parsed.num_turns ?? 0,
            tokenUsageReported,
            costUsdReported,
          };
        }
      }

      // Track tool uses
      if (parsed.type === "tool_use" || parsed.subtype === "tool_use") {
        result.toolUses.push({
          name: parsed.name ?? parsed.tool_name ?? "unknown",
          input: parsed.input ?? parsed.tool_input ?? {},
        });
      }

      // Track errors
      if (parsed.type === "error") {
        result.errors.push(parsed.message ?? parsed.error ?? "Unknown error");
      }

      // Track rate limit events.
      //
      // Claude Code emits `rate_limit_event` as a STATE-CHANGE notification,
      // not a 429. The `rate_limit_info.status` distinguishes:
      //   - "allowed"         → normal, informational only
      //   - "allowed_warning" → approaching limit, still allowed to proceed
      //   - "rejected"        → HARD block, requests will fail
      //
      // Only "rejected" is fatal. Soft warnings must NOT fail the task — the
      // older code pushed every event to errors[] which caused STREAM_ERROR
      // at ~36% utilization (user has plenty of capacity).
      //
      // The CLI emits camelCase (`rateLimitInfo`); SDKs normalize to snake_case.
      // Handle both.
      if (eventType === "rate_limit_event") {
        const info = parsed.rate_limit_info ?? parsed.rateLimitInfo ?? {};
        const status = info.status ?? "unknown";
        result.rateLimit = {
          status,
          resetsAt: info.resets_at ?? info.resetsAt ?? null,
          rateLimitType: info.rate_limit_type ?? info.rateLimitType ?? null,
          utilization: typeof (info.utilization) === "number" ? info.utilization : null,
          isUsingOverage: Boolean(info.is_using_overage ?? info.isUsingOverage ?? false),
        };
        if (status === "rejected") {
          const windowLabel = result.rateLimit.rateLimitType ?? "unknown";
          const resetsAt = result.rateLimit.resetsAt
            ? new Date(result.rateLimit.resetsAt * 1000).toISOString()
            : "unknown";
          result.errors.push(
            `Rate limit hit: ${windowLabel} window rejected (resets at ${resetsAt})`,
          );
        }
        // allowed / allowed_warning → informational, do not fail
      }
    } catch {
      jsonFailed++;
    }
  }

  // Report parsing issues
  if (jsonFailed > 0 && jsonParsed === 0) {
    result.errors.push(
      `All ${lines.length} lines failed JSON parsing — stdout may not be stream-json format. First 200 chars: ${rawOutput.slice(0, 200)}`
    );
  } else if (result.text === "" && jsonParsed > 0) {
    result.errors.push(
      `Parsed ${jsonParsed} JSON lines but extracted no text — event types found: [${[...typesFound].join(", ")}]. First 500 chars: ${rawOutput.slice(0, 500)}`
    );
  }

  return result;
}

/**
 * Provider-aware 파서 라우터. RunResult.provider에 따라 claude/codex 파서를 고른다.
 * 반환 타입은 동일한 ParsedStreamOutput이라 소비자는 provider를 몰라도 된다.
 */
export function parseAgentOutput(
  rawOutput: string,
  provider: "claude" | "codex",
  expectedHandoffStage?: AgentHandoffStage,
): ParsedStreamOutput {
  const parsed = provider === "codex" ? parseCodexJson(rawOutput) : parseStreamJson(rawOutput);
  if (expectedHandoffStage) {
    const handoff = extractAgentHandoff(parsed.text, expectedHandoffStage);
    parsed.handoff = handoff.handoff;
    parsed.handoffDiagnostics = handoff.diagnostics;
  }
  return parsed;
}

/**
 * `from` 이후 첫 `{` 부터 짝이 맞는 `}` 까지의 JSON 객체 substring 을 스캔한다.
 * 문자열 리터럴(escape 포함) 안의 `{` `}` 와 백틱은 무시하므로, 펜스나 코드
 * 스니펫이 문자열 필드 안에 박혀도 잘리지 않는다. 균형이 맞지 않으면 null.
 */
function scanBalancedObject(
  text: string,
  from: number,
): { json: string; start: number } | null {
  const start = text.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return { json: text.slice(start, i + 1), start };
    }
  }
  return null;
}

export interface ExtractedAgentHandoff {
  handoff: AgentHandoff | null;
  diagnostics: AgentHandoffDiagnostic[];
}

/**
 * Extracts an explicit top-level `handoff` property from agent text.
 * The raw object is validated strictly — missing required arrays are a
 * contract violation here, not normalized away. Array normalization is a
 * producer-side concern (`createAgentHandoff`), not this consumption
 * boundary. Plain prose is never promoted into a handoff.
 */
export function extractAgentHandoff(
  text: string,
  expectedStage: AgentHandoffStage,
): ExtractedAgentHandoff {
  const candidates: unknown[] = [];
  for (let from = 0; ; ) {
    const object = scanBalancedObject(text, from);
    if (!object) break;
    try {
      const parsed = JSON.parse(object.json) as unknown;
      if (
        typeof parsed === "object"
        && parsed !== null
        && !Array.isArray(parsed)
        && Object.prototype.hasOwnProperty.call(parsed, "handoff")
      ) {
        candidates.push((parsed as Record<string, unknown>).handoff);
      }
    } catch {
      // Keep scanning: prose may contain a malformed object before the final JSON block.
    }
    // Continue after the whole top-level candidate. Re-entering at start + 1
    // would promote nested objects such as { result: { handoff: ... } } into
    // false top-level handoff candidates.
    from = object.start + object.json.length;
  }

  if (candidates.length === 0) {
    return {
      handoff: null,
      diagnostics: [{
        field: "handoff",
        code: "missing_field",
        message: "Required top-level handoff object is missing from agent output.",
      }],
    };
  }

  const raw = candidates[candidates.length - 1];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      handoff: null,
      diagnostics: [{
        field: "handoff",
        code: "invalid_type",
        message: "Top-level handoff must be an object.",
      }],
    };
  }

  const validation = validateAgentHandoff(raw);
  if (!validation.success) {
    return { handoff: null, diagnostics: validation.diagnostics };
  }
  if (validation.data.stage !== expectedStage) {
    return {
      handoff: null,
      diagnostics: [{
        field: "stage",
        code: "invalid_value",
        message: `Handoff stage '${validation.data.stage}' does not match expected stage '${expectedStage}'.`,
      }],
    };
  }
  return { handoff: validation.data, diagnostics: [] };
}

/**
 * 에이전트 텍스트 응답에서 구조화 JSON 블록을 추출한다 (provider 무관).
 *
 * Quality Gate evaluator 처럼 구조화 출력을 요구하는 소비자가 재사용한다.
 * ` ```json ` 펜스 블록을 우선하고, 없으면 `"verdict"` 를 포함한 최상위 객체를
 * 탐지한다. 어느 쪽도 없으면 null — 소비자가 파싱 실패로 처리한다.
 *
 * 추출은 정규식 대신 문자열-인식 brace 밸런싱으로 한다. 과거 non-greedy 펜스
 * 정규식은 evaluator 가 fixInstruction/reproCommand 같은 문자열 필드에 코드 펜스
 * (```bash …```)를 넣으면 그 안쪽 첫 ``` 에서 JSON 을 잘라 "evaluator did not
 * return valid JSON" 파싱 실패를 유발했다.
 */
export function extractJsonBlock(text: string): string | null {
  if (!text) return null;

  const candidates: string[] = [];

  // 1) ```json 펜스가 있으면 그 뒤 첫 균형 객체를 우선한다.
  const fenceIdx = text.indexOf("```json");
  if (fenceIdx !== -1) {
    const obj = scanBalancedObject(text, fenceIdx + "```json".length);
    if (obj) candidates.push(obj.json);
  }

  // 2) 폴백: "verdict" 를 포함한 첫 균형 객체.
  for (let from = 0; ; ) {
    const obj = scanBalancedObject(text, from);
    if (!obj) break;
    if (obj.json.includes('"verdict"')) {
      candidates.push(obj.json);
      break;
    }
    from = obj.start + 1;
  }

  // 파싱 가능한 첫 후보를 우선 반환. 없으면 첫 후보(best-effort — 소비자가 실제
  // 파싱 오류를 표면화), 후보도 없으면 null.
  for (const c of candidates) {
    try {
      JSON.parse(c);
      return c;
    } catch {
      /* 다음 후보 시도 */
    }
  }
  return candidates[0] ?? null;
}
