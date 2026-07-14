import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatEvent } from "../types";
import { ToolCard, type ToolCardData } from "./ToolCard";
import { ConfirmDialog } from "./ConfirmDialog";
import { api } from "../lib/api";

type Checkpoint = { commit: string; turn: number; at: string };

type Item =
  | { row: "text"; text: string }
  | { row: "thinking"; text: string }
  | { row: "tool"; data: ToolCardData }
  | { row: "todo"; items: Array<{ content: string; status: string }> };

type InjectedChip = { label: string; detail?: string; tone: "pass" | "conditional" | "fail" | "neutral" };

// 주입됨 스트립 칩 색 — 판정 배지 🟢🟡🔴 tone 포함.
const CHIP_TONE: Record<string, string> = {
  pass: "text-success bg-success-subtle",
  conditional: "text-warning bg-warning-subtle",
  fail: "text-danger bg-danger-subtle",
  neutral: "text-muted bg-sunken",
};

// 경과 초 → "0:45" / "1:23" (1분 미만은 "45초").
function fmtWait(s: number): string {
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}초`;
}

// 에이전트 응답 마크다운 — bold/이탤릭/코드/리스트/링크/코드블록/표. 채팅 밀도에 맞춘 간격.
// react-markdown v9 Components 타입은 화살표 파라미터에 contextual typing을 못 줘 implicit any가 난다 → props 타입 명시.
type MdProps = { children?: ReactNode; className?: string; href?: string };
const MD_COMPONENTS: Components = {
  p: ({ children }: MdProps) => <p className="mb-2 last:mb-0">{children}</p>,
  strong: ({ children }: MdProps) => <strong className="font-semibold text-fg">{children}</strong>,
  em: ({ children }: MdProps) => <em className="italic">{children}</em>,
  a: ({ href, children }: MdProps) => <a href={href} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2 break-all">{children}</a>,
  ul: ({ children }: MdProps) => <ul className="list-disc pl-5 mb-2 space-y-1 marker:text-faint">{children}</ul>,
  ol: ({ children }: MdProps) => <ol className="list-decimal pl-5 mb-2 space-y-1 marker:text-faint">{children}</ol>,
  li: ({ children }: MdProps) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }: MdProps) => <h1 className="text-[15px] font-semibold mt-3 mb-1.5 first:mt-0">{children}</h1>,
  h2: ({ children }: MdProps) => <h2 className="text-sm font-semibold mt-3 mb-1.5 first:mt-0">{children}</h2>,
  h3: ({ children }: MdProps) => <h3 className="text-sm font-semibold mt-2 mb-1 first:mt-0">{children}</h3>,
  blockquote: ({ children }: MdProps) => <blockquote className="border-l-2 border-line pl-3 my-2 text-muted">{children}</blockquote>,
  hr: () => <hr className="my-3 border-line" />,
  // 코드블록(language-* className)은 pre가 감싸므로 code는 폰트만; 인라인 code는 배경 pill.
  code: ({ className, children }: MdProps) =>
    className ? (
      <code className={`font-mono ${className}`}>{children}</code>
    ) : (
      <code className="px-1 py-0.5 rounded bg-sunken font-mono text-[0.85em] break-all">{children}</code>
    ),
  pre: ({ children }: MdProps) => <pre className="bg-terminal text-terminal-fg rounded-lg p-3 overflow-x-auto my-2 text-[12px] leading-relaxed">{children}</pre>,
  table: ({ children }: MdProps) => (
    <div className="overflow-x-auto my-2">
      <table className="text-xs border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }: MdProps) => <th className="border border-line px-2 py-1 bg-sunken font-medium text-left">{children}</th>,
  td: ({ children }: MdProps) => <td className="border border-line px-2 py-1">{children}</td>,
};

export function ChatThread({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<Item[]>([]);
  const [injected, setInjected] = useState<InjectedChip[]>([]);
  const [queued, setQueued] = useState(0);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [confirm, setConfirm] = useState<{ commit: string; turn: number } | null>(null);
  const [waitSec, setWaitSec] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const toolIndex = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const handler = (e: Event) => {
      const { agentId: aid, event } = (e as CustomEvent<{ agentId: string; event: ChatEvent }>).detail;
      if (aid !== agentId) return;
      // 소환 컨텍스트는 스레드 흐름이 아니라 상단 sticky 스트립에 표시(스크롤과 분리).
      if (event.kind === "context") { setInjected(event.items); return; }
      // 실행 중 큐 잔량 — 하단 칩(스레드 흐름과 분리).
      if (event.kind === "queue") { setQueued(event.remaining); return; }
      // 턴 경계 체크포인트 목록 — 하단 "되돌리기" 스트립(스레드 흐름과 분리).
      if (event.kind === "checkpoint") { setCheckpoints(event.items); return; }
      setItems((prev) => {
        const next = [...prev];
        switch (event.kind) {
          case "text":
            next.push({ row: "text", text: event.text });
            break;
          case "result": {
            // claude는 최종 답을 마지막 assistant text 블록과 result에 중복으로 실어 보낸다.
            // 직전 text 행과 같으면 중복이라 skip(text 없이 result만 오는 codex/짧은 응답은 그대로 표시).
            const last = next[next.length - 1];
            if (last?.row === "text" && last.text.trim() === event.text.trim()) break;
            next.push({ row: "text", text: event.text });
            break;
          }
          case "thinking":
            next.push({ row: "thinking", text: event.text });
            break;
          case "todo":
            next.push({ row: "todo", items: event.items });
            break;
          case "tool_use": {
            toolIndex.current.set(event.id, next.length);
            next.push({ row: "tool", data: { id: event.id, name: event.name, input: event.input, state: "running" } });
            break;
          }
          case "tool_result": {
            const idx = toolIndex.current.get(event.id);
            if (idx != null && next[idx]?.row === "tool") {
              const t = next[idx] as Extract<Item, { row: "tool" }>;
              next[idx] = { row: "tool", data: { ...t.data, state: event.isError ? "error" : "done", result: event.content } };
            }
            break;
          }
        }
        return next;
      });
    };
    window.addEventListener("crewdeck:chat-event", handler);
    return () => window.removeEventListener("crewdeck:chat-event", handler);
  }, [agentId]);

  // 강제 오토스크롤 금지 — 바닥 근처(80px)일 때만 follow
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [items]);

  // 마지막이 유저 에코(🧑)면 아직 에이전트 응답 전 — "기다리는 중" 표시로 멈춘 느낌 제거.
  const lastItem = items[items.length - 1];
  const awaitingReply = !!lastItem && lastItem.row === "text" && lastItem.text.startsWith("🧑");

  // 응답 대기 경과 시간 — 얼마나 기다렸는지 1초 단위로 표시(멈춤/지연 체감 완화).
  useEffect(() => {
    if (!awaitingReply) { setWaitSec(0); return; }
    const start = Date.now();
    setWaitSec(0);
    const id = setInterval(() => setWaitSec(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [awaitingReply]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto flex flex-col">
      {/* 주입됨 — 상단 sticky, 컨테이너 가장자리 풀블리드(불투명·그림자로 스크롤 콘텐츠와 분리) */}
      {injected.length > 0 && (
        <div className="sticky top-0 z-10 px-4 py-2 bg-accent/10 border-b border-accent/25 shadow-sm flex flex-wrap gap-1.5 items-center">
          <span className="text-[11px] font-semibold text-accent">⚡ 주입됨</span>
          {injected.map((chip, i) => (
            <span key={i} className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${CHIP_TONE[chip.tone] ?? CHIP_TONE.neutral}`}>
              {chip.label}{chip.detail ? `: ${chip.detail}` : ""}
            </span>
          ))}
        </div>
      )}

      {/* 본문 — 유일한 패딩 영역(스트립은 가장자리, 메시지만 안쪽 여백) */}
      <div className="flex-1 px-4 py-3 space-y-3">
        {items.map((it, i) => {
          if (it.row === "tool") return <ToolCard key={i} data={it.data} />;
          if (it.row === "thinking")
            return (
              <details key={i} className="text-xs">
                <summary className="text-faint cursor-pointer">🧠 생각 정리</summary>
                <div className="text-muted border-l-2 border-line pl-2 mt-1 whitespace-pre-wrap">{it.text}</div>
              </details>
            );
          if (it.row === "todo")
            return (
              <div key={i} className="border border-line rounded-lg bg-elevated px-3 py-2 text-xs">
                <div className="font-semibold mb-1">
                  진행 {it.items.filter((t) => t.status === "completed").length} / {it.items.length}
                </div>
                {it.items.map((t, j) => (
                  <div key={j} className={t.status === "completed" ? "text-faint line-through" : t.status === "in_progress" ? "font-semibold" : "opacity-70"}>
                    {t.status === "completed" ? "✓" : "▸"} {t.content}
                  </div>
                ))}
              </div>
            );
          // 유저 메시지(🧑 에코)는 오른쪽 말풍선, 에이전트 응답은 왼쪽 마크다운 — 화자 구분.
          if (it.text.startsWith("🧑")) {
            return (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] text-sm bg-accent text-on-accent rounded-2xl rounded-br-md px-3.5 py-2 whitespace-pre-wrap break-words shadow-sm">
                  {it.text.replace(/^🧑\s*/, "")}
                </div>
              </div>
            );
          }
          return (
            <div key={i} className="max-w-full text-sm text-fg break-words leading-relaxed">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{it.text}</ReactMarkdown>
            </div>
          );
        })}
        {awaitingReply && (
          <div className="flex items-center gap-2 text-xs text-faint flex-wrap">
            <span className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" />
            </span>
            <span>
              {t("chatPending")}
              {waitSec > 0 && <span className="tabular-nums"> · {fmtWait(waitSec)}</span>}
            </span>
            {waitSec >= 30 && (
              <span className="text-warning">{t("chatSlowHint")}</span>
            )}
          </div>
        )}
      </div>

      {/* 하단 sticky — 큐 잔량 + "되돌리기". 컨테이너 가장자리 풀블리드(불투명·상단 그림자) */}
      {(queued > 0 || checkpoints.length > 0) && (
        <div className="sticky bottom-0 z-10">
          {queued > 0 && (
            <div className="px-4 py-1.5 bg-warning-subtle border-t border-warning/25 text-[11px] text-warning font-medium">
              {t("queueChip", { n: queued })}
            </div>
          )}
          {checkpoints.length > 0 && (
            // "되돌리기"를 우선 노출(Bolt Try-to-Fix 안티패턴 배제) — 턴 경계 스냅샷으로 코드만 복원.
            <div className="px-4 py-1.5 bg-surface border-t border-line shadow-[0_-2px_8px_rgba(0,0,0,0.04)] flex flex-wrap gap-1.5 items-center">
              <span className="text-[11px] text-muted font-medium">{t("checkpointRevert")}</span>
              {[...checkpoints].reverse().slice(0, 6).map((c) => (
                <button
                  key={c.commit}
                  onClick={() => setConfirm({ commit: c.commit, turn: c.turn })}
                  className="text-[11px] px-2 py-0.5 rounded-full font-medium text-muted bg-sunken hover:bg-fg/10"
                >
                  ↩ {t("checkpointTurn", { n: c.turn })}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          message={t("checkpointConfirm", { n: confirm.turn })}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            void api.orchestration.restoreCheckpoint(agentId, c.commit);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
