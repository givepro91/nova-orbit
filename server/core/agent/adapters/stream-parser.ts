/**
 * Parse Claude Code stream-json output to extract useful data.
 *
 * Claude Code with `--output-format stream-json` outputs one JSON object per line:
 * - type: "system" — hooks, session info
 * - type: "assistant" — model responses (message.content[].text)
 * - type: "result" — final result text + usage + cost
 * - type: "tool_use" / "tool_result" — tool calls
 */
import { parseCodexJson } from "./codex-stream-parser.js";

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  durationMs: number;
  numTurns: number;
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
          result.usage = {
            inputTokens: u?.input_tokens ?? 0,
            outputTokens: u?.output_tokens ?? 0,
            cacheReadTokens: u?.cache_read_input_tokens ?? 0,
            cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
            totalCostUsd: parsed.total_cost_usd ?? 0,
            durationMs: parsed.duration_ms ?? 0,
            numTurns: parsed.num_turns ?? 0,
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
export function parseAgentOutput(rawOutput: string, provider: "claude" | "codex"): ParsedStreamOutput {
  return provider === "codex" ? parseCodexJson(rawOutput) : parseStreamJson(rawOutput);
}
