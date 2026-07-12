/**
 * Parse Codex `codex exec --json` JSONL output to extract useful data.
 *
 * Codex는 한 줄당 하나의 JSON 이벤트를 낸다 (codex-cli 0.141.0 실측):
 * - {"type":"thread.started","thread_id":"<uuid>"}           — 세션/스레드 id
 * - {"type":"turn.started"}
 * - {"type":"item.completed","item":{"type":"agent_message","text":"..."}}  — 텍스트 출력
 * - {"type":"item.completed","item":{"type":"error","message":"..."}}       — 비치명 경고(exit 0에도 나옴)
 * - {"type":"turn.completed","usage":{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}
 *
 * claude 파서(stream-parser.ts)와 동일한 ParsedStreamOutput으로 정규화해 소비자가 provider를 몰라도 되게 한다.
 */
import type { ParsedStreamOutput } from "./stream-parser.js";

export function parseCodexJson(rawOutput: string): ParsedStreamOutput {
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

  const lines = rawOutput.split("\n").map((l) => l.trim()).filter(Boolean);
  result.lineCount = lines.length;
  let lastMessage = "";

  for (const line of lines) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // 비JSONL 줄은 무시
    }

    switch (ev?.type) {
      case "thread.started":
        if (typeof ev.thread_id === "string") result.sessionId = ev.thread_id;
        break;

      case "item.completed": {
        const item = ev.item ?? {};
        if (item.type === "agent_message" && typeof item.text === "string") {
          lastMessage = item.text; // 최종 메시지 = 마지막 agent_message
        } else if (item.type === "command_execution" || item.type === "tool_call") {
          result.toolUses.push({ name: item.type, input: item });
        }
        // item.type === "error" 는 비치명 경고(dev features/skill budget) — errors에 넣지 않음
        break;
      }

      // 치명적 실패 이벤트 — item.completed의 error(비치명 경고)와 달리
      // top-level "error"와 "turn.failed"는 턴 자체가 죽은 것이라 errors에 담아
      // 소비자가 "no text output" 대신 진짜 원인(예: 모델/버전 불일치 400)을
      // 사용자에게 노출할 수 있게 한다.
      case "error":
        result.errors.push(`Codex error: ${typeof ev.message === "string" ? ev.message : JSON.stringify(ev.message ?? ev)}`);
        break;

      case "turn.failed":
        result.errors.push(`Codex turn failed: ${ev.error?.message ?? JSON.stringify(ev.error ?? {})}`);
        break;

      case "turn.completed": {
        const u = ev.usage ?? {};
        const tokenUsageReported = Number.isFinite(u.input_tokens)
          && u.input_tokens >= 0
          && Number.isFinite(u.output_tokens)
          && u.output_tokens >= 0;
        result.usage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cached_input_tokens ?? 0,
          cacheCreationTokens: 0,
          totalCostUsd: 0, // Codex는 cost 미보고
          durationMs: 0,
          numTurns: 1,
          tokenUsageReported,
          costUsdReported: false,
        };
        break;
      }
    }
  }

  result.text = lastMessage;
  if (lines.length === 0) result.errors.push("Empty stdout from Codex CLI");
  return result;
}
