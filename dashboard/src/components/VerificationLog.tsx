import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import type { VerificationLabelRow } from "../lib/api";
import type { VerificationLabelValue } from "../../../shared/types";
import { InputDialog } from "./InputDialog";
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
  /** 사람 라벨 (GET /verifications의 LEFT JOIN) — 없으면 null. */
  label?: VerificationLabelValue | null;
  label_note?: string | null;
}

/** 행에 붙은 사람 라벨의 화면 표시분. */
interface RowLabel {
  label: VerificationLabelValue;
  note: string | null;
}

interface VerificationLogProps {
  projectId: string;
}

const VERDICT_COLORS: Record<string, string> = {
  pass: "bg-success-subtle text-success",
  conditional: "bg-warning-subtle text-warning",
  fail: "bg-danger-subtle text-danger",
};

const SEVERITY_COLORS: Record<string, string> = {
  "auto-resolve": "text-muted",
  "soft-block": "text-warning",
  "hard-block": "text-danger font-semibold",
};

const FILTER_OPTIONS = [
  { key: "all", labelKey: "filterAll" },
  { key: "pass", labelKey: "filterPass" },
  { key: "conditional", labelKey: "filterConditional" },
  { key: "fail", labelKey: "filterFail" },
] as const;

const FILTER_CHIP_COLORS: Record<string, string> = {
  all: "bg-sunken text-muted border-line",
  pass: "bg-success-subtle text-success border-success",
  conditional: "bg-warning-subtle text-warning border-warning",
  fail: "bg-danger-subtle text-danger border-danger",
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

/**
 * 판정별로 사람이 지적할 수 있는 오류는 하나뿐이다 — fail은 "통과했어야 함"(오탐),
 * pass는 "문제가 있는데 통과"(미탐). conditional은 어느 쪽도 아니라 라벨 대상이 아니다.
 */
const LABEL_ACTION: Record<string, VerificationLabelValue | undefined> = {
  fail: "false_positive",
  pass: "false_negative",
};

const LABEL_TEXT_KEYS: Record<VerificationLabelValue, string> = {
  false_positive: "calibrationFalsePositive",
  false_negative: "calibrationFalseNegative",
  correct: "calibrationCorrect",
};

const LABEL_CHIP_COLORS: Record<VerificationLabelValue, string> = {
  false_positive: "bg-warning-subtle text-warning",
  false_negative: "bg-danger-subtle text-danger",
  correct: "bg-success-subtle text-success",
};

function collectLabels(rows: Verification[]): Record<string, RowLabel> {
  const seeded: Record<string, RowLabel> = {};
  rows.forEach((v) => {
    if (v.label) seeded[v.id] = { label: v.label, note: v.label_note ?? null };
  });
  return seeded;
}

export function VerificationLog({ projectId }: VerificationLogProps) {
  const { t } = useTranslation();
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creatingFix, setCreatingFix] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [showOlder, setShowOlder] = useState(false);
  const [olderCount, setOlderCount] = useState(OLDER_PAGE_SIZE);
  const [labels, setLabels] = useState<Record<string, RowLabel>>({});
  const [labelTarget, setLabelTarget] = useState<{ id: string; label: VerificationLabelValue } | null>(null);
  const [savingLabel, setSavingLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.verifications.list(projectId).then((data) => {
        if (cancelled) return;
        setVerifications(data);
        // 서버 값이 이기되, 조회 중 도착한 라벨 이벤트는 잃지 않는다.
        setLabels((prev) => ({ ...prev, ...collectLabels(data) }));
      });
    };
    load();
    // verification:result 발행 시 즉시 재조회 — 새 판정(특히 실패)이 실시간으로 나타난다.
    // mount 1회 조회만으로는 판정이 생겨도 화면에 반영되지 않던 버그를 고친다.
    window.addEventListener("crewdeck:verification-result", load);
    return () => {
      cancelled = true;
      window.removeEventListener("crewdeck:verification-result", load);
    };
  }, [projectId]);

  // 라벨은 해당 행에만 영향을 주므로 목록 재조회 없이 상태만 갱신한다(다른 창에서 라벨해도 반영).
  useEffect(() => {
    const onLabeled = (e: Event) => {
      const row = (e as CustomEvent<VerificationLabelRow>).detail;
      if (!row?.verification_id) return;
      setLabels((prev) => ({ ...prev, [row.verification_id]: { label: row.label, note: row.note } }));
    };
    window.addEventListener("crewdeck:verification-labeled", onLabeled);
    return () => window.removeEventListener("crewdeck:verification-labeled", onLabeled);
  }, []);

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

  const handleLabelSubmit = async (note: string) => {
    if (!labelTarget) return;
    const { id, label } = labelTarget;
    setLabelTarget(null);
    setSavingLabel(id);
    try {
      const row = await api.verifications.label(id, { label, note });
      setLabels((prev) => ({ ...prev, [id]: { label: row.label, note: row.note } }));
      setToast(t("verificationLabelSaved"));
    } finally {
      setSavingLabel(null);
    }
  };

  const filtered = filter === "all" ? verifications : verifications.filter((v) => v.verdict === filter);

  if (verifications.length === 0) {
    return (
      <div className="py-6 px-4 border border-dashed border-line rounded-lg text-center">
        <p className="text-sm text-faint">{t("noVerification")}</p>
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
    const rowLabel = labels[v.id];
    const labelAction = LABEL_ACTION[v.verdict];
    return (
      <div key={v.id} className="border border-line rounded-lg overflow-hidden bg-surface">
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
              <span className="text-xs text-muted truncate min-w-0">{v.task_title}</span>
            )}
            <span className={`text-xs shrink-0 ${SEVERITY_COLORS[v.severity]}`}>
              {t(`severity_${v.severity}`, v.severity)}
            </span>
            <span className="text-xs text-faint shrink-0">{v.scope}</span>
          </button>
          <div className="flex items-center gap-2 shrink-0">
            {(v.verdict === "fail" || v.verdict === "conditional") && (
              <button
                onClick={(e) => handleCreateFixTask(e, v.id)}
                disabled={creatingFix === v.id}
                className="text-[10px] px-2 py-0.5 rounded font-medium bg-warning-subtle text-warning hover:bg-fg/10 disabled:opacity-50"
              >
                {creatingFix === v.id ? "..." : t("createFixTask")}
              </button>
            )}
            {/* 라벨 컨트롤 — 미라벨이면 지적 버튼, 라벨 후에는 현재 라벨 칩(다시 눌러 사유 수정). */}
            {(rowLabel || labelAction) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const next = rowLabel?.label ?? labelAction;
                  if (next) setLabelTarget({ id: v.id, label: next });
                }}
                disabled={savingLabel === v.id}
                title={rowLabel?.note ?? undefined}
                className={`text-[10px] px-2 py-0.5 rounded-full font-medium max-w-[180px] truncate disabled:opacity-50 ${
                  rowLabel
                    ? LABEL_CHIP_COLORS[rowLabel.label]
                    : "border border-line text-faint hover:text-muted"
                }`}
              >
                {savingLabel === v.id ? "..." : t(LABEL_TEXT_KEYS[rowLabel?.label ?? labelAction!])}
              </button>
            )}
            <span className="text-[10px] text-faint">
              {new Date(v.created_at).toLocaleString()}
            </span>
          </div>
        </div>

        {/* Expanded Details */}
        {expanded === v.id && (
          <div className="border-t border-line-soft px-4 py-3 bg-sunken">
            {/* Issues */}
            {v.issues.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-muted mb-2">
                  {t("issues")} ({v.issues.length})
                </h4>
                <div className="space-y-2">
                  {v.issues.map((issue, i) => (
                    <div
                      key={i}
                      className={`text-xs p-2 rounded border-l-2 ${
                        issue.severity === "critical"
                          ? "border-danger bg-danger-subtle"
                          : issue.severity === "high"
                            ? "border-warning bg-warning-subtle"
                            : "border-line bg-surface"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="font-medium uppercase text-[10px]">
                          {issue.severity}
                        </span>
                        {issue.file && (
                          <span className="text-faint">
                            {issue.file}
                            {issue.line ? `:${issue.line}` : ""}
                          </span>
                        )}
                      </div>
                      <p className="text-muted">{issue.message}</p>
                      {issue.suggestion && (
                        <p className="text-faint mt-1">Fix: {issue.suggestion}</p>
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
      {labelTarget && (
        <InputDialog
          title={t("verificationLabelReason", { label: t(LABEL_TEXT_KEYS[labelTarget.label]) })}
          placeholder={t("verificationLabelReasonPlaceholder")}
          defaultValue={labels[labelTarget.id]?.note ?? ""}
          onSubmit={handleLabelSubmit}
          onCancel={() => setLabelTarget(null)}
        />
      )}
      {/* Filter chips */}
      <div className="flex gap-1.5 mb-3 flex-wrap">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            onClick={() => setFilter(opt.key)}
            className={`text-[11px] px-2.5 py-0.5 rounded-full border font-medium transition-colors ${
              filter === opt.key
                ? FILTER_CHIP_COLORS[opt.key]
                : "bg-transparent text-faint border-line hover:border-line"
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
                    className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-fg transition-colors"
                  >
                    <svg
                      className={`w-3 h-3 transition-transform ${showOlder ? "rotate-90" : ""}`}
                      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                    {t(DATE_GROUP_LABEL_KEYS[group])}
                    <span className="text-[10px] text-faint font-normal">({items.length})</span>
                  </button>
                ) : (
                  <>
                    <span className="text-xs font-medium text-muted">
                      {t(DATE_GROUP_LABEL_KEYS[group])}
                    </span>
                    <span className="text-[10px] text-faint">({items.length})</span>
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
                      className="text-[11px] text-faint hover:text-muted transition-colors"
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
