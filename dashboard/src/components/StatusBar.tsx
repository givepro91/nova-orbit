import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getApiKey } from "../lib/api";

interface ClaudeStatus {
  raw: string | null;
  model: string | null;
  inputTokensK: number | null;
  outputTokensK: number | null;
  costUsd: number | null;
  ratePercent: number | null;   // 5h 롤링 창
  weekPercent: number | null;   // 7d 주간 창
  updatedAt: string | null;
  error?: string;
}

interface ProviderUsage {
  active: number;
  todayTokens: number;
}

interface CrewStatus {
  activeSessions: number;
  activeAgents: number;
  totalTokens: number;
  totalCost: number;
  todayTokens: number;
  todayCost: number;
  todayCompletedGoals: number;
  byProvider?: { claude: ProviderUsage; codex: ProviderUsage };
}

interface CodexStatus {
  available: boolean;
  primaryPercent: number | null; // 5h 롤링 창
  secondaryPercent: number | null; // 7d 주간 창
  primaryResetsAt: number | null; // unix seconds
  secondaryResetsAt: number | null;
  planType: string | null;
  updatedAt: string | null;
}

/** 39813K → 39.8M, 812K → 812K */
function fmtTokens(totalTokens: number): string {
  const k = totalTokens / 1000;
  return k >= 1000 ? `${(k / 1000).toFixed(1)}M` : `${Math.round(k)}K`;
}

/** unix(sec) → "2h" / "45m" / "3d" 남은 시간 (툴팁용) */
function fmtResetIn(ts: number): string {
  const ms = ts * 1000 - Date.now();
  if (ms <= 0) return "now";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)}m`;
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/** 7-segment gauge bar like CLI "██░░░░░ 6%" */
function Gauge({ percent, segments = 7 }: { percent: number; segments?: number }) {
  const filled = Math.round((percent / 100) * segments);
  const color =
    percent < 50
      ? "text-success"
      : percent < 80
        ? "text-warning"
        : "text-danger";
  const dot =
    percent < 50
      ? "bg-success"
      : percent < 80
        ? "bg-warning"
        : "bg-danger";

  return (
    <span className="flex items-center gap-1">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot} shrink-0`} />
      <span className="font-mono tracking-tight text-[9px] leading-none">
        {Array.from({ length: segments }, (_, i) => (
          <span
            key={i}
            className={i < filled ? color : "text-faint"}
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
  const [crew, setCrew] = useState<CrewStatus | null>(null);
  const [codex, setCodex] = useState<CodexStatus | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const [claudeRes, crewRes, codexRes] = await Promise.all([
        fetch("/api/claude-status", { headers: { Authorization: `Bearer ${getApiKey() ?? ""}` } }),
        fetch("/api/crewdeck-status", { headers: { Authorization: `Bearer ${getApiKey() ?? ""}` } }),
        fetch("/api/codex-status", { headers: { Authorization: `Bearer ${getApiKey() ?? ""}` } }),
      ]);
      if (claudeRes.ok) setStatus(await claudeRes.json());
      if (crewRes.ok) setCrew(await crewRes.json());
      if (codexRes.ok) setCodex(await codexRes.json());
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
    window.addEventListener("crewdeck:prompt-complete", handler);
    window.addEventListener("crewdeck:task-usage", handler);
    return () => {
      window.removeEventListener("crewdeck:prompt-complete", handler);
      window.removeEventListener("crewdeck:task-usage", handler);
    };
  }, [fetchStatus]);

  const hasClaudeStatus = status && !status.error && status.raw;

  const codexTitle = codex?.available
    ? [
        t("codexRateLimit"),
        codex.planType,
        codex.primaryPercent != null
          ? `5h ${Math.round(codex.primaryPercent)}%${codex.primaryResetsAt ? ` (${t("resetsIn", { time: fmtResetIn(codex.primaryResetsAt) })})` : ""}`
          : null,
        codex.secondaryPercent != null
          ? `7d ${Math.round(codex.secondaryPercent)}%${codex.secondaryResetsAt ? ` (${t("resetsIn", { time: fmtResetIn(codex.secondaryResetsAt) })})` : ""}`
          : null,
        codex.updatedAt ? t("asOf", { time: new Date(codex.updatedAt).toLocaleTimeString() }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <div className="flex w-max items-center gap-2.5 text-[10px] text-faint font-mono">
      {/* Crewdeck agent stats — always shown when data exists */}
      {crew && (
        <>
          {crew.activeAgents > 0 ? (
            <span className="flex items-center gap-1" title={t("crewActiveAgents")}>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              <span className="text-success">{crew.activeAgents}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1" title={t("crewActiveAgents")}>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-faint" />
            </span>
          )}
          <span className="text-faint">|</span>
          <span className="text-warning tabular-nums" title={t("crewTodayCost", { total: crew.totalCost.toFixed(2) })}>
            <span className="text-[9px] text-warning/70 mr-0.5">{t("costLabel")}</span>${crew.todayCost > 0 ? crew.todayCost.toFixed(2) : "0"}
          </span>
          <span className="text-faint">|</span>
          <span className="tabular-nums" title={t("crewTotalTokens", { total: Math.round(crew.totalTokens / 1000) })}>
            <span className="text-[9px] text-faint mr-0.5">{t("tokenLabel")}</span>{fmtTokens(crew.todayTokens)}
          </span>
          <span className="text-faint">|</span>
          <span className="text-muted font-sans text-[9px]" title={t("crewTodayGoals", { count: crew.todayCompletedGoals })}>
            {crew.todayCompletedGoals}{t("goalsCompleted")}
          </span>
        </>
      )}

      {/* 구독 잔량 — provider별 5h(롤링)/7d(주간) 창. 왼쪽 crewdeck 작업량과 별개 개념. */}
      {hasClaudeStatus && (status!.ratePercent != null || status!.weekPercent != null) && (
        <>
          <span className="text-faint">|</span>
          <span className="flex items-center gap-1.5" title={t("terminalRateLimit")}>
            <span className="text-muted text-[9px]">Claude</span>
            {status!.ratePercent != null && (
              <span className="flex items-center gap-0.5">
                <span className="text-faint text-[9px]">5h</span>
                <Gauge percent={status!.ratePercent!} segments={5} />
              </span>
            )}
            {status!.weekPercent != null && (
              <span className="flex items-center gap-0.5">
                <span className="text-faint text-[9px]">7d</span>
                <Gauge percent={status!.weekPercent!} segments={5} />
              </span>
            )}
          </span>
        </>
      )}

      {/* Codex(GPT) 구독 잔량 — 최신 rollout 의 rate_limits (Claude 와 대칭) */}
      {codex?.available && (codex.primaryPercent != null || codex.secondaryPercent != null) && (
        <>
          <span className="text-faint">|</span>
          <span className="flex items-center gap-1.5" title={codexTitle}>
            {crew?.byProvider && crew.byProvider.codex.active > 0 && (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse shrink-0" />
            )}
            <span className="text-sky-600 dark:text-sky-400 text-[9px]">
              Codex{codex.planType ? `·${codex.planType}` : ""}
            </span>
            {codex.primaryPercent != null && (
              <span className="flex items-center gap-0.5">
                <span className="text-faint text-[9px]">5h</span>
                <Gauge percent={Math.round(codex.primaryPercent)} segments={5} />
              </span>
            )}
            {codex.secondaryPercent != null && (
              <span className="flex items-center gap-0.5">
                <span className="text-faint text-[9px]">7d</span>
                <Gauge percent={Math.round(codex.secondaryPercent)} segments={5} />
              </span>
            )}
          </span>
        </>
      )}

    </div>
  );
}
