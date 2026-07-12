import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProvider,
  ReportDetail,
  ReportFinalStatus,
  ReportHistoryKind,
  ReportSummary,
} from "../../../shared/types";
import { api } from "../lib/api";
import { useStore } from "../stores/useStore";

type SortKey = "startedAt" | "durationMs" | "providers" | "retryCount" | "failoverCount" | "evaluationCount" | "fixRoundCount" | "finalStatus";

const statusTone: Record<ReportFinalStatus, string> = {
  running: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  completed: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  failed: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  interrupted: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
};

const historyTone: Record<ReportHistoryKind, string> = {
  failure: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  retry: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  failover: "bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
  evaluation: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  fix: "bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
};

function formatDuration(value: number | null, missing: string) {
  if (value === null) return missing;
  const seconds = Math.floor(value / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatDate(value: string | null, locale: string, missing: string) {
  if (!value) return missing;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? missing : date.toLocaleString(locale);
}

function formatMetric(value: number | null, unreported: string, options?: Intl.NumberFormatOptions) {
  return value === null ? unreported : new Intl.NumberFormat(undefined, options).format(value);
}

function formatCount(report: ReportSummary, value: number, missing: string, unreported?: string) {
  if (report.telemetry === "none") return missing;
  if (report.telemetry === "partial" && value === 0 && unreported) return unreported;
  return value;
}

function compareReports(a: ReportSummary, b: ReportSummary, sortKey: SortKey) {
  if (sortKey === "providers") {
    const left = a.providers.map((usage) => usage.provider).join("+") || null;
    const right = b.providers.map((usage) => usage.provider).join("+") || null;
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return right.localeCompare(left);
  }
  const left = a[sortKey];
  const right = b[sortKey];
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (typeof left === "number" && typeof right === "number") return right - left;
  return String(right).localeCompare(String(left));
}

function ProviderUsage({ report }: { report: ReportSummary }) {
  const { t } = useTranslation();
  if (report.providers.length === 0) return <span className="text-gray-400">{t("reportNoRecord")}</span>;
  return (
    <div className="space-y-1">
      {report.providers.map((usage) => (
        <div key={usage.provider} className="flex flex-wrap gap-x-1 text-[11px] text-gray-600 dark:text-gray-300">
          <span className="font-medium capitalize">{usage.provider}</span>
          <span className="text-gray-400">· {usage.sessionCount} {t("reportSessions")}</span>
          <span className="text-gray-400">· {formatMetric(usage.tokens, t("reportUnreported"))} {t("reportTokens")}</span>
          <span className="text-gray-400">· {usage.costUsd === null ? t("reportUnreported") : `$${formatMetric(usage.costUsd, t("reportUnreported"), { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`}</span>
        </div>
      ))}
    </div>
  );
}

function ReportDetailPanel({ detail, onClose }: { detail: ReportDetail; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const hasTelemetry = detail.telemetry !== "none";
  return (
    <section id="report-detail" className="mt-5 min-w-0 border-t border-gray-200 pt-5 dark:border-gray-700" aria-labelledby="report-detail-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 id="report-detail-title" className="min-w-0 break-words text-sm font-semibold text-gray-900 dark:text-gray-100">{detail.title}</h2>
            <span className="shrink-0 rounded bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              {detail.telemetry === "none" ? t("reportNoRecord") : detail.telemetry === "partial" ? t("reportPartial") : t("reportComplete")}
            </span>
          </div>
        </div>
        <button type="button" onClick={onClose} className="shrink-0 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:hover:bg-gray-800">
          {t("close")}
        </button>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="min-w-0">
          <dt className="text-[10px] text-gray-400">{t("reportStarted")}</dt>
          <dd className="mt-1 break-words text-xs text-gray-700 dark:text-gray-200">{formatDate(detail.startedAt, i18n.language, t("reportNoRecord"))}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] text-gray-400">{t("reportEnded")}</dt>
          <dd className="mt-1 break-words text-xs text-gray-700 dark:text-gray-200">{formatDate(detail.endedAt, i18n.language, detail.finalStatus === "running" ? t("reportRunning") : t("reportNoRecord"))}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-gray-400">{t("reportDuration")}</dt>
          <dd className="mt-1 text-xs font-medium text-gray-700 dark:text-gray-200">{formatDuration(detail.durationMs, t("reportNoRecord"))}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-gray-400">{t("reportRetries")} · {t("reportFailovers")}</dt>
          <dd className="mt-1 text-xs font-medium text-gray-700 dark:text-gray-200">{formatCount(detail, detail.retryCount, t("reportNoRecord"), t("reportUnreported"))} · {formatCount(detail, detail.failoverCount, t("reportNoRecord"))}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-gray-400">{t("reportEvaluations")} · {t("reportFixes")}</dt>
          <dd className="mt-1 text-xs font-medium text-gray-700 dark:text-gray-200">{formatCount(detail, detail.evaluationCount, t("reportNoRecord"))} · {formatCount(detail, detail.fixRoundCount, t("reportNoRecord"))}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-gray-400">{t("reportResult")}</dt>
          <dd className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            {hasTelemetry ? (
              <>
                <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${statusTone[detail.finalStatus]}`}>{t(`reportStatus_${detail.finalStatus}`)}</span>
                <span className="text-[10px] text-gray-400">{detail.finalVerdict ? t(`reportVerdict_${detail.finalVerdict}`) : t("reportNoVerdict")}</span>
              </>
            ) : <span className="text-gray-400">{t("reportNoRecord")}</span>}
          </dd>
        </div>
      </dl>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">{t("reportParticipants")}</h3>
          <div className="flex flex-wrap gap-1.5">
            {detail.agentRoles.length > 0 ? detail.agentRoles.map((role) => (
              <span key={role} className="rounded bg-gray-100 px-2 py-1 text-[11px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">{role}</span>
            )) : <span className="text-xs text-gray-400">{t("reportNoRecord")}</span>}
          </div>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">{t("reportProviderUsage")}</h3>
          <ProviderUsage report={detail} />
        </div>
      </div>

      <div className="mt-5">
        <h3 className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">{t("reportHistory")}</h3>
        {detail.history.length === 0 ? (
          <p className="text-xs text-gray-400">{t("reportNoHistory")}</p>
        ) : (
          <ol className="space-y-2">
            {detail.history.map((entry, index) => (
              <li key={`${entry.occurredAt}-${entry.kind}-${index}`} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-1 text-xs sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${historyTone[entry.kind]}`}>{t(`reportHistory_${entry.kind}`)}</span>
                <span className="min-w-0 break-words text-gray-600 dark:text-gray-300">{entry.summary}</span>
                <time className="col-start-2 text-[10px] text-gray-400 sm:col-start-3 sm:row-start-1">{formatDate(entry.occurredAt, i18n.language, "")}</time>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

export function GoalReports({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { goalReports, setGoalReports } = useStore();
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [status, setStatus] = useState<"all" | ReportFinalStatus>("all");
  const [provider, setProvider] = useState<"all" | AgentProvider>("all");
  const [sortKey, setSortKey] = useState<SortKey>("startedAt");
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const detailRequestRef = useRef(0);
  const detailSurfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    detailRequestRef.current += 1;
    setLoading(true);
    setListError(false);
    setDetailError(false);
    setDetail(null);
    setDetailLoadingId(null);
    api.projects.goalReports(projectId)
      .then(({ reports }) => { if (!cancelled) setGoalReports(reports); })
      .catch(() => { if (!cancelled) { setGoalReports([]); setListError(true); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, setGoalReports]);

  useEffect(() => {
    if (!detailLoadingId && !detailError && !detail) return;
    const surface = detailSurfaceRef.current;
    if (!surface) return;
    surface.focus({ preventScroll: true });
    surface.scrollIntoView({ block: "start" });
  }, [detail, detailError, detailLoadingId]);

  const visibleReports = useMemo(() => goalReports
    .filter((report) => status === "all" || (report.telemetry !== "none" && report.finalStatus === status))
    .filter((report) => provider === "all" || report.providers.some((usage) => usage.provider === provider))
    .sort((a, b) => compareReports(a, b, sortKey)), [goalReports, provider, sortKey, status]);

  const openDetail = async (goalId: string) => {
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    setDetailError(false);
    setDetail(null);
    setDetailLoadingId(goalId);
    try {
      const nextDetail = await api.goals.getExecutionReport(goalId);
      if (detailRequestRef.current === requestId) setDetail(nextDetail);
    } catch {
      if (detailRequestRef.current === requestId) {
        setDetail(null);
        setDetailError(true);
      }
    } finally {
      if (detailRequestRef.current === requestId) setDetailLoadingId(null);
    }
  };

  const closeDetail = () => {
    detailRequestRef.current += 1;
    setDetail(null);
    setDetailError(false);
    setDetailLoadingId(null);
  };

  return (
    <section aria-labelledby="goal-reports-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="goal-reports-title" className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t("reportTitle")}</h2>
          <p className="mt-1 text-xs text-gray-400">{t("reportDescription")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="text-[11px] text-gray-500">
            <span className="sr-only">{t("reportStatusFilter")}</span>
            <select value={status} onChange={(event) => { setStatus(event.target.value as typeof status); closeDetail(); }} className="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-900">
              <option value="all">{t("reportAllStatuses")}</option>
              {(["running", "completed", "failed", "interrupted"] as ReportFinalStatus[]).map((value) => <option key={value} value={value}>{t(`reportStatus_${value}`)}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-gray-500">
            <span className="sr-only">{t("reportProviderFilter")}</span>
            <select value={provider} onChange={(event) => { setProvider(event.target.value as typeof provider); closeDetail(); }} className="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-900">
              <option value="all">{t("reportAllProviders")}</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label className="text-[11px] text-gray-500">
            <span className="sr-only">{t("reportSort")}</span>
            <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)} className="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-900">
              <option value="startedAt">{t("reportSortStarted")}</option>
              <option value="durationMs">{t("reportDuration")}</option>
              <option value="providers">{t("reportProviders")}</option>
              <option value="retryCount">{t("reportRetries")}</option>
              <option value="failoverCount">{t("reportFailovers")}</option>
              <option value="evaluationCount">{t("reportEvaluations")}</option>
              <option value="fixRoundCount">{t("reportFixes")}</option>
              <option value="finalStatus">{t("reportResult")}</option>
            </select>
          </label>
        </div>
      </div>

      {loading ? (
        <div className="mt-5 space-y-2 animate-pulse" aria-label={t("loading")}><div className="h-10 rounded bg-gray-100 dark:bg-gray-800" /><div className="h-10 rounded bg-gray-100 dark:bg-gray-800" /><div className="h-10 rounded bg-gray-100 dark:bg-gray-800" /></div>
      ) : listError ? (
        <p role="alert" className="mt-4 rounded bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">{t("reportLoadError")}</p>
      ) : goalReports.length === 0 ? (
        <div className="mt-6 border-y border-gray-100 py-12 text-center dark:border-gray-800"><p className="text-sm text-gray-500">{t("reportEmpty")}</p><p className="mt-1 text-xs text-gray-400">{t("reportEmptyHint")}</p></div>
      ) : visibleReports.length === 0 ? (
        <p className="mt-6 border-y border-gray-100 py-10 text-center text-sm text-gray-400 dark:border-gray-800">{t("reportNoMatches")}</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-[960px] w-full border-collapse text-left text-xs">
            <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-400 dark:bg-gray-800/70">
              <tr><th className="px-3 py-2 font-medium">{t("goals")}</th><th className="px-3 py-2 font-medium">{t("reportDuration")}</th><th className="px-3 py-2 font-medium">{t("reportProviders")}</th><th className="px-3 py-2 text-center font-medium">{t("reportRetries")}</th><th className="px-3 py-2 text-center font-medium">{t("reportFailovers")}</th><th className="px-3 py-2 text-center font-medium">{t("reportEvaluations")}</th><th className="px-3 py-2 text-center font-medium">{t("reportFixes")}</th><th className="px-3 py-2 font-medium">{t("reportResult")}</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {visibleReports.map((report) => (
                <tr key={report.goalId} className="bg-white hover:bg-gray-50 dark:bg-[#1e1e2e] dark:hover:bg-gray-800/50">
                  <td className="max-w-[240px] px-3 py-3"><button type="button" onClick={() => void openDetail(report.goalId)} disabled={detailLoadingId === report.goalId} aria-expanded={detail?.goalId === report.goalId} aria-controls="report-detail" className="block max-w-full truncate text-left font-medium text-gray-800 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:cursor-wait disabled:opacity-60 dark:text-gray-200">{report.title}</button><span className="mt-1 block text-[10px] text-gray-400">{report.telemetry === "none" ? t("reportNoRecord") : report.telemetry === "partial" ? t("reportPartial") : t("reportComplete")}</span></td>
                  <td className="whitespace-nowrap px-3 py-3 text-gray-600 dark:text-gray-300">{formatDuration(report.durationMs, t("reportNoRecord"))}</td>
                  <td className="px-3 py-3"><ProviderUsage report={report} /></td>
                  <td className="px-3 py-3 text-center text-gray-600 dark:text-gray-300">{formatCount(report, report.retryCount, t("reportNoRecord"), t("reportUnreported"))}</td>
                  <td className="px-3 py-3 text-center text-gray-600 dark:text-gray-300">{formatCount(report, report.failoverCount, t("reportNoRecord"))}</td>
                  <td className="px-3 py-3 text-center text-gray-600 dark:text-gray-300">{formatCount(report, report.evaluationCount, t("reportNoRecord"))}</td>
                  <td className="px-3 py-3 text-center text-gray-600 dark:text-gray-300">{formatCount(report, report.fixRoundCount, t("reportNoRecord"))}</td>
                  <td className="px-3 py-3">{report.telemetry === "none" ? <span className="text-gray-400">{t("reportNoRecord")}</span> : <><span className={`rounded px-2 py-1 text-[10px] font-medium ${statusTone[report.finalStatus]}`}>{t(`reportStatus_${report.finalStatus}`)}</span><span className="ml-2 text-[10px] text-gray-400">{report.finalVerdict ? t(`reportVerdict_${report.finalVerdict}`) : t("reportNoVerdict")}</span></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(detailLoadingId || detailError || detail) && (
        <div ref={detailSurfaceRef} tabIndex={-1} className="scroll-mt-4">
          {detailLoadingId && <p role="status" aria-live="polite" className="mt-4 text-xs text-gray-400">{t("reportDetailLoading")}</p>}
          {detailError && <p role="alert" className="mt-4 text-xs text-red-600 dark:text-red-300">{t("reportDetailError")}</p>}
          {detail && <ReportDetailPanel detail={detail} onClose={closeDetail} />}
        </div>
      )}
    </section>
  );
}
