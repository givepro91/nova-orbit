import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { Toast } from "./Toast";

interface Verification {
  id: string;
  task_id: string;
  task_title?: string;
  verdict: string;
  scope: string;
  severity: string;
  dimensions: Record<string, { value: number; notes: string }>;
  issues: Array<{
    severity: string;
    file?: string;
    line?: number;
    message: string;
    suggestion?: string;
  }>;
  created_at: string;
}

interface VerificationLogProps {
  projectId: string;
}

const VERDICT_COLORS: Record<string, string> = {
  pass: "bg-green-100 text-green-700",
  conditional: "bg-yellow-100 text-yellow-700",
  fail: "bg-red-100 text-red-700",
};

const SEVERITY_COLORS: Record<string, string> = {
  "auto-resolve": "text-gray-500",
  "soft-block": "text-yellow-600",
  "hard-block": "text-red-600 font-semibold",
};

const FILTER_OPTIONS = [
  { key: "all", labelKey: "filterAll" },
  { key: "pass", labelKey: "filterPass" },
  { key: "conditional", labelKey: "filterConditional" },
  { key: "fail", labelKey: "filterFail" },
] as const;

const FILTER_CHIP_COLORS: Record<string, string> = {
  all: "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600",
  pass: "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-green-300 dark:border-green-700",
  conditional: "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 border-yellow-300 dark:border-yellow-700",
  fail: "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-300 dark:border-red-700",
};

type DateGroup = "today" | "yesterday" | "thisWeek" | "older";

function getDateGroup(dateStr: string): DateGroup {
  const now = new Date();
  const date = new Date(dateStr);
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return "thisWeek";
  return "older";
}

const DATE_GROUP_ORDER: DateGroup[] = ["today", "yesterday", "thisWeek", "older"];

const DATE_GROUP_LABEL_KEYS: Record<DateGroup, string> = {
  today: "dateGroupToday",
  yesterday: "dateGroupYesterday",
  thisWeek: "dateGroupThisWeek",
  older: "dateGroupOlder",
};

const OLDER_PAGE_SIZE = 20;

