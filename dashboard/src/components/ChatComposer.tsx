import { useState } from "react";
import { api } from "../lib/api";

export function ChatComposer({ agentId, disabled }: { agentId: string; disabled?: boolean }) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [composing, setComposing] = useState(false);

  const send = async () => {
    const msg = value.trim();
    if (!msg || sending) return;
    setSending(true);
    // 유저 메시지를 즉시 스레드에 반영 (에코)
    window.dispatchEvent(new CustomEvent("crewdeck:chat-event", {
      detail: { agentId, event: { kind: "text", text: `🧑 ${msg}` } },
    }));
    setValue("");
    try {
      await api.orchestration.sendChat(agentId, msg);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (composing || (e as any).nativeEvent?.isComposing) return; // CJK 조합 중 전송 방지
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="border-t border-gray-100 dark:border-gray-700 p-3">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        disabled={disabled || sending}
        placeholder="메시지를 입력하세요…  (⌘/Ctrl+Enter 전송)"
        className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 resize-none disabled:opacity-50"
        rows={2}
      />
      <div className="flex justify-end mt-2">
        <button
          onClick={() => void send()}
          disabled={disabled || sending || !value.trim()}
          className="bg-indigo-500 text-white text-xs font-bold px-4 py-1.5 rounded-lg disabled:opacity-40"
        >
          {sending ? "전송 중…" : "전송 ⌘⏎"}
        </button>
      </div>
    </div>
  );
}
