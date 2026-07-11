/**
 * 라인별 stream-json → ChatEvent 증분 파서.
 *
 * 기존 parseStreamJson(stream-parser.ts)은 전체 stdout를 집계하는 배치 파서라
 * 라이브 채팅엔 부적합하다. 여기서는 라인 1개 → ChatEvent[]로 즉시 변환하고,
 * tool_use.id ↔ tool_result 매칭은 프론트가 카드 상태로 처리한다(파서는 stateless).
 */
import type { ChatEvent } from "../../../../shared/types.js";

/** tool_result.content(배열/문자열)을 사람이 읽을 문자열로 평탄화. */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === "string" ? b : b?.text ?? JSON.stringify(b)))
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

/** stream-json 한 줄을 ChatEvent 배열로 변환한다. 파싱 불가/무관한 줄은 []. */
export function parseChatEvents(line: string, provider: "claude" | "codex"): ChatEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (provider === "codex") {
    // Codex는 Phase 1에서 텍스트만 지원(툴 카드는 후속). codex-stream-parser.ts(실측)와
    // 동일하게 item.completed / agent_message 의 text만 흘린다.
    if (
      obj?.type === "item.completed" &&
      obj?.item?.type === "agent_message" &&
      typeof obj?.item?.text === "string" &&
      obj.item.text
    ) {
      return [{ kind: "text", text: obj.item.text }];
    }
    return [];
  }

  const out: ChatEvent[] = [];

  // assistant 메시지: text / thinking / tool_use 블록
  if (obj?.type === "assistant" && Array.isArray(obj?.message?.content)) {
    for (const block of obj.message.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        out.push({ kind: "text", text: block.text });
      } else if (block?.type === "thinking" && typeof block.thinking === "string") {
        out.push({ kind: "thinking", text: block.thinking });
      } else if (block?.type === "tool_use") {
        if (block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {
          out.push({ kind: "todo", items: block.input.todos });
        } else {
          out.push({ kind: "tool_use", id: block.id ?? "", name: block.name ?? "unknown", input: block.input ?? {} });
        }
      }
    }
  }

  // user 메시지: tool_result 블록
  if (obj?.type === "user" && Array.isArray(obj?.message?.content)) {
    for (const block of obj.message.content) {
      if (block?.type === "tool_result") {
        out.push({
          kind: "tool_result",
          id: block.tool_use_id ?? "",
          isError: Boolean(block.is_error),
          content: flattenContent(block.content),
        });
      }
    }
  }

  // 최종 result 텍스트
  if (obj?.type === "result" && typeof obj?.result === "string" && obj.result) {
    out.push({ kind: "result", text: obj.result });
  }

  return out;
}

/**
 * output 청크는 라인 경계로 안 잘려 온다. 버퍼에 누적하고 완결된 라인만 파싱한다.
 * (session.ts의 activityLineBuf와 같은 재조립 패턴 — 채팅 전용으로 격리.)
 */
export class ChatEventAssembler {
  private buf = "";
  constructor(private provider: "claude" | "codex") {}

  push(chunk: string): ChatEvent[] {
    this.buf += chunk;
    const nl = this.buf.lastIndexOf("\n");
    if (nl < 0) {
      if (this.buf.length > 1_000_000) this.buf = this.buf.slice(-1_000_000);
      return [];
    }
    const complete = this.buf.slice(0, nl);
    this.buf = this.buf.slice(nl + 1);
    const events: ChatEvent[] = [];
    for (const l of complete.split("\n")) {
      if (l.trim()) events.push(...parseChatEvents(l, this.provider));
    }
    return events;
  }
}