export function VerificationLog({ projectId }: VerificationLogProps) {
  const { t } = useTranslation();
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creatingFix, setCreatingFix] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [showOlder, setShowOlder] = useState(false);
  const [olderCount, setOlderCount] = useState(OLDER_PAGE_SIZE);

  useEffect(() => {
    api.verifications.list(projectId).then(setVerifications);
  }, [projectId]);

  const handleCreateFixTask = async (e: React.MouseEvent, verificationId: string) => {
    e.stopPropagation();
    setCreatingFix(verificationId);
    try {
      await api.verifications.createFixTask(verificationId);
      setToast(t("fixTaskCreated"));
    } finally {
      setCreatingFix(null);
    }
  };

  const filtered = filter === "all" ? verifications : verifications.filter((v) => v.verdict === filter);

  if (verifications.length === 0) {
    return (
      <div className="py-6 px-4 border border-dashed border-gray-200 dark:border-gray-700 rounded-lg text-center">
        <p className="text-sm text-gray-400 dark:text-gray-500">{t("noVerification")}</p>
      </div>
    );
  }

  // 날짜별 그룹화
  const grouped: Record<DateGroup, Verification[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    older: [],
  };
  filtered.forEach((v) => {
    grouped[getDateGroup(v.created_at)].push(v);
  });

  const renderVerificationItem = (v: Verification) => {
    return (
      <div key={v.id} className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-white dark:bg-[#25253d]">
        {/* Header */}
        <div className="w-full flex items-center justify-between px-4 py-3">
          <button
            onClick={() => setExpanded(expanded === v.id ? null : v.id)}
            className="flex items-center gap-3 flex-1 min-w-0 hover:opacity-80 transition-opacity text-left"
          >
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${VERDICT_COLORS[v.verdict]}`}>
              {v.verdict === "pass" ? t("verdictPass") : v.verdict === "conditional" ? t("verdictConditional") : t("verdictFail")}
            </span>
            {v.task_title && (
              <span className="text-xs text-gray-600 dark:text-gray-300 truncate min-w-0">{v.task_title}</span>
            )}
            <span className={`text-xs shrink-0 ${SEVERITY_COLORS[v.severity]}`}>
              {t(`severity_${v.severity}`, v.severity)}
            </span>
            <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">{v.scope}</span>
          </button>
          <div className="flex items-center gap-2 shrink-0">
            {(v.verdict === "fail" || v.verdict === "conditional") && (
              <button
                onClick={(e) => handleCreateFixTask(e, v.id)}
                disabled={creatingFix === v.id}
                className="text-[10px] px-2 py-0.5 rounded font-medium bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 hover:bg-orange-200 dark:hover:bg-orange-900/50 disabled:opacity-50"
              >
                {creatingFix === v.id ? "..." : t("createFixTask")}
              </button>
            )}
            <span className="text-[10px] text-gray-300 dark:text-gray-600">
              {new Date(v.created_at).toLocaleString()}
            </span>
          </div>
        </div>

        {/* Expanded Details */}
        {expanded === v.id && (
          <div className="border-t border-gray-100 dark:border-gray-700 px-4 py-3 bg-gray-50/50 dark:bg-gray-800/50">
            {/* Issues */}
            {v.issues.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
                  {t("issues")} ({v.issues.length})
                </h4>
                <div className="space-y-2">
                  {v.issues.map((issue, i) => (
                    <div
                      key={i}
                      className={`text-xs p-2 rounded border-l-2 ${
                        issue.severity === "critical"
                          ? "border-red-500 bg-red-50 dark:bg-red-900/20"
                          : issue.severity === "high"
                            ? "border-orange-400 bg-orange-50 dark:bg-orange-900/20"
                            : "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700/50"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="font-medium uppercase text-[10px]">
                          {issue.severity}
                        </span>
                        {issue.file && (
                          <span className="text-gray-400 dark:text-gray-500">
                            {issue.file}
                            {issue.line ? `:${issue.line}` : ""}
                          </span>
                        )}
                      </div>
                      <p className="text-gray-700 dark:text-gray-300">{issue.message}</p>
                      {issue.suggestion && (
                        <p className="text-gray-400 dark:text-gray-500 mt-1">Fix: {issue.suggestion}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
      {/* Filter chips */}
      <div className="flex gap-1.5 mb-3 flex-wrap">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            onClick={() => setFilter(opt.key)}
            className={`text-[11px] px-2.5 py-0.5 rounded-full border font-medium transition-colors ${
              filter === opt.key
                ? FILTER_CHIP_COLORS[opt.key]
                : "bg-transparent text-gray-400 dark:text-gray-500 border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
            }`}
          >
            {t(opt.labelKey)}
          </button>
        ))}
      </div>

      <div className="space-y-6">
        {DATE_GROUP_ORDER.map((group) => {
          const items = grouped[group];
          if (items.length === 0) return null;

          const isOlder = group === "older";
          const visibleItems = isOlder && !showOlder ? [] : isOlder ? items.slice(0, olderCount) : items;
          const hiddenOlderCount = isOlder ? items.length - visibleItems.length : 0;

          return (
            <div key={group}>
              {/* 그룹 헤더 */}
              <div className="flex items-center gap-2 mb-2">
                {isOlder ? (
                  <button
                    onClick={() => setShowOlder((v) => !v)}
                    className="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                  >
                    <svg
                      className={`w-3 h-3 transition-transform ${showOlder ? "rotate-90" : ""}`}
                      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                    {t(DATE_GROUP_LABEL_KEYS[group])}
                    <span className="text-[10px] text-gray-300 dark:text-gray-600 font-normal">({items.length})</span>
                  </button>
                ) : (
                  <>
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                      {t(DATE_GROUP_LABEL_KEYS[group])}
                    </span>
                    <span className="text-[10px] text-gray-300 dark:text-gray-600">({items.length})</span>
                  </>
                )}
              </div>

              {/* 그룹 아이템 */}
              {(!isOlder || showOlder) && (
                <div className="space-y-3">
                  {visibleItems.map(renderVerificationItem)}
                  {isOlder && hiddenOlderCount > 0 && (
                    <button
                      onClick={() => setOlderCount((n) => n + OLDER_PAGE_SIZE)}
                      className="text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                    >
                      {t("showMoreLogs", { count: hiddenOlderCount })}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
