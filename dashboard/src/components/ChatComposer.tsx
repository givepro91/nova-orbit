import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";

export function ChatComposer({
  agentId,
  disabled,
  taskId,
  workspaceId,
}: {
  agentId: string;
  disabled?: boolean;
  taskId?: string | null;
  workspaceId?: string | null;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [composing, setComposing] = useState(false);
  // 세션 실행 중 — 전송을 막지 않고 큐로 보낸다(Phase 4a). Esc로 중단 가능.
  const working = !!disabled;

  // steer=true(⌘⏎): 실행 중이면 현재 턴 중단+resume, idle이면 일반 전송(백엔드가 세션 상태로 중재).
  // steer=false(⏎): idle 전송 / 실행 중 큐(백엔드 busy→큐).
  const send = async (steer = false) => {
    const msg = value.trim();
    if (!msg || sending) return;
    setSending(true);
    // 유저 메시지를 즉시 스레드에 반영 (에코)
    window.dispatchEvent(new CustomEvent("crewdeck:chat-event", {
      detail: { agentId, workspaceId: workspaceId ?? null, event: { kind: "text", text: `🧑 ${msg}` } },
    }));
    setValue("");
    try {
      await api.orchestration.sendChat(agentId, msg, { taskId, steer, workspaceId });
    } finally {
      setSending(false);
    }
  };

  const abort = async () => {
    try { await api.orchestration.abortChat(agentId, workspaceId); } catch { /* 이미 종료됐을 수 있음 */ }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (composing || (e as { nativeEvent?: { isComposing?: boolean } }).nativeEvent?.isComposing) return; // CJK 조합 중 방지
    if (e.key === "Escape" && working) { e.preventDefault(); void abort(); return; } // 실행 중 중단
    if (e.key !== "Enter") return;
    if (e.shiftKey) return; // Shift+⏎ = 개행(textarea 기본 동작)
    e.preventDefault();
    void send(e.metaKey || e.ctrlKey); // ⌘/Ctrl+⏎ = 끼어들기(steer), ⏎ = 전송/큐
  };

  return (
    <div className="border-t border-line-soft p-3">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        disabled={sending}
        placeholder={t("composerPlaceholder")}
        className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-surface resize-none disabled:opacity-50"
        rows={2}
      />
      <div className="flex justify-between items-center mt-2">
        <span className="text-[11px] text-faint">
          {working ? t("composerWorkingHint") : ""}
        </span>
        <div className="flex gap-2">
          {working && (
            <button
              onClick={() => void send(true)}
              disabled={sending || !value.trim()}
              className="text-accent hover:text-accent-hover text-xs font-bold px-3 py-1.5 rounded-lg border border-accent/25 hover:bg-accent/10 disabled:opacity-40"
            >
              {t("composerSteer")}
            </button>
          )}
          {working && (
            <button
              onClick={() => void abort()}
              className="text-danger text-xs font-bold px-3 py-1.5 rounded-lg border border-danger/25 hover:bg-danger/10"
            >
              {t("composerAbort")}
            </button>
          )}
          <button
            onClick={() => void send()}
            disabled={sending || !value.trim()}
            className="bg-accent text-on-accent text-xs font-bold px-4 py-1.5 rounded-lg disabled:opacity-40"
          >
            {sending ? t("composerSending") : working ? t("composerQueue") : t("composerSend")}
          </button>
        </div>
      </div>
    </div>
  );
}
