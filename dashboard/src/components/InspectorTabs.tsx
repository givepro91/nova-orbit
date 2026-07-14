import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { DiffPane } from "./DiffPane";
import { GoalDetail } from "./GoalDetail";
import { LiveActivity } from "./LiveActivity";
import { SessionView } from "./SessionView";

type WsTab = "diff" | "output" | "workspace" | "verdict" | "live";

/**
 * 세션 워크스페이스 우측 인스펙터 — Diff / 최근출력 / 작업공간 / 판정 / 실시간 5탭.
 * 순수 표시(REST 조회 → render). Diff·작업공간·판정은 goalId 기반, 최근출력·실시간은 agentId 기반.
 */
export function InspectorTabs({ goalId, agentId }: { goalId: string | null; agentId: string }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<WsTab>("diff");

  const tabs: { id: WsTab; label: string }[] = [
    { id: "diff", label: t("wsTabDiff") },
    { id: "output", label: t("wsTabOutput") },
    { id: "live", label: t("wsTabLive") },
    { id: "workspace", label: t("wsTabWorkspace") },
    { id: "verdict", label: t("wsTabVerdict") },
  ];

  const needsGoal = tab === "diff" || tab === "workspace" || tab === "verdict";

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-line-soft shrink-0">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`px-3 py-2 text-xs font-medium ${
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
        {needsGoal && !goalId ? (
          <div className="p-4 text-xs text-faint">{t("wsNoGoal")}</div>
        ) : tab === "diff" ? (
          <DiffPane goalId={goalId!} />
        ) : tab === "output" ? (
          <LiveActivity agentId={agentId} />
        ) : tab === "live" ? (
          <SessionView agentId={agentId} goalId={goalId} />
        ) : tab === "workspace" ? (
          <WorkspaceFiles goalId={goalId!} />
        ) : (
          <GoalDetail goalId={goalId!} autoLoad className="p-2" />
        )}
      </div>
    </div>
  );
}

/** 작업 공간 탭 — worktree 파일 목록(평면). */
function WorkspaceFiles({ goalId }: { goalId: string }) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.goals
      .getFiles(goalId)
      .then((r) => { if (alive) setFiles(r.files); })
      .catch(() => { if (alive) setFiles([]); });
    return () => { alive = false; };
  }, [goalId]);
  if (files === null) return <div className="p-4 text-xs text-faint">{t("loading")}</div>;
  if (files.length === 0) return <div className="p-4 text-xs text-faint">{t("wsNoFiles")}</div>;
  return (
    <div className="text-xs font-mono p-2">
      {files.map((f) => (
        <div key={f} className="px-2 py-0.5 text-muted hover:bg-fg/5 truncate">
          {f}
        </div>
      ))}
    </div>
  );
}
