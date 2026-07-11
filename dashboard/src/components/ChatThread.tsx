import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  pass: "text-green-600 bg-green-100 dark:text-green-300 dark:bg-green-500/15",
  conditional: "text-amber-600 bg-amber-100 dark:text-amber-300 dark:bg-amber-500/15",
  fail: "text-red-600 bg-red-100 dark:text-red-300 dark:bg-red-500/15",
  neutral: "text-gray-500 bg-gray-100 dark:text-gray-300 dark:bg-gray-700",
};

export function ChatThread({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<Item[]>([]);
  const [injected, setInjected] = useState<InjectedChip[]>([]);
  const [queued, setQueued] = useState(0);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [confirm, setConfirm] = useState<{ commit: string; turn: number } | null>(null);
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

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
      {injected.length > 0 && (
        <div className="sticky top-0 z-10 -mx-4 -mt-3 mb-1 px-4 py-2 bg-indigo-50/90 dark:bg-indigo-500/10 backdrop-blur border-b border-indigo-100 dark:border-indigo-500/20 flex flex-wrap gap-1.5 items-center">
          <span className="text-[11px] font-semibold text-indigo-500 dark:text-indigo-300">⚡ 주입됨</span>
          {injected.map((chip, i) => (
            <span key={i} className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${CHIP_TONE[chip.tone] ?? CHIP_TONE.neutral}`}>
              {chip.label}{chip.detail ? `: ${chip.detail}` : ""}
            </span>
          ))}
        </div>
      )}
      {items.map((it, i) => {
        if (it.row === "tool") return <ToolCard key={i} data={it.data} />;
        if (it.row === "thinking")
          return (
            <details key={i} className="text-xs">
              <summary className="text-gray-400 dark:text-gray-500 cursor-pointer">🧠 생각 정리</summary>
              <div className="text-gray-500 dark:text-gray-400 border-l-2 border-gray-200 dark:border-gray-700 pl-2 mt-1 whitespace-pre-wrap">{it.text}</div>
            </details>
          );
        if (it.row === "todo")
          return (
            <div key={i} className="border border-gray-100 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 px-3 py-2 text-xs">
              <div className="font-semibold mb-1">
                진행 {it.items.filter((t) => t.status === "completed").length} / {it.items.length}
              </div>
              {it.items.map((t, j) => (
                <div key={j} className={t.status === "completed" ? "text-gray-400 line-through" : t.status === "in_progress" ? "font-semibold" : "opacity-70"}>
                  {t.status === "completed" ? "✓" : "▸"} {t.content}
                </div>
              ))}
            </div>
          );
        return <div key={i} className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words">{it.text}</div>;
      })}
      {(queued > 0 || checkpoints.length > 0) && (
        <div className="sticky bottom-0 -mx-4 -mb-3">
          {queued > 0 && (
            <div className="px-4 py-1.5 bg-amber-50/90 dark:bg-amber-500/10 backdrop-blur border-t border-amber-100 dark:border-amber-500/20 text-[11px] text-amber-700 dark:text-amber-300 font-medium">
              {t("queueChip", { n: queued })}
            </div>
          )}
          {checkpoints.length > 0 && (
            // "되돌리기"를 우선 노출(Bolt Try-to-Fix 안티패턴 배제) — 턴 경계 스냅샷으로 코드만 복원.
            <div className="px-4 py-1.5 bg-gray-50/95 dark:bg-gray-800/95 backdrop-blur border-t border-gray-100 dark:border-gray-700 flex flex-wrap gap-1.5 items-center">
              <span className="text-[11px] text-gray-500 dark:text-gray-400 font-medium">{t("checkpointRevert")}</span>
              {[...checkpoints].reverse().slice(0, 6).map((c) => (
                <button
                  key={c.commit}
                  onClick={() => setConfirm({ commit: c.commit, turn: c.turn })}
                  className="text-[11px] px-2 py-0.5 rounded-full font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 dark:text-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600"
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
