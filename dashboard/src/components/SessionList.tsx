import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { ConfirmDialog } from "./ConfirmDialog";

type ProviderName = "claude" | "codex";
type ProviderResolutionSource = "agent" | "project" | "global";

// 서버 serializeSession이 붙여주는 provider 해석 + failover 관측 트레이스 (shared/types ProviderTrace).
interface ProviderFailoverTrace {
  reasonCode: "rate_limit" | "session_exhausted" | "env_error" | null;
  fromProvider: ProviderName | null;
  toProvider: ProviderName | null;
  redispatched: boolean;
  loopGuardBlocked: boolean;
}

interface ProviderTrace {
  resolvedProvider: ProviderName | null;
  resolutionSource: ProviderResolutionSource | null;
  failover?: ProviderFailoverTrace;
}

const PROVIDER_SOURCE_LABEL_KEYS: Record<ProviderResolutionSource, string> = {
  agent: "providerSourceAgent",
  project: "providerSourceProject",
  global: "providerSourceGlobal",
};

const FAILOVER_REASON_LABEL_KEYS: Record<string, string> = {
  rate_limit: "failoverReasonRateLimit",
  session_exhausted: "failoverReasonSessionExhausted",
  env_error: "failoverReasonEnvError",
};

function providerEngineName(p: ProviderName | null): string {
  return p === "claude" ? "Claude" : p === "codex" ? "Codex" : "—";
}

interface Session {
  id: string;
  agent_id: string;
  task_id: string | null;
  execution_run_id: string | null;
  execution_spec_version_id: string | null;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  token_usage: number;
  cost_usd: number;
  agent_name: string;
  agent_role: string;
  agent_status: string;
  current_activity: string | null;
  project_id: string;
  project_name: string;
  providerTrace?: ProviderTrace;
}

interface Stats {
  total: number;
  active: number;
  completed: number;
  killed: number;
  failed: number;
  total_tokens: number;
  total_cost: number;
  orphan: number;
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-success-subtle text-success",
  completed: "bg-info-subtle text-info",
  killed: "bg-sunken text-muted",
  failed: "bg-danger-subtle text-danger",
};

