import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AnomalyPanel } from "./AnomalyPanel";
import { DiffPane } from "./DiffPane";
import { GoalDetail } from "./GoalDetail";

type WsTab = "anomaly" | "diff" | "verdict";

/**
 * 세션 워크스페이스 우측 인스펙터 — 이상 / 변경 / 판정.
 *
 * 한때 6탭이었으나 Crewdeck(좌측 목록과 중복)·최근출력·실시간(가운데 터미널과 중복)·
 * 작업공간(파일 나열)을 걷어냈다. 데이터 소스마다 탭을 하나씩 두는 구성이었던 탓에,
 * 각 탭이 원본을 더 잘 보여주는 면의 열등한 사본이 되어 아무도 보지 않았다.
 * 기본 탭은 '이상' — 이 패널의 값어치는 원시 상태 복제가 아니라 상태 사이의 모순 검출이다.
 */
export function InspectorTabs({
  goalId,
  workspaceId,
  projectId,
  onSelectGoal,
}: {
  goalId: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  onSelectGoal?: (goalId: string) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<WsTab>("anomaly");

  const tabs: { id: WsTab; label: string }[] = [
    { id: "anomaly", label: t("wsTabAnomaly") },
    { id: "diff", label: t("wsTabDiff") },
    { id: "verdict", label: t("wsTabVerdict") },
  ];

  const missingContext = tab === "verdict"
    ? !goalId
    : tab === "diff" && !goalId && !workspaceId;

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-line-soft shrink-0 overflow-x-auto">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`shrink-0 whitespace-nowrap px-2.5 py-2 text-xs font-medium ${
              tab === tb.id
                ? "text-accent border-b-2 border-accent"
                : "text-muted hover:text-muted"
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto min-h-0">
        {missingContext ? (
          <div className="p-4 text-xs text-faint">{t("wsNoGoal")}</div>
        ) : tab === "anomaly" ? (
          <AnomalyPanel projectId={projectId ?? null} onSelectGoal={onSelectGoal} />
        ) : tab === "diff" ? (
          <DiffPane goalId={goalId} workspaceId={workspaceId} />
        ) : (
          <GoalDetail goalId={goalId!} autoLoad className="p-2" />
        )}
      </div>
    </div>
  );
}
