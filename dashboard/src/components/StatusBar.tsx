import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getApiKey } from "../lib/api";

interface ClaudeStatus {
  raw: string | null;
  model: string | null;
  inputTokensK: number | null;
  outputTokensK: number | null;
  costUsd: number | null;
  ratePercent: number | null;
  updatedAt: string | null;
  error?: string;
}

interface OrbitStatus {
  activeSessions: number;
  activeAgents: number;
  totalTokens: number;
  totalCost: number;
  todayTokens: number;
  todayCost: number;
  todaySessions: number;
}

/** 7-segment gauge bar like CLI "██░░░░░ 6%" */
function Gauge({ percent, segments = 7 }: { percent: number; segments?: number }) {
  const filled = Math.round((percent / 100) * segments);
  const color =
    percent < 50
      ? "text-green-500"
      : percent < 80
        ? "text-yellow-500"
        : "text-red-500";
  const dot =
    percent < 50
      ? "bg-green-500"
      : percent < 80
        ? "bg-yellow-500"
        : "bg-red-500";

  return (
    <span className="flex items-center gap-1">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot} shrink-0`} />
      <span className="font-mono tracking-tight text-[9px] leading-none">
        {Array.from({ length: segments }, (_, i) => (
          <span
            key={i}
            className={i < filled ? color : "text-gray-600 dark:text-gray-700"}
          >
            {i < filled ? "\u2588" : "\u2591"}
          </span>
        ))}
      </span>
      <span className={`${color} tabular-nums`}>{percent}%</span>
    </span>
  );
}

export function StatusBar() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [orbit, setOrbit] = useState<OrbitStatus | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const [claudeRes, orbitRes] = await Promise.all([
        fetch("/api/claude-status", { headers: { Authorization: `Bearer ${getApiKey() ?? ""}` } }),
        fetch("/api/orbit-status", { headers: { Authorization: `Bearer ${getApiKey() ?? ""}` } }),
      ]);
      if (claudeRes.ok) setStatus(await claudeRes.json());
      if (orbitRes.ok) setOrbit(await orbitRes.json());
    } catch {
      // silent — server may not have statusline
    }
  }, []);

  // Poll every 10s + on mount
  useEffect(() => {
    fetchStatus();
    const timer = setInterval(fetchStatus, 10_000);
    return () => clearInterval(timer);
  }, [fetchStatus]);

  // Also refresh on agent activity
  useEffect(() => {
    const handler = () => { fetchStatus(); };
    window.addEventListener("nova:prompt-complete", handler);
    window.addEventListener("nova:task-usage", handler);
    return () => {
      window.removeEventListener("nova:prompt-complete", handler);
      window.removeEventListener("nova:task-usage", handler);
    };
  }, [fetchStatus]);

  const hasClaudeStatus = status && !status.error && status.raw;

  return (
    <div className="flex items-center gap-2.5 text-[10px] text-gray-400 dark:text-gray-500 font-mono">
      {/* Crewdeck agent stats — always shown when data exists */}
      {orbit && (
        <>
          {orbit.activeAgents > 0 ? (
            <span className="flex items-center gap-1" title={t("orbitActiveAgents")}>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              <span className="text-green-600 dark:text-green-400">{orbit.activeAgents}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1" title={t("orbitActiveAgents")}>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-400" />
            </span>
          )}
          <span className="text-gray-300 dark:text-gray-600">|</span>
          <span className="text-amber-500 dark:text-amber-400 tabular-nums" title={t("orbitTodayCost", { total: orbit.totalCost.toFixed(2) })}>
            <span className="text-[9px] text-amber-400/70 dark:text-amber-500/60 mr-0.5">{t("costLabel")}</span>${orbit.todayCost > 0 ? orbit.todayCost.toFixed(2) : "0"}
          </span>
          <span className="text-gray-300 dark:text-gray-600">|</span>
          <span className="tabular-nums" title={t("orbitTotalTokens", { total: Math.round(orbit.totalTokens / 1000) })}>
            <span className="text-[9px] text-gray-400/70 dark:text-gray-500/60 mr-0.5">{t("tokenLabel")}</span>{Math.round(orbit.todayTokens / 1000)}K
          </span>
          <span className="text-gray-300 dark:text-gray-600">|</span>
          <span className="text-gray-500 dark:text-gray-400 font-sans text-[9px]" title={`${t("today")} ${orbit.todaySessions} sessions`}>
            {orbit.todaySessions}{t("sessions")}
          </span>
        </>
      )}

      {/* Terminal Claude session — optional */}
      {hasClaudeStatus && status!.ratePercent != null && (
        <>
          <span className="text-gray-300 dark:text-gray-600">|</span>
          <span className="flex items-center gap-1" title={t("terminalRateLimit")}>
            <span className="text-gray-500 dark:text-gray-500 text-[9px]">5h</span>
            <Gauge percent={status!.ratePercent!} segments={5} />
          </span>
        </>
      )}

    </div>
  );
}
