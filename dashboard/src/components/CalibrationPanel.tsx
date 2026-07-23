import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import type { CalibrationStats } from "../../../shared/types";

interface CalibrationPanelProps {
  projectId: string;
}

const TOP_CAUSE_COUNT = 3;

export function CalibrationPanel({ projectId }: CalibrationPanelProps) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<CalibrationStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.verifications
        .calibration(projectId)
        // 조회 실패 시 패널을 숨긴다 — 검증 로그 자체는 계속 보여야 하므로 화면을 막지 않는다.
        .then((data) => { if (!cancelled) setStats(data); })
        .catch(() => { if (!cancelled) setStats(null); });
    };
    load();
    // 라벨이 붙으면 집계를 다시 받는다 — 재라벨은 버킷 간 이동이라 이벤트만으로는 계산할 수 없다.
    window.addEventListener("crewdeck:verification-labeled", load);
    return () => {
      cancelled = true;
      window.removeEventListener("crewdeck:verification-labeled", load);
    };
  }, [projectId]);

  if (!stats) return null;

  const { failRate, failRateDelta, baselineFailRate, labels } = stats;
  const topCauses = stats.causes.slice(0, TOP_CAUSE_COUNT);

  const header = (
    <div className="px-4 py-2.5 bg-sunken border-b border-line flex items-center justify-between">
      <h2 className="text-xs font-medium text-muted">{t("calibrationTitle")}</h2>
      <span className="text-[10px] text-faint">{t("calibrationSample", { n: stats.total })}</span>
    </div>
  );

  // 검증 0건이면 실패율·델타가 모두 null이라 계산할 게 없다.
  if (stats.total === 0 || failRate === null) {
    return (
      <div className="border border-line rounded-xl overflow-hidden mb-4">
        {header}
        <p className="px-4 py-3 text-xs text-faint">{t("calibrationEmpty")}</p>
      </div>
    );
  }

  const deltaColor =
    failRateDelta === null || failRateDelta === 0
      ? "text-faint"
      : failRateDelta > 0
        ? "text-danger"
        : "text-success";

  return (
    <div className="border border-line rounded-xl overflow-hidden mb-4">
      {header}
      <div className="px-4 py-3 space-y-3">
        {/* 현재 실패율 + 기준선 대비 델타 */}
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-xs text-muted">{t("calibrationFailRate")}</span>
          <span className="text-lg font-semibold text-fg tabular-nums">{failRate}%</span>
          <span className={`text-[11px] ${deltaColor}`}>
            {failRateDelta === null || failRateDelta === 0
              ? t("calibrationSameAsBaseline", { baseline: baselineFailRate })
              : t("calibrationBaselineDelta", {
                  baseline: baselineFailRate,
                  delta: `${failRateDelta > 0 ? "+" : ""}${failRateDelta}`,
                })}
          </span>
        </div>

        {/* 상위 실패 원인 3개 */}
        <div>
          <h3 className="text-[11px] font-medium text-muted mb-1.5">{t("calibrationTopCauses")}</h3>
          {topCauses.length === 0 ? (
            <p className="text-xs text-faint">{t("calibrationNoCauses")}</p>
          ) : (
            <div className="space-y-1">
              {topCauses.map((cause) => (
                <div key={cause.category} className="flex items-center gap-2">
                  <span className="text-xs text-muted flex-1 truncate">
                    {t(`failCause_${cause.category}`, cause.category)}
                  </span>
                  <span className="text-xs text-fg tabular-nums shrink-0">
                    {t("calibrationCauseCount", { n: cause.count })}
                  </span>
                  <span className="text-[10px] text-faint tabular-nums shrink-0 w-9 text-right">
                    {Math.round(cause.ratio * 100)}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 사람 검토 라벨 집계 */}
        <div>
          <h3 className="text-[11px] font-medium text-muted mb-1.5">{t("calibrationHumanReview")}</h3>
          {labels.total === 0 ? (
            <p className="text-xs text-faint">{t("calibrationNoLabels")}</p>
          ) : (
            <div className="flex gap-1.5 flex-wrap">
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-warning-subtle text-warning">
                {t("calibrationFalsePositive")} {labels.falsePositive}
              </span>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-danger-subtle text-danger">
                {t("calibrationFalseNegative")} {labels.falseNegative}
              </span>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-success-subtle text-success">
                {t("calibrationCorrect")} {labels.correct}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
