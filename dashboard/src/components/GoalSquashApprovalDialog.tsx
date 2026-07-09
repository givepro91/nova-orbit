import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type WorkReport } from "../lib/api";

interface GoalSquashApprovalDialogProps {
  goal: {
    id: string;
    title: string;
    worktree_branch: string | null;
    acceptance_script: string | null;
  };
  commitMessage?: string;
  filesChanged?: string[];
  acceptanceOutput?: string;
  workReport?: WorkReport | null;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  isApproving: boolean;
}

export function GoalSquashApprovalDialog({
  goal,
  commitMessage,
  filesChanged,
  acceptanceOutput,
  workReport,
  onConfirm,
  onCancel,
  isApproving,
}: GoalSquashApprovalDialogProps) {
  const { t } = useTranslation();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isApproving) onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isApproving, onCancel]);

  // 스크린샷: <img>가 Bearer를 못 실으므로 인증 fetch → blob objectURL, 언마운트 시 revoke
  const [shotUrls, setShotUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!workReport?.screenshots?.length) return;
    const created: string[] = [];
    let alive = true;
    (async () => {
      for (const s of workReport.screenshots) {
        try {
          const u = await api.goals.fetchArtifact(goal.id, s.file);
          if (!alive) { URL.revokeObjectURL(u); return; }
          created.push(u);
          setShotUrls((prev) => ({ ...prev, [s.file]: u }));
        } catch { /* skip one */ }
      }
    })();
    return () => { alive = false; created.forEach(URL.revokeObjectURL); };
  }, [workReport, goal.id]);

  return (
    <div
      className="fixed inset-0 bg-black/30 dark:bg-black/60 flex items-center justify-center z-50"
      onClick={isApproving ? undefined : onCancel}
    >
      <div
        className="bg-white dark:bg-[#25253d] rounded-xl shadow-xl w-[560px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-700 shrink-0">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {t("goalSquashDialogTitle")}
          </h3>
          <button
            onClick={onCancel}
            disabled={isApproving}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:opacity-40 transition-colors"
            aria-label="닫기"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t("goalSquashDialogDesc")}
          </p>

          {/* 목표 제목 */}
          <div>
            <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider block mb-1">
              {t("goalSquashDialogGoalLabel")}
            </span>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{goal.title}</p>
          </div>

          {/* 반영 브랜치 */}
          {goal.worktree_branch && (
            <div>
              <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider block mb-1">
                {t("goalSquashDialogBranch")}
              </span>
              <code className="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded font-mono text-gray-700 dark:text-gray-300">
                {goal.worktree_branch}
              </code>
            </div>
          )}

          {/* 커밋 메시지 프리뷰 */}
          {commitMessage && (
            <div>
              <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider block mb-1">
                {t("goalSquashDialogCommitMsg")}
              </span>
              <pre className="text-xs px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg whitespace-pre-wrap break-all font-mono text-gray-700 dark:text-gray-300 max-h-28 overflow-y-auto">
                {commitMessage}
              </pre>
            </div>
          )}

          {/* 변경 파일 */}
          {filesChanged && filesChanged.length > 0 && (
            <div>
              <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider block mb-1">
                {t("goalSquashDialogFilesChanged")} ({filesChanged.length})
              </span>
              <ul className="space-y-0.5 max-h-32 overflow-y-auto">
                {filesChanged.map((file, i) => (
                  <li key={i} className="text-xs text-gray-600 dark:text-gray-400 font-mono flex items-center gap-1.5">
                    <span className="w-1 h-1 rounded-full bg-blue-400 shrink-0" />
                    {file}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 검증 결과 */}
          {acceptanceOutput && (
            <div>
              <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider block mb-1">
                {t("goalSquashDialogAcceptance")}
              </span>
              <pre className="text-xs px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg whitespace-pre-wrap break-all font-mono text-gray-700 dark:text-gray-300 max-h-32 overflow-y-auto">
                {acceptanceOutput}
              </pre>
            </div>
          )}

          {/* 작업 요약 (before/after 서사 + 스크린샷) */}
          {workReport && (
            <div>
              <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider block mb-1">
                {t("goalSquashDialogWorkReport")}
              </span>
              {workReport.summaryStatus === "ready" ? (
                <div className="space-y-2 text-xs text-gray-700 dark:text-gray-300">
                  {([
                    ["goalSquashDialogBefore", workReport.before],
                    ["goalSquashDialogChanged", workReport.changed],
                    ["goalSquashDialogAfter", workReport.after],
                    ["goalSquashDialogNotes", workReport.notes],
                  ] as [string, string | null][])
                    .filter(([, v]) => v && v.trim())
                    .map(([k, v]) => (
                      <div key={k}>
                        <span className="font-semibold text-gray-500 dark:text-gray-400">{t(k)}</span>
                        <p className="mt-0.5 whitespace-pre-wrap leading-relaxed">{v}</p>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="text-xs text-gray-400 dark:text-gray-500 italic">
                  {workReport.summaryStatus === "failed" ? t("goalSquashDialogSummaryFailed") : t("goalSquashDialogSummaryPending")}
                </p>
              )}

              {workReport.screenshots.length > 0 && (
                <div className="mt-3">
                  <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider block mb-1">
                    {t("goalSquashDialogScreenshots")} ({workReport.screenshots.length})
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    {workReport.screenshots.map((s) =>
                      shotUrls[s.file] ? (
                        <a key={s.file} href={shotUrls[s.file]} target="_blank" rel="noreferrer">
                          <img src={shotUrls[s.file]} alt={s.label} className="w-full h-auto rounded border border-gray-200 dark:border-gray-700" />
                        </a>
                      ) : (
                        <div key={s.file} className="aspect-video rounded bg-gray-100 dark:bg-gray-800 animate-pulse" />
                      ),
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-100 dark:border-gray-700 shrink-0">
          <button
            onClick={onCancel}
            disabled={isApproving}
            className="text-xs px-4 py-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-40 transition-colors"
          >
            {t("cancel")}
          </button>
          <button
            onClick={onConfirm}
            disabled={isApproving}
            className="text-xs px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {isApproving ? (
              <>
                <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                {t("goalSquashApproving")}
              </>
            ) : (
              t("goalSquashDialogConfirmBtn")
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
