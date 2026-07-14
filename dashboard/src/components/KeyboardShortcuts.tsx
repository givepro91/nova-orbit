import { useEffect } from "react";
import { useTranslation } from "react-i18next";

interface KeyboardShortcutsProps {
  onClose: () => void;
}

const SHORTCUTS = [
  { keys: ["⌘", "K"], descKey: "shortcutCmdPalette" },
  { keys: ["?"], descKey: "shortcutHelp" },
] as const;

export function KeyboardShortcuts({ onClose }: KeyboardShortcutsProps) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-line rounded-xl shadow-lg p-6 w-80"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-muted mb-4">
          {t("keyboardShortcuts")}
        </h2>
        <ul className="space-y-3">
          {SHORTCUTS.map((shortcut) => (
            <li key={shortcut.descKey} className="flex items-center justify-between">
              <span className="text-sm text-muted">
                {t(shortcut.descKey)}
              </span>
              <div className="flex items-center gap-1">
                {shortcut.keys.map((key) => (
                  <kbd
                    key={key}
                    className="px-1.5 py-0.5 text-xs font-mono bg-sunken text-muted border border-line rounded"
                  >
                    {key}
                  </kbd>
                ))}
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[11px] text-faint text-center">{t("keyboardShortcutsClose")}</p>
      </div>
    </div>
  );
}
