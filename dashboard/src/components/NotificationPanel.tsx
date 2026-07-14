import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNotifications } from "../stores/useNotifications";
import type { NotificationType } from "../stores/useNotifications";

interface NotificationPanelProps {
  onClose: () => void;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const TYPE_ICON: Record<NotificationType, string> = {
  success: "✅",
  error: "❌",
  info: "ℹ️",
};

const TYPE_COLOR: Record<NotificationType, string> = {
  success: "text-success",
  error: "text-danger",
  info: "text-info",
};

export function NotificationPanel({ onClose }: NotificationPanelProps) {
  const { t } = useTranslation();
  const { notifications, clearAll } = useNotifications();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 bg-black/10 dark:bg-black/30 z-40" />

      {/* Panel */}
      <div
        ref={panelRef}
        className="fixed top-0 right-0 h-full w-[360px] bg-surface border-l border-line z-50 flex flex-col shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            <h2 className="text-sm font-semibold text-fg">
              {t("notifications")}
            </h2>
            {notifications.length > 0 && (
              <span className="text-[10px] bg-sunken text-muted rounded-full px-1.5 py-0.5 font-medium">
                {notifications.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {notifications.length > 0 && (
              <button
                onClick={clearAll}
                className="text-[10px] text-faint hover:text-muted transition-colors"
              >
                {t("clearAll")}
              </button>
            )}
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-fg/5 text-faint transition-colors"
              aria-label="Close"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-faint">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              <p className="text-sm text-faint">{t("noNotifications")}</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {notifications.map((notif) => (
                <div key={notif.id} className="flex items-start gap-3 px-5 py-3 hover:bg-fg/5 transition-colors">
                  <span className="text-sm mt-0.5 shrink-0">{TYPE_ICON[notif.type]}</span>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-medium ${TYPE_COLOR[notif.type]} break-words`}>
                      {notif.message}
                    </p>
                    <p className="text-[10px] text-faint mt-0.5">
                      {formatTime(notif.timestamp)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
