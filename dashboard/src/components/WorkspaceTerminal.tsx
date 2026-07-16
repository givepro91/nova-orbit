import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalSession } from "../../../shared/types";
import { api } from "../lib/api";
import { wsSend } from "../hooks/useWebSocket";
import { useTranslation } from "react-i18next";

export function WorkspaceTerminal({
  workspaceId,
  activeGoalId = null,
  onContextStateChange,
  onSessionChange,
}: {
  workspaceId: string;
  activeGoalId?: string | null;
  onContextStateChange?: (state: TerminalSession["contextState"]) => void;
  onSessionChange?: (session: TerminalSession | null) => void;
}) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const bridgeTimerRef = useRef<number | null>(null);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [readyTerminalId, setReadyTerminalId] = useState<string | null>(null);
  const [status, setStatus] = useState<TerminalSession["status"] | "connecting">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [bridgeNotice, setBridgeNotice] = useState<string | null>(null);
  const selectedSession = sessions.find((session) => session.id === terminalId) ?? null;
  const contextState = selectedSession?.contextState ?? "unknown";

  useEffect(() => {
    onContextStateChange?.(contextState);
  }, [contextState, onContextStateChange]);

  useEffect(() => {
    onSessionChange?.(selectedSession);
  }, [onSessionChange, selectedSession]);

  const openTerminal = useCallback(async (forceNew = false) => {
    setError(null);
    setStatus("connecting");
    try {
      const terminal = await api.terminals.create({ workspaceId, cols: 120, rows: 32, forceNew });
      setSessions((current) => [terminal, ...current.filter((item) => item.id !== terminal.id)]);
      setTerminalId(terminal.id);
      setStatus(terminal.status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("terminalCreateFailed"));
      setStatus("error");
    }
  }, [t, workspaceId]);

  useEffect(() => {
    let alive = true;
    api.terminals.list(workspaceId)
      .then((items) => {
        if (!alive) return;
        setSessions(items);
        const active = items.find((item) => item.status === "active");
        if (active) {
          setTerminalId(active.id);
          setStatus(active.status);
        } else if (items[0]?.status === "interrupted") {
          setTerminalId(items[0].id);
          setStatus(items[0].status);
        } else {
          void openTerminal();
        }
      })
      .catch(() => { if (alive) void openTerminal(); });
    return () => { alive = false; };
  }, [openTerminal, workspaceId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setReadyTerminalId(null);
    let disposed = false;
    let disposeTerminal = () => {};
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([xtermModule, fitModule]) => {
      if (disposed) return;
      const terminal = new xtermModule.Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        convertEol: false,
        // CJK monospace가 맨 앞이어야 한글 advance가 라틴의 정확히 2배(xterm의 wide char 셀 폭)가 된다.
        // 라틴만 다른 폰트가 잡으면 em 비율이 어긋나 한글 자간이 벌어진다.
        fontFamily: "'D2Coding', 'SFMono-Regular', Menlo, Monaco, Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.25,
        scrollback: 10_000,
        theme: {
          background: "#17191d",
          foreground: "#d8dee9",
          cursor: "#8b9cfb",
          selectionBackground: "#34405a",
          black: "#202329",
          red: "#ef6b73",
          green: "#8ccf7e",
          yellow: "#e5c76b",
          blue: "#6cb6eb",
          magenta: "#c58cec",
          cyan: "#67cbe7",
          white: "#d8dee9",
        },
      });
      const fit = new fitModule.FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
      const terminalInput = host.querySelector("textarea");
      terminalInput?.setAttribute("aria-label", t("workspaceTerminalTitle"));
      terminalInput?.setAttribute("aria-multiline", "true");
      xtermRef.current = terminal;
      fitRef.current = fit;
      setReadyTerminalId(terminalId);
      const fitTerminal = () => {
        try {
          fit.fit();
          if (terminalId) wsSend({ type: "terminal:resize", terminalId, cols: terminal.cols, rows: terminal.rows });
        } catch { /* hidden during layout transition */ }
      };
      const frame = requestAnimationFrame(() => { fitTerminal(); terminal.focus(); });
      const observer = new ResizeObserver(fitTerminal);
      observer.observe(host);
      const input = terminal.onData((data) => {
        if (terminalId) wsSend({ type: "terminal:input", terminalId, data });
      });
      disposeTerminal = () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        input.dispose();
        terminal.dispose();
        xtermRef.current = null;
        fitRef.current = null;
      };
    });
    return () => {
      disposed = true;
      disposeTerminal();
    };
  }, [t, terminalId]);

  useEffect(() => {
    if (!terminalId || readyTerminalId !== terminalId) return;
    const terminal = xtermRef.current;
    let received = false;
    const onData = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId: string; data: string }>).detail;
      if (detail.terminalId !== terminalId) return;
      received = true;
      terminal?.write(detail.data);
    };
    const onSnapshot = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId: string; data: string; status: TerminalSession["status"] }>).detail;
      if (detail.terminalId !== terminalId) return;
      received = true;
      if (detail.data) terminal?.write(detail.data);
      setStatus(detail.status);
    };
    const onExit = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId: string; status: TerminalSession["status"]; exitCode: number | null }>).detail;
      if (detail.terminalId !== terminalId) return;
      setStatus(detail.status);
      terminal?.writeln(`\r\n\x1b[90m[${t("terminalExited", { code: detail.exitCode ?? "-" })}]\x1b[0m`);
      setSessions((current) => current.map((item) => item.id === terminalId ? { ...item, status: detail.status } : item));
    };
    window.addEventListener("crewdeck:terminal-data", onData);
    window.addEventListener("crewdeck:terminal-snapshot", onSnapshot);
    window.addEventListener("crewdeck:terminal-exit", onExit);
    wsSend({ type: "subscribe:terminal", terminalId });
    const fallback = window.setTimeout(() => {
      if (received) return;
      api.terminals.get(terminalId).then((item) => {
        if (!received && item.output) terminal?.write(item.output);
        setStatus(item.status);
        setSessions((current) => current.map((session) => session.id === item.id ? item : session));
      }).catch(() => undefined);
    }, 250);
    return () => {
      window.clearTimeout(fallback);
      wsSend({ type: "unsubscribe:terminal", terminalId });
      window.removeEventListener("crewdeck:terminal-data", onData);
      window.removeEventListener("crewdeck:terminal-snapshot", onSnapshot);
      window.removeEventListener("crewdeck:terminal-exit", onExit);
    };
  }, [readyTerminalId, t, terminalId]);

  useEffect(() => {
    const onBridge = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string; kind?: string; goal?: { title?: string }; task?: { title?: string } }>).detail;
      if (detail.workspaceId !== workspaceId) return;
      const subject = detail.goal?.title ?? detail.task?.title ?? "";
      setBridgeNotice(t(detail.kind === "goal_created" ? "terminalGoalSynced" : "terminalTaskSynced", { title: subject }));
      if (bridgeTimerRef.current) window.clearTimeout(bridgeTimerRef.current);
      bridgeTimerRef.current = window.setTimeout(() => {
        bridgeTimerRef.current = null;
        setBridgeNotice(null);
      }, 4_000);
    };
    window.addEventListener("crewdeck:terminal-bridge", onBridge);
    return () => {
      window.removeEventListener("crewdeck:terminal-bridge", onBridge);
      if (bridgeTimerRef.current) window.clearTimeout(bridgeTimerRef.current);
    };
  }, [t, workspaceId]);

  const selectSession = (session: TerminalSession) => {
    setTerminalId(session.id);
    setStatus(session.status);
    setError(null);
  };

  const applyDismissedTerminal = useCallback((dismissedTerminalId: string) => {
    const remaining = sessions.filter((session) => session.id !== dismissedTerminalId);
    if (remaining.length === sessions.length) return;
    setSessions(remaining);
    if (terminalId === dismissedTerminalId) {
      const next = remaining.find((session) => session.status === "active") ?? remaining[0] ?? null;
      setTerminalId(next?.id ?? null);
      setStatus(next?.status ?? "exited");
      setError(null);
    }
  }, [sessions, terminalId]);

  useEffect(() => {
    const onDismissed = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId: string; workspaceId: string }>).detail;
      if (detail.workspaceId === workspaceId) applyDismissedTerminal(detail.terminalId);
    };
    window.addEventListener("crewdeck:terminal-dismissed", onDismissed);
    return () => window.removeEventListener("crewdeck:terminal-dismissed", onDismissed);
  }, [applyDismissedTerminal, workspaceId]);

  useEffect(() => {
    const onBinding = (event: Event) => {
      const terminal = (event as CustomEvent<TerminalSession>).detail;
      if (terminal.workspaceId !== workspaceId) return;
      setSessions((current) => current.map((session) => session.id === terminal.id ? terminal : session));
      if (terminal.id === terminalId) setStatus(terminal.status);
    };
    const onFocus = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId?: string }>).detail;
      const next = detail.terminalId ? sessions.find((session) => session.id === detail.terminalId) : selectedSession;
      if (next) selectSession(next);
      window.setTimeout(() => xtermRef.current?.focus(), 0);
    };
    window.addEventListener("crewdeck:terminal-binding", onBinding);
    window.addEventListener("crewdeck:terminal-focus", onFocus);
    return () => {
      window.removeEventListener("crewdeck:terminal-binding", onBinding);
      window.removeEventListener("crewdeck:terminal-focus", onFocus);
    };
  }, [selectedSession, sessions, terminalId, workspaceId]);

  const dismissTerminal = async (session: TerminalSession) => {
    if (session.status === "active") return;
    setError(null);
    try {
      await api.terminals.dismiss(session.id);
      applyDismissedTerminal(session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("terminalDismissFailed"));
    }
  };

  const resumeInterrupted = () => {
    const active = sessions.find((session) => session.status === "active");
    if (active) selectSession(active);
    else void openTerminal(true);
  };

  const statusLabel = (terminalStatus: TerminalSession["status"] | "connecting") => terminalStatus === "connecting"
    ? t("terminalConnecting")
    : t(`terminalStatus_${terminalStatus}`);
  const terminalBackend = selectedSession?.backend ?? "pty";

  const stopTerminal = async () => {
    if (!terminalId || status !== "active") return;
    await api.terminals.kill(terminalId);
  };

  const launchAgent = async (provider: "claude" | "codex") => {
    if (!terminalId || status !== "active") return;
    if (contextState !== "connected") {
      setError(t("terminalContextMismatch"));
      return;
    }
    setError(null);
    try {
      await api.workspaces.selectGoal(workspaceId, activeGoalId);
      const bound = await api.terminals.bind(terminalId, { goalId: activeGoalId, provider });
      setSessions((current) => current.map((session) => session.id === bound.id ? bound : session));
      wsSend({ type: "terminal:input", terminalId, data: `${provider}\r` });
      xtermRef.current?.focus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("terminalContextSelectFailed"));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#17191d]">
      <div className="flex h-9 min-w-0 shrink-0 items-center border-b border-white/10 bg-[#202329] px-1 sm:px-2">
        <div role="tablist" aria-label={t("workspaceTerminalTitle")} className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`flex h-8 shrink-0 items-center rounded-t font-mono text-[11px] ${
                terminalId === session.id ? "bg-[#17191d] text-white" : "text-[#8c929d] hover:text-white"
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={terminalId === session.id}
                onClick={() => selectSession(session)}
                aria-label={t("terminalTabStatus", {
                  tab: t("terminalTab", { count: session.tabNumber }),
                  status: statusLabel(session.status),
                })}
                title={statusLabel(session.status)}
                className="flex h-full items-center gap-2 px-3"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${session.status === "active" ? "bg-success" : "bg-faint"}`} />
                <span>{session.provider ? session.provider === "claude" ? "Claude" : "Codex" : t("terminalTab", { count: session.tabNumber })}</span>
                {session.agentName && <span className="max-w-24 truncate text-[9px] text-faint">· {session.agentName}</span>}
              </button>
              {session.status !== "active" && (
                <button
                  type="button"
                  onClick={() => void dismissTerminal(session)}
                  aria-label={t("terminalCloseTab", { tab: t("terminalTab", { count: session.tabNumber }) })}
                  className="mr-1 flex h-5 w-5 items-center justify-center rounded text-sm text-[#707681] hover:bg-white/10 hover:text-white"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
        <button type="button" onClick={() => void openTerminal(true)} aria-label={t("terminalNew")} className="shrink-0 px-2 text-lg text-[#8c929d] hover:text-white" title={t("terminalNew")}>+</button>
        <button type="button" onClick={() => void launchAgent("claude")} disabled={status !== "active" || contextState !== "connected"} className="shrink-0 rounded px-1.5 py-1 text-[10px] text-[#c7a8ff] hover:bg-white/5 disabled:opacity-30 sm:px-2" title={t("terminalLaunchClaude")}>Claude</button>
        <button type="button" onClick={() => void launchAgent("codex")} disabled={status !== "active" || contextState !== "connected"} className="shrink-0 rounded px-1.5 py-1 text-[10px] text-[#7cc4ff] hover:bg-white/5 disabled:opacity-30 sm:px-2" title={t("terminalLaunchCodex")}>Codex</button>
        <button type="button" onClick={() => void stopTerminal()} disabled={status !== "active"} aria-label={t("terminalStop")} className="shrink-0 px-2 text-xs text-[#8c929d] hover:text-danger disabled:opacity-30" title={t("terminalStop")}>■</button>
      </div>
      {error && <div role="alert" aria-live="assertive" className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}
      {bridgeNotice && <div role="status" aria-live="polite" className="shrink-0 border-b border-success/30 bg-success/10 px-3 py-2 text-xs text-success">✓ {bridgeNotice}</div>}
      {status === "active" && contextState === "mismatch" && (
        <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
          {t("terminalContextMismatch")}
        </div>
      )}
      {status === "interrupted" && (
        <div className="flex shrink-0 items-center gap-3 border-b border-warning/30 bg-warning-subtle px-3 py-2" role="status">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-warning">{t("terminalInterruptedTitle")}</div>
            <div className="mt-0.5 text-[10px] text-muted">
              {sessions.some((session) => session.status === "active")
                ? t("terminalInterruptedHistory")
                : t("terminalInterruptedMessage")}
            </div>
          </div>
          <button
            type="button"
            onClick={resumeInterrupted}
            className="shrink-0 rounded border border-warning/30 bg-surface px-2.5 py-1 text-[10px] font-medium text-warning hover:bg-warning/10"
          >
            {sessions.some((session) => session.status === "active") ? t("terminalGoActive") : t("terminalResume")}
          </button>
        </div>
      )}
      <div ref={hostRef} role="region" className="min-h-0 min-w-0 flex-1 overflow-hidden px-2 py-1" aria-label={t("workspaceTerminalTitle")} />
      <div role="status" aria-live="polite" className="flex h-6 shrink-0 items-center border-t border-white/10 bg-[#202329] px-3 font-mono text-[10px] text-[#8c929d]">
        <span>{statusLabel(status)} · {t(`terminalContext_${contextState}`)}</span>
        <span className="ml-auto">PTY{terminalBackend === "tmux" ? " · tmux" : ""} · xterm-256color</span>
      </div>
    </div>
  );
}
