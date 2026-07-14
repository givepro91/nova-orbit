import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";

// ---------------------------------------------------------------------------
// Custom event names dispatched by CommandPalette
// ---------------------------------------------------------------------------
export const CMD_EVENTS = {
  NEW_PROJECT: "cmd:new-project",
  IMPORT_LOCAL: "cmd:import-local",
  CONNECT_GITHUB: "cmd:connect-github",
  ADD_AGENT: "cmd:add-agent",
  ADD_GOAL: "cmd:add-goal",
  SWITCH_THEME: "cmd:switch-theme",
  SWITCH_LANG: "cmd:switch-lang",
  GO_TAB: "cmd:go-tab",
} as const;

// ---------------------------------------------------------------------------
// Action definition
// ---------------------------------------------------------------------------
type ActionId =
  | "new-project"
  | "import-local"
  | "connect-github"
  | "add-agent"
  | "add-goal"
  | "switch-theme"
  | "switch-lang"
  | "go-kanban"
  | "go-verification"
  | "go-settings";

interface Action {
  id: ActionId;
  labelKey: string;
  icon: React.ReactNode;
  shortcut?: string;
  dispatch: () => void;
}

// ---------------------------------------------------------------------------
// Icon helpers (inline SVG — no external icon lib dependency)
// ---------------------------------------------------------------------------
function Icon({ d, viewBox = "0 0 24 24" }: { d: string; viewBox?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const ICONS: Record<string, React.ReactNode> = {
  plus: <Icon d="M12 5v14M5 12h14" />,
  download: <Icon d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />,
  github: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.2 11.39.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.54-1.38-1.33-1.75-1.33-1.75-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49 1 .11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 3-.4c1.02 0 2.04.14 3 .4 2.28-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58C20.57 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  ),
  agent: <Icon d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />,
  goal: <Icon d="M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3" />,
  sun: <Icon d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M12 7a5 5 0 1 0 0 10A5 5 0 0 0 12 7z" />,
  moon: <Icon d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
  lang: <Icon d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6" />,
  kanban: <Icon d="M3 3h6v18H3zM9 3h6v11H9zM15 3h6v15h-6z" />,
  log: <Icon d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8" />,
  settings: <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />,
};

// ---------------------------------------------------------------------------
// Helper: dispatch browser custom event
// ---------------------------------------------------------------------------
function dispatch(name: string, detail?: unknown) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

// ---------------------------------------------------------------------------
// Helper: check current theme
// ---------------------------------------------------------------------------
function isDarkMode() {
  return document.documentElement.classList.contains("dark");
}

// ---------------------------------------------------------------------------
// CommandPalette component
// ---------------------------------------------------------------------------
export function CommandPalette() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Re-compute isDark reactively when palette opens so the label is accurate
  const [dark, setDark] = useState(false);
  useEffect(() => {
    if (open) setDark(isDarkMode());
  }, [open]);

  // Build action list inside render so labels react to language + theme changes
  const buildActions = useCallback((): Action[] => [
    {
      id: "new-project",
      labelKey: "cmdNewProject",
      icon: ICONS.plus,
      shortcut: "N",
      dispatch: () => dispatch(CMD_EVENTS.NEW_PROJECT),
    },
    {
      id: "import-local",
      labelKey: "cmdImportLocal",
      icon: ICONS.download,
      dispatch: () => dispatch(CMD_EVENTS.IMPORT_LOCAL),
    },
    {
      id: "connect-github",
      labelKey: "cmdConnectGitHub",
      icon: ICONS.github,
      dispatch: () => dispatch(CMD_EVENTS.CONNECT_GITHUB),
    },
    {
      id: "add-agent",
      labelKey: "cmdAddAgent",
      icon: ICONS.agent,
      shortcut: "A",
      dispatch: () => dispatch(CMD_EVENTS.ADD_AGENT),
    },
    {
      id: "add-goal",
      labelKey: "cmdAddGoal",
      icon: ICONS.goal,
      shortcut: "G",
      dispatch: () => dispatch(CMD_EVENTS.ADD_GOAL),
    },
    {
      id: "switch-theme",
      labelKey: dark ? "cmdSwitchToLight" : "cmdSwitchToDark",
      icon: dark ? ICONS.sun : ICONS.moon,
      dispatch: () => dispatch(CMD_EVENTS.SWITCH_THEME),
    },
    {
      id: "switch-lang",
      labelKey: "cmdSwitchLang",
      icon: ICONS.lang,
      shortcut: i18n.language.startsWith("ko") ? "EN" : "KO",
      dispatch: () => dispatch(CMD_EVENTS.SWITCH_LANG),
    },
    {
      id: "go-kanban",
      labelKey: "cmdGoKanban",
      icon: ICONS.kanban,
      dispatch: () => dispatch(CMD_EVENTS.GO_TAB, { tab: "kanban" }),
    },
    {
      id: "go-verification",
      labelKey: "cmdGoVerification",
      icon: ICONS.log,
      dispatch: () => dispatch(CMD_EVENTS.GO_TAB, { tab: "verification" }),
    },
    {
      id: "go-settings",
      labelKey: "cmdGoSettings",
      icon: ICONS.settings,
      shortcut: ",",
      dispatch: () => dispatch(CMD_EVENTS.GO_TAB, { tab: "settings" }),
    },
  ], [dark, i18n.language]);

  const actions = buildActions();

  const filtered = query.trim()
    ? actions.filter((a) =>
        t(a.labelKey as Parameters<typeof t>[0])
          .toLowerCase()
          .includes(query.toLowerCase())
      )
    : actions;

  // Keep selectedIdx in bounds when filtered list changes
  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  // Global keyboard shortcut: Cmd+K / Ctrl+K
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        setQuery("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Auto-focus input when opened
  useEffect(() => {
    if (open) {
      // Defer one tick so the element is mounted and visible
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Internal navigation & selection keyboard handler
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[selectedIdx]) {
        filtered[selectedIdx].dispatch();
        setOpen(false);
        setQuery("");
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  };

  const runAction = (action: Action) => {
    action.dispatch();
    setOpen(false);
    setQuery("");
  };

  if (!open) return null;

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40 backdrop-blur-sm"
      onClick={() => {
        setOpen(false);
        setQuery("");
      }}
      aria-modal="true"
      role="dialog"
      aria-label="Command palette"
    >
      {/* Panel — stop click from propagating to backdrop */}
      <div
        className="
          w-[560px] max-h-[400px] flex flex-col
          bg-surface
          border border-line
          rounded-xl shadow-2xl overflow-hidden
        "
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-line">
          {/* Search icon */}
          <svg
            className="shrink-0 text-faint"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("cmdPlaceholder")}
            className="
              flex-1 bg-transparent outline-none
              text-sm text-fg
              placeholder:text-faint
            "
          />
          {/* Keyboard hint */}
          <kbd className="shrink-0 hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-line text-[10px] text-faint font-mono">
            ESC
          </kbd>
        </div>

        {/* Action list */}
        <ul
          ref={listRef}
          className="flex-1 overflow-y-auto py-1"
          role="listbox"
        >
          {filtered.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-faint">
              {t("cmdNoResults")}
            </li>
          ) : (
            filtered.map((action, idx) => (
              <li
                key={action.id}
                role="option"
                aria-selected={idx === selectedIdx}
                className={`
                  flex items-center gap-3 px-4 py-2.5 cursor-pointer select-none
                  text-sm text-fg
                  transition-colors
                  ${
                    idx === selectedIdx
                      ? "bg-accent/10 text-accent"
                      : "hover:bg-fg/5"
                  }
                `}
                onMouseEnter={() => setSelectedIdx(idx)}
                onClick={() => runAction(action)}
              >
                {/* Icon */}
                <span
                  className={`shrink-0 ${
                    idx === selectedIdx
                      ? "text-accent"
                      : "text-faint"
                  }`}
                >
                  {action.icon}
                </span>

                {/* Label */}
                <span className="flex-1 leading-none">
                  {t(action.labelKey as Parameters<typeof t>[0])}
                </span>

                {/* Optional keyboard shortcut badge */}
                {action.shortcut && (
                  <kbd
                    className={`
                      shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-mono
                      ${
                        idx === selectedIdx
                          ? "border-accent text-accent"
                          : "border-line text-faint"
                      }
                    `}
                  >
                    {action.shortcut}
                  </kbd>
                )}
              </li>
            ))
          )}
        </ul>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-line flex items-center gap-3 text-[10px] text-faint">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">↵</kbd> select</span>
          <span><kbd className="font-mono">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
