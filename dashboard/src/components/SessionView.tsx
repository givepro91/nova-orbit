import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLiveSessionStore, type StreamLine } from "../stores/liveSession";

// useSyncExternalStore(zustand 내부)는 getSnapshot이 매번 새 참조를 반환하면 무한 렌더 루프에
// 빠진다(React error #185) — 데이터 없을 때의 fallback은 반드시 안정된 참조를 재사용해야 한다.
const EMPTY_LINES: StreamLine[] = [];

/**
 * 활성 session 실시간 관찰 + 조향 뷰. session:stream(agentId 스코프)을 라인 단위로
 * append 렌더하고, 하단 입력창은 goalId 스코프의 조향(steering) 큐에 제출한다.
 * 제출은 실행 중 session을 kill/restart하지 않고 다음 Generator 스텝 경계에서 반영된다.
 */
export function SessionView({ agentId, goalId }: { agentId: string; goalId: string | null }) {
  const { t } = useTranslation();
  const lines = useLiveSessionStore((s) => s.streamByAgentId[agentId] ?? EMPTY_LINES);
  const notes = useLiveSessionStore((s) => (goalId ? s.notesByGoalId[goalId] : undefined));
  const submitting = useLiveSessionStore((s) => (goalId ? s.submittingByGoalId[goalId] : false)) ?? false;
  const error = useLiveSessionStore((s) => (goalId ? s.errorByGoalId[goalId] : undefined));
  const fetchNotes = useLiveSessionStore((s) => s.fetchNotes);
  const submitNote = useLiveSessionStore((s) => s.submitNote);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!goalId) return;
    fetchNotes(goalId).catch(() => undefined);
  }, [goalId, fetchNotes]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines[lines.length - 1]?.id]);

  const pending = (notes ?? []).filter((n) => !n.injected);

  const handleSubmit = async () => {
    const content = draft.trim();
    if (!content || !goalId || submitting) return;
    setDraft("");
    try {
      await submitNote(goalId, content);
    } catch {
      // 실패는 store의 errorByGoalId에 반영되어 아래에 표시된다.
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-2.5 font-mono text-[11px] leading-relaxed"
        style={{ background: "#0d1117", color: "#39d353" }}
      >
        {lines.length === 0 ? (
          <span style={{ color: "#4b5563" }}>{t("sessionViewWaiting")}</span>
        ) : (
          lines.map((line) => (
            <div key={line.id} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {line.kind === "text" ? line.detail : `[${line.kind}] ${line.detail}`}
            </div>
          ))
        )}
      </div>
      <div className="border-t border-gray-100 dark:border-gray-700 p-2.5 shrink-0">
        {!goalId ? (
          <p className="text-[11px] text-gray-400 dark:text-gray-500">{t("wsNoGoal")}</p>
        ) : (
          <>
            {pending.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1">
                {pending.map((n) => (
                  <span
                    key={n.id}
                    title={n.content}
                    className="inline-flex max-w-[220px] items-center gap-1 truncate rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                  >
                    {n.content}
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-1.5">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSubmit();
                  }
                }}
                placeholder={t("sessionViewPlaceholder")}
                disabled={submitting}
                className="flex-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800"
              />
              <button
                onClick={() => void handleSubmit()}
                disabled={submitting || !draft.trim()}
                className="rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40"
              >
                {submitting ? t("sessionViewSending") : t("sessionViewSubmit")}
              </button>
            </div>
            {error && <p className="mt-1 text-[10px] text-red-500 dark:text-red-400">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