export function SessionList({ projectId }: { projectId?: string }) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState<string>("active");
  const [loading, setLoading] = useState(true);
  const [killTarget, setKillTarget] = useState<Session | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const load = useCallback(async () => {
    try {
      const [sessionList, sessionStats] = await Promise.all([
        api.sessions.list({ status: filter || undefined, projectId }),
        api.sessions.stats(projectId),
      ]);
      setSessions(sessionList);
      setStats(sessionStats);
    } catch { /* ignore */ }
    setLoading(false);
  }, [filter, projectId]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 10s for active sessions
  useEffect(() => {
    if (filter !== "active") return;
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [filter, load]);

  const handleKill = async (session: Session) => {
    try {
      await api.sessions.kill(session.id);
      setKillTarget(null);
      load();
    } catch { /* ignore */ }
  };

  const handleCleanup = async () => {
    setCleaning(true);
    try {
      const result = await api.sessions.cleanup();
      if (result.cleaned > 0) {
        load();
      }
    } catch { /* ignore */ }
    setCleaning(false);
  };

  const formatTime = (iso: string) => {
    try {
      return new Date(iso + "Z").toLocaleString("ko-KR", {
        month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch { return iso; }
  };

  const formatDuration = (start: string, end: string | null) => {
    try {
      const s = new Date(start + "Z").getTime();
      const e = end ? new Date(end + "Z").getTime() : Date.now();
      const sec = Math.round((e - s) / 1000);
      if (sec < 60) return `${sec}s`;
      if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
      return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
    } catch { return "-"; }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-faint">
        <svg className="animate-spin w-5 h-5 mr-2" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        {t("loading")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Stats Summary */}
      {stats && (
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-6 text-xs">
            <span className="text-success font-medium">
              {t("sessionActive")}: {stats.active}
            </span>
            {stats.orphan > 0 && (
              <span className="text-danger font-medium">
                {t("sessionOrphan")}: {stats.orphan}
              </span>
            )}
            <span className="text-faint">
              {t("sessionTotal")}: {stats.total}
            </span>
            <span className="text-faint">
              {t("sessionTotalTokens")}: {(stats.total_tokens / 1000).toFixed(0)}K
            </span>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            {stats.orphan > 0 && (
              <button
                onClick={handleCleanup}
                disabled={cleaning}
                className="text-xs px-3 py-1 bg-danger-subtle text-danger border border-danger rounded hover:bg-fg/10 disabled:opacity-50 transition-colors"
              >
                {cleaning ? t("sessionCleaning") : t("sessionCleanup", { count: stats.orphan })}
              </button>
            )}
            <button
              onClick={load}
              className="text-xs px-2 py-1 text-faint hover:text-muted transition-colors"
              title={t("refresh")}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-1 border-b border-line">
        {[
          { id: "active", label: t("sessionFilterActive") },
          { id: "killed", label: t("sessionFilterKilled") },
          { id: "", label: t("sessionFilterAll") },
        ].map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`text-xs px-3 py-1.5 transition-colors ${
              filter === f.id
                ? "text-fg border-b-2 border-fg font-medium"
                : "text-faint hover:text-muted"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Session Table */}
      {sessions.length === 0 ? (
        <div className="py-8 text-center text-xs text-muted">
          {filter === "active" ? t("sessionNoActive") : t("sessionNoResults")}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-faint border-b border-line-soft">
                <th className="py-2 pr-3 font-medium">{t("sessionColAgent")}</th>
                {!projectId && <th className="py-2 pr-3 font-medium">{t("sessionColProject")}</th>}
                <th className="py-2 pr-3 font-medium">{t("sessionColStatus")}</th>
                <th className="py-2 pr-3 font-medium">{t("providerTraceTitle")}</th>
                <th className="py-2 pr-3 font-medium">{t("sessionColStarted")}</th>
                <th className="py-2 pr-3 font-medium">{t("sessionColDuration")}</th>
                <th className="py-2 pr-3 font-medium">{t("sessionColTokens")}</th>
                <th className="py-2 pr-3 font-medium">PID</th>
                <th className="py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr
                  key={s.id}
                  className="border-b border-line-soft hover:bg-fg/5 transition-colors"
                >
                  <td className="py-2 pr-3">
                    <div className="font-medium text-muted">{s.agent_name}</div>
                    <div className="text-[10px] text-faint">{s.agent_role}</div>
                  </td>
                  {!projectId && (
                    <td className="py-2 pr-3 text-muted">
                      {s.project_name}
                    </td>
                  )}
                  <td className="py-2 pr-3">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_BADGE[s.status] ?? STATUS_BADGE.killed}`}>
                      {s.status}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    {s.providerTrace?.resolvedProvider ? (
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-1 flex-wrap">
                          <span className="text-muted">
                            {providerEngineName(s.providerTrace.resolvedProvider)}
                          </span>
                          {s.providerTrace.resolutionSource && (
                            <span className="text-[9px] px-1 py-0.5 rounded-full bg-sunken text-muted">
                              {t(PROVIDER_SOURCE_LABEL_KEYS[s.providerTrace.resolutionSource])}
                            </span>
                          )}
                        </div>
                        {(() => {
                          const fo = s.providerTrace?.failover;
                          if (!fo || (!fo.redispatched && !fo.loopGuardBlocked && !fo.reasonCode)) return null;
                          return (
                            <div className="flex items-center gap-1 flex-wrap">
                              {fo.redispatched && (
                                <span className="text-[9px] px-1 py-0.5 rounded-full bg-warning-subtle text-warning">
                                  {providerEngineName(fo.fromProvider)} → {providerEngineName(fo.toProvider)}
                                </span>
                              )}
                              {fo.reasonCode && (
                                <span className="text-[9px] px-1 py-0.5 rounded-full bg-warning-subtle text-warning">
                                  {t(FAILOVER_REASON_LABEL_KEYS[fo.reasonCode] ?? fo.reasonCode)}
                                </span>
                              )}
                              {fo.loopGuardBlocked && (
                                <span className="text-[9px] px-1 py-0.5 rounded-full bg-sunken text-muted">
                                  {t("failoverLoopGuardBlocked")}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-muted">
                    {formatTime(s.started_at)}
                  </td>
                  <td className="py-2 pr-3 text-muted">
                    {formatDuration(s.started_at, s.ended_at)}
                  </td>
                  <td className="py-2 pr-3 text-muted">
                    {s.token_usage > 0 ? `${(s.token_usage / 1000).toFixed(1)}K` : "-"}
                  </td>
                  <td className="py-2 pr-3 font-mono text-faint text-[10px]">
                    {s.pid ?? "-"}
                  </td>
                  <td className="py-2">
                    {s.status === "active" && (
                      <button
                        onClick={() => setKillTarget(s)}
                        className="text-[10px] px-2 py-0.5 text-danger hover:bg-danger-subtle rounded transition-colors"
                      >
                        {t("sessionKill")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Kill confirmation */}
      {killTarget && (
        <ConfirmDialog
          message={t("sessionKillConfirm", { agent: killTarget.agent_name, project: killTarget.project_name })}
          onConfirm={() => handleKill(killTarget)}
          onCancel={() => setKillTarget(null)}
        />
      )}
    </div>
  );
}
