import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalSession } from "../../../shared/types";
import { api } from "../lib/api";
import { wsSend } from "../hooks/useWebSocket";
import { useTranslation } from "react-i18next";

export function WorkspaceTerminal({ workspaceId }: { workspaceId: string }) {
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
        fontFamily: "'SFMono-Regular', Menlo, Monaco, Consolas, monospace",
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
  }, [terminalId]);

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

  const stopTerminal = async () => {
    if (!terminalId || status !== "active") return;
    await api.terminals.kill(terminalId);
  };

  const launchAgent = (provider: "claude" | "codex") => {
    if (!terminalId || status !== "active") return;
    wsSend({ type: "terminal:input", terminalId, data: `${provider}\r` });
    xtermRef.current?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#17191d]">
      <div className="flex h-9 shrink-0 items-center border-b border-white/10 bg-[#202329] px-2">
        <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
          {sessions.map((session, index) => (
            <button
              key={session.id}
              type="button"
              onClick={() => selectSession(session)}
              className={`flex h-8 shrink-0 items-center gap-2 rounded-t px-3 font-mono text-[11px] ${
                terminalId === session.id ? "bg-[#17191d] text-white" : "text-[#8c929d] hover:text-white"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${session.status === "active" ? "bg-success" : "bg-faint"}`} />
              {t("terminalTab", { count: sessions.length - index })}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => void openTerminal(true)} className="px-2 text-lg text-[#8c929d] hover:text-white" title={t("terminalNew")}>+</button>
        <button type="button" onClick={() => launchAgent("claude")} disabled={status !== "active"} className="rounded px-2 py-1 text-[10px] text-[#c7a8ff] hover:bg-white/5 disabled:opacity-30" title={t("terminalLaunchClaude")}>Claude</button>
        <button type="button" onClick={() => launchAgent("codex")} disabled={status !== "active"} className="rounded px-2 py-1 text-[10px] text-[#7cc4ff] hover:bg-white/5 disabled:opacity-30" title={t("terminalLaunchCodex")}>Codex</button>
        <button type="button" onClick={() => void stopTerminal()} disabled={status !== "active"} className="px-2 text-xs text-[#8c929d] hover:text-danger disabled:opacity-30" title={t("terminalStop")}>■</button>
      </div>
      {error && <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}
      {bridgeNotice && <div className="shrink-0 border-b border-success/30 bg-success/10 px-3 py-2 text-xs text-success">✓ {bridgeNotice}</div>}
      <div ref={hostRef} className="min-h-0 flex-1 px-2 py-1" aria-label={t("workspaceTerminalTitle")} />
      <div className="flex h-6 shrink-0 items-center border-t border-white/10 bg-[#202329] px-3 font-mono text-[10px] text-[#8c929d]">
        <span>{status === "connecting" ? t("terminalConnecting") : status}</span>
        <span className="ml-auto">PTY · xterm-256color</span>
      </div>
    </div>
  );
}
