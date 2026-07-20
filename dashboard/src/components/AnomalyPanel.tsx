import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "../lib/api";
import type { Anomaly, AnomalyReport } from "../../../shared/types";

const POLL_MS = 30_000;

/**
 * 관찰 패널 — 상태 '사이'의 모순만 띄운다.
 *
 * 원시 데이터(진행 중 목록·파일·출력)는 좌측 목록과 터미널이 원본이라, 좁은 패널에
 * 복제하면 열등한 사본이 된다. 여기서는 어느 한쪽만 보면 정상인데 둘을 나란히
 * 놓아야 드러나는 것만 보여준다.
 */
export function AnomalyPanel({
  projectId,
  onSelectGoal,
}: {
  projectId: string | null;
  onSelectGoal?: (goalId: string) => void;
}) {
  const { t } = useTranslation();
  const [report, setReport] = useState<AnomalyReport | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    if (!projectId) return undefined;
    let alive = true;
    api.projects.anomalies(projectId)
      .then((r) => { if (alive) { setReport(r); setFailed(false); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [projectId]);

  useEffect(() => {
    const cancel = load();
    const timer = setInterval(load, POLL_MS);
    return () => { cancel?.(); clearInterval(timer); };
  }, [load]);

  if (!projectId) return null;

  if (failed && !report) {
    return (
      <div className="flex flex-col items-center gap-2 p-8 text-center">
        <div className="text-xs text-muted">{t("anomalyLoadFailed")}</div>
        <button
          onClick={load}
          className="rounded border border-line bg-elevated px-2.5 py-1 text-xs text-fg hover:border-accent hover:text-accent"
        >
          {t("anomalyRetry")}
        </button>
      </div>
    );
  }

  if (!report) return <div className="p-4 text-xs text-faint">{t("loading")}</div>;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-line-soft px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-fg">
          {t("wsTabAnomaly")}
          <span
            className={
              report.anomalies.length > 0
                ? "rounded-full border border-danger/30 bg-danger-subtle px-1.5 text-[10px] font-semibold tabular-nums text-danger"
                : "rounded-full border border-line-soft bg-elevated px-1.5 text-[10px] font-semibold tabular-nums text-faint"
            }
          >
            {report.anomalies.length}
          </span>
        </div>
        <span className="text-[10px] tabular-nums text-faint">{t("anomalyCheckedJustNow")}</span>
      </div>

      {report.anomalies.length === 0 ? (
        <ClearState watched={report.watched} />
      ) : (
        <div className="flex flex-col gap-2 p-2.5">
          {report.anomalies.map((a) => (
            <SignalCard key={a.id} anomaly={a} onSelectGoal={onSelectGoal} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 빈 화면은 고장인지 정상인지 구분이 안 된다 — 무엇을 감시 중인지 밝힌다. */
function ClearState({ watched }: { watched: AnomalyReport["watched"] }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-2 px-5 py-9 text-center">
      <div className="grid h-[30px] w-[30px] place-items-center rounded-full border border-success/30 bg-success-subtle text-success">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="text-xs font-semibold text-fg">{t("anomalyClear")}</div>
      <div className="text-[10px] text-faint">
        {t("anomalyWatching", { tasks: watched.tasks, goals: watched.goals })}
      </div>
      <div className="flex flex-wrap justify-center gap-1 pt-1">
        {["anomalyWatchStalled", "anomalyWatchBlocked", "anomalyWatchUnsaved"].map((key) => (
          <span key={key} className="rounded-full border border-line-soft bg-elevated px-1.5 py-px text-[9px] text-faint">
            {t(key)}
          </span>
        ))}
      </div>
    </div>
  );
}

function SignalCard({
  anomaly,
  onSelectGoal,
}: {
  anomaly: Anomaly;
  onSelectGoal?: (goalId: string) => void;
}) {
  const { t } = useTranslation();
  const copy = signalCopy(anomaly, t);
  const age = formatAge(anomaly.ageMinutes, t);
  const canAct = !!onSelectGoal && !!anomaly.goalId;

  return (
    <div className="grid grid-cols-[3px_1fr] overflow-hidden rounded-md border border-line-soft bg-surface">
      <div className={anomaly.severity === "critical" ? "bg-danger" : "bg-warning"} />
      <div className="flex min-w-0 flex-col gap-[7px] px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <div className="min-w-0 flex-1 text-xs font-semibold text-fg">{copy.title}</div>
          {age && <div className="shrink-0 text-[10px] tabular-nums text-faint">{age}</div>}
        </div>

        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
          <span className="shrink-0 rounded border border-line-soft bg-elevated px-1 text-[9px] tracking-wide text-faint">
            {t(anomaly.targetType === "goal" ? "anomalyTargetGoal" : "anomalyTargetTask")}
          </span>
          <span className="truncate">{anomaly.targetTitle}</span>
        </div>

        {/* 모순의 양쪽 — 어느 한쪽만 보면 정상이라 나란히 놓아야 문제가 보인다 */}
        <div className="flex items-center gap-1.5 text-[11px] tabular-nums">
          <span className="flex shrink-0 items-center gap-1 text-warning">
            <span className="h-1.5 w-1.5 rounded-full bg-warning" />
            {copy.left}
          </span>
          <span className="text-[10px] text-faint">↔</span>
          <span className="flex shrink-0 items-center gap-1 text-danger">
            <span className="h-1.5 w-1.5 rounded-full bg-danger" />
            {copy.right}
          </span>
        </div>

        <div className="text-[10.5px] leading-relaxed text-faint">{copy.detail}</div>

        {canAct && (
          <div className="flex gap-1.5">
            <button
              onClick={() => onSelectGoal?.(anomaly.goalId!)}
              className="rounded border border-accent bg-accent px-2 py-0.5 text-[11px] font-medium text-on-accent hover:opacity-90"
            >
              {copy.action}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 서버는 구조화된 facts 만 주고 문구는 여기서 조립한다(i18n). */
function signalCopy(a: Anomaly, t: TFunction): {
  title: string; left: string; right: string; detail: string; action: string;
} {
  switch (a.kind) {
    case "apply_blocked":
      return {
        title: t("anomalyBlockedTitle"),
        left: t("anomalyBlockedLeft", { done: a.facts.doneCount, total: a.facts.totalCount }),
        right: t("anomalyBlockedRight"),
        detail: t("anomalyBlockedDetail"),
        action: t("anomalyBlockedAction"),
      };
    case "unsaved_changes":
      return {
        title: t("anomalyUnsavedTitle"),
        left: t("anomalyUnsavedLeft"),
        right: t("anomalyUnsavedRight"),
        detail: t("anomalyUnsavedDetail"),
        action: t("anomalyUnsavedAction"),
      };
    case "stalled_task":
    default: {
      const time = String(a.facts.lastChangeAt ?? "").slice(11, 16);
      const assignee = String(a.facts.assignee ?? "");
      return {
        title: t("anomalyStalledTitle"),
        left: t("anomalyStalledLeft"),
        right: t("anomalyStalledRight"),
        detail: assignee
          ? t("anomalyStalledDetailWith", { assignee, time })
          : t("anomalyStalledDetail", { time }),
        action: t("anomalyStalledAction"),
      };
    }
  }
}

/** 경과는 서버가 분으로 계산해 준다 — 클라이언트 타임존 해석을 타지 않는다. */
function formatAge(minutes: number | null, t: TFunction): string | null {
  if (minutes === null) return null;
  if (minutes >= 60) return t("anomalyAgeHours", { value: (minutes / 60).toFixed(1) });
  return t("anomalyAgeMinutes", { value: minutes });
}
