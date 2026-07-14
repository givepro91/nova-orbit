import { useState } from "react";
import { useToast } from "../stores/useToast";
import type { ToastItem } from "../stores/useToast";
import type { NotificationType } from "../stores/useNotifications";

// Re-export for legacy imports
export type { NotificationType };

const TYPE_STYLES: Record<NotificationType, string> = {
  info: "bg-fg text-canvas",
  success: "bg-success text-white",
  error: "bg-danger text-white",
};

const TYPE_ICONS: Record<NotificationType, string> = {
  info: "",
  success: "\u2713",
  error: "!",
};

function ToastItem({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`text-sm px-4 py-2.5 rounded-lg shadow-lg max-w-md flex flex-col gap-1 animate-[slideUp_0.2s_ease-out] ${TYPE_STYLES[toast.type]}`}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        {TYPE_ICONS[toast.type] && (
          <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-white/20 text-[10px] font-bold shrink-0">
            {TYPE_ICONS[toast.type]}
          </span>
        )}
        <span className="flex-1 text-left">{toast.message}</span>
        {toast.detail && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="opacity-60 hover:opacity-100 transition-opacity shrink-0 text-[10px] underline"
          >
            {expanded ? "접기" : "상세"}
          </button>
        )}
        <button
          onClick={onDismiss}
          className="opacity-60 hover:opacity-100 transition-opacity shrink-0 text-xs leading-none"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      {expanded && toast.detail && (
        <pre className="text-[10px] opacity-80 whitespace-pre-wrap break-all mt-1 bg-black/20 rounded px-2 py-1.5 max-h-32 overflow-y-auto">
          {toast.detail}
        </pre>
      )}
    </div>
  );
}

/** Global toast stack — mount once at app root or layout level */
export function ToastContainer() {
  const { toasts, dismiss } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[100] flex flex-col-reverse gap-2 items-center">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

/**
 * Legacy single-toast API — wraps the new store.
 * Keeps existing call sites working without changes.
 */
export function Toast({ message, type = "info", onDismiss }: {
  message: string;
  type?: NotificationType;
  onDismiss: () => void;
}) {
  // Bridge: on mount, push to global store and call onDismiss to clear the old state
  const { showToast } = useToast();
  // Use a ref-like pattern to only fire once
  useState(() => {
    showToast(message, type);
    // Clear parent's single-toast state so it doesn't re-render this
    setTimeout(onDismiss, 0);
  });
  return null;
}
