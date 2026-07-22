import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type WorkReport, type VerificationTimelineIssue } from "../lib/api";
import { DiffPane } from "./DiffPane";

/** 캡처 파일명 규약(<slug>-before/after.png)에서 전·후 구분을 읽는다. 규약 밖 파일은 null. */
function shotPhase(file: string): "before" | "after" | null {
  if (/(^|[-_])before\.(png|jpe?g)$/i.test(file)) return "before";
  if (/(^|[-_])after\.(png|jpe?g)$/i.test(file)) return "after";
  return null;
}

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
  /** 자동 건너뜀(skipped) 태스크 — 승인자가 "무엇이 빠진 채 반영되는지" 봐야 하는 degraded 신호. */
  skippedTasks?: Array<{ id: string; title: string; skip_reason?: string | null }>;
  /** ③ 화면 증거 맥락 — goal 태스크들이 선언한 사용자 노출 URL (칩으로 표시). */
  affectedUrls?: string[];
  // 사용자가 본문을 직접 편집한 경우에만 그 문자열을 넘긴다. 편집하지 않았으면 undefined —
  // 서버가 승인 시점의 fresh work_report(비동기로 뒤늦게 채워진 서사 포함)로 재생성한다.
  onConfirm: (commitMessage?: string) => Promise<void>;
  onCancel: () => void;
  isApproving: boolean;
}

export function GoalSquashApprovalDialog({
  goal,
  commitMessage,
  filesChanged,
  acceptanceOutput,
  workReport,
  skippedTasks,
  affectedUrls,
  onConfirm,
  onCancel,
  isApproving,
}: GoalSquashApprovalDialogProps) {
  const { t } = useTranslation();

  // 커밋/PR 본문 편집본. 프리뷰(commitMessage)가 비동기로 도착하므로, 사용자가 아직
  // 손대지 않았을 때(!dirty)만 최신 프리뷰로 시드한다. 편집한 뒤에는 덮어쓰지 않는다.
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty && commitMessage) setDraft(commitMessage);
  }, [commitMessage, dirty]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isApproving) onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isApproving, onCancel]);

  // 스크린샷: <img>가 Bearer를 못 실으므로 인증 fetch → blob objectURL, 언마운트 시 revoke.
  // deps는 파일셋 시그니처 — 비동기 서사(pending→ready)만 갱신될 땐 재fetch/flicker 없음.
  const [shotUrls, setShotUrls] = useState<Record<string, string>>({});
  const shotSig = (workReport?.screenshots ?? []).map((s) => s.file).join("|");
  useEffect(() => {
    const shots = workReport?.screenshots ?? [];
    if (!shots.length) return;
    const created: string[] = [];
    let alive = true;
    (async () => {
      for (const s of shots) {
        try {
          const u = await api.goals.fetchArtifact(goal.id, s.file);
          if (!alive) { URL.revokeObjectURL(u); return; }
          created.push(u);
          setShotUrls((prev) => ({ ...prev, [s.file]: u }));
        } catch { /* skip one */ }
      }
    })();
    return () => { alive = false; created.forEach(URL.revokeObjectURL); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotSig, goal.id]);

  // 품질 게이트 — 태스크별 **최신** verdict만 집계한다. 과거 fix 라운드의 fail까지 누적하면
  // 이미 고쳐진 결함이 승인 화면에 실패로 남아 오도된다 (커밋 메시지 집계와 같은 원칙).
  const [gate, setGate] = useState<{ counts: Record<string, number>; issues: VerificationTimelineIssue[] } | null>(null);
  useEffect(() => {
    let alive = true;
    api.goals
      .getVerificationTimeline(goal.id)
      .then((tl) => {
        if (!alive || !tl?.rounds) return;
        const latestByTask = new Map<string, (typeof tl.rounds)[number]>();
        for (const r of tl.rounds) {
          const prev = latestByTask.get(r.task_id);
          if (!prev || r.round >= prev.round) latestByTask.set(r.task_id, r);
        }
        const counts: Record<string, number> = {};
        const issues: VerificationTimelineIssue[] = [];
        for (const r of latestByTask.values()) {
          counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
          if (r.verdict !== "pass") issues.push(...(r.issues ?? []));
        }
        setGate({ counts, issues });
      })
      .catch(() => { /* 게이트 정보가 없어도 승인 자체는 가능 */ });
    return () => { alive = false; };
  }, [goal.id]);

  // diff는 열었을 때만 가져온다 — <details> 안에 그냥 두면 접혀 있어도 자식이 마운트돼
  // 매번 diff를 내려받는다(접힘의 의미가 없어짐).
  const [diffOpen, setDiffOpen] = useState(false);

  const impact = workReport?.userImpact;
  const outOfScope = (workReport?.outOfScope ?? "").trim();
  const gateIssues = gate?.issues ?? [];
  const narrativeReady = workReport?.summaryStatus === "ready";

  return (
    <div
      className="fixed inset-0 bg-black/30 dark:bg-black/60 flex items-center justify-center z-50"
      onClick={isApproving ? undefined : onCancel}
    >
      <div
        className="bg-surface rounded-xl shadow-xl w-[560px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-soft shrink-0">
          <h3 className="text-sm font-semibold text-fg">
            {t("goalSquashDialogTitle")}
          </h3>
          <button
            onClick={onCancel}
            disabled={isApproving}
            className="text-faint hover:text-muted disabled:opacity-40 transition-colors"
            aria-label="닫기"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
          <p className="text-xs text-muted">
            {t("goalSquashDialogDesc")}
          </p>

          {/* 목표 제목 */}
          <div>
            <span className="text-[11px] font-medium text-faint uppercase tracking-wider block mb-1">
              {t("goalSquashDialogGoalLabel")}
            </span>
            <p className="text-sm font-medium text-fg">{goal.title}</p>
          </div>

          {/* 반영 브랜치 */}
          {goal.worktree_branch && (
            <div>
              <span className="text-[11px] font-medium text-faint uppercase tracking-wider block mb-1">
                {t("goalSquashDialogBranch")}
              </span>
              <code className="text-xs px-2 py-1 bg-sunken rounded font-mono text-muted">
                {goal.worktree_branch}
              </code>
            </div>
          )}

          {/* 작업 요약 (before/after 서사) — 판단의 1차 화면. */}
          {workReport && (
            <div>
              <span className="text-[11px] font-medium text-faint uppercase tracking-wider block mb-1">
                {t("goalSquashDialogWorkReport")}
              </span>
              {narrativeReady ? (
                <div className="space-y-2 text-xs text-muted">
                  {([
                    ["goalSquashDialogBefore", workReport.before],
                    ["goalSquashDialogChanged", workReport.changed],
                    ["goalSquashDialogAfter", workReport.after],
                    ["goalSquashDialogNotes", workReport.notes],
                  ] as [string, string | null][])
                    .filter(([, v]) => v && v.trim())
                    .map(([k, v]) => (
                      <div key={k}>
                        <span className="font-semibold text-muted">{t(k)}</span>
                        <p className="mt-0.5 whitespace-pre-wrap leading-relaxed">{v}</p>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="text-xs text-faint italic">
                  {workReport.summaryStatus === "failed" ? t("goalSquashDialogSummaryFailed") : t("goalSquashDialogSummaryPending")}
                </p>
              )}
            </div>
          )}

          {/* 사용자가 보게 될 차이 — 서사를 화면·인터페이스 단위로 구체화. 스크린샷은 이 블록의
              증거이므로 여기 붙인다(어느 화면의 캡처인지는 알 수 없어 항목별로 묶지는 않는다). */}
          {(impact || (workReport?.screenshots.length ?? 0) > 0 || (affectedUrls?.length ?? 0) > 0) && (
            <div>
              <span className="text-[11px] font-medium text-faint uppercase tracking-wider block mb-1">
                {t("goalSquashDialogUserImpact")}
              </span>
              {(affectedUrls?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {(affectedUrls ?? []).map((u) => (
                    <span key={u} className="text-[11px] px-2 py-0.5 bg-sunken border border-line-soft rounded font-mono text-muted">
                      {u}
                    </span>
                  ))}
                </div>
              )}
              {impact && !impact.visible && (
                <p className="text-xs text-muted px-2.5 py-2 bg-sunken border border-line-soft rounded-lg">
                  {t("goalSquashDialogNoUserImpact")}
                </p>
              )}
              {impact && impact.visible && (
                <ul className="space-y-1.5">
                  {impact.surfaces.map((s, i) => (
                    <li key={i} className="px-2.5 py-2 bg-sunken border border-line-soft rounded-lg grid grid-cols-[minmax(0,34%)_minmax(0,1fr)] gap-2.5">
                      <span className="text-xs font-medium text-fg break-words">{s.name}</span>
                      <span className="text-xs text-muted leading-relaxed">{s.change}</span>
                    </li>
                  ))}
                </ul>
              )}

              {workReport && workReport.screenshots.length > 0 && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {workReport.screenshots.map((s) => {
                    const url = shotUrls[s.file];
                    if (!url) return <div key={s.file} className="aspect-video rounded bg-sunken animate-pulse" />;
                    const phase = shotPhase(s.file);
                    return (
                      <a key={s.file} href={url} target="_blank" rel="noreferrer" className="relative block">
                        <img src={url} alt={s.label} className="w-full h-auto rounded border border-line" />
                        {phase && (
                          <span className="absolute top-1 left-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-surface/90 border border-line text-muted">
                            {phase === "before" ? t("goalShotBefore") : t("goalShotAfter")}
                          </span>
                        )}
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* 요청하지 않은 변경 — goal 범위 밖 변경이 섞였을 때만. 톤은 warning 고정:
              codegen 재실행·포매터처럼 정상적으로 딸려오는 경우가 흔해 danger로 올리면
              늑대소년이 된다. 의미는 "멈춰라"가 아니라 "판단해라". */}
          {narrativeReady && outOfScope && (
            <div>
              <span className="text-[11px] font-medium text-warning uppercase tracking-wider block mb-1">
                {t("goalSquashDialogOutOfScope")}
              </span>
              <p className="text-xs text-fg leading-relaxed px-2.5 py-2.5 bg-warning-subtle border border-warning/45 rounded-lg whitespace-pre-wrap">
                {outOfScope}
              </p>
            </div>
          )}

          {/* 커밋/PR 본문 — 편집 가능. 확정 시 GitHub 커밋·PR 본문에 그대로 반영된다. */}
          {commitMessage && (
            <div>
              <span className="text-[11px] font-medium text-faint uppercase tracking-wider block mb-1">
                {t("goalSquashDialogCommitMsg")}
              </span>
              <textarea
                value={draft}
                onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
                disabled={isApproving}
                spellCheck={false}
                rows={8}
                className="w-full text-xs px-3 py-2 bg-sunken border border-line rounded-lg whitespace-pre-wrap font-mono text-muted resize-y max-h-64 focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
              />
            </div>
          )}

          {/* 변경 파일 */}
          {filesChanged && filesChanged.length > 0 && (
            <div>
              <span className="text-[11px] font-medium text-faint uppercase tracking-wider block mb-1">
                {t("goalSquashDialogFilesChanged")} ({filesChanged.length})
              </span>
              <ul className="space-y-0.5 max-h-32 overflow-y-auto">
                {filesChanged.map((file, i) => (
                  <li key={i} className="text-xs text-muted font-mono flex items-center gap-1.5">
                    <span className="w-1 h-1 rounded-full bg-accent shrink-0" />
                    {file}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 건너뛴 작업 — degraded 반영 경고. 승인자는 이 목록 없이 반영됨을 인지해야 한다. */}
          {skippedTasks && skippedTasks.length > 0 && (
            <div>
              <span className="text-[11px] font-medium text-warning uppercase tracking-wider block mb-1">
                {t("goalSquashDialogSkipped")} ({skippedTasks.length})
              </span>
              <p className="text-xs text-warning/80 mb-1.5">{t("goalSquashDialogSkippedDesc")}</p>
              <ul className="space-y-0.5 max-h-32 overflow-y-auto">
                {skippedTasks.map((task) => (
                  <li key={task.id} className="text-xs text-muted flex items-center gap-1.5">
                    <span className="w-1 h-1 rounded-full bg-warning shrink-0" />
                    <span className="truncate">{task.title}</span>
                    {task.skip_reason === "retry_exhausted" && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-warning-subtle text-warning rounded shrink-0">
                        {t("skipReasonRetryExhausted")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 검증 결과 */}
          {acceptanceOutput && (
            <div>
              <span className="text-[11px] font-medium text-faint uppercase tracking-wider block mb-1">
                {t("goalSquashDialogAcceptance")}
              </span>
              <pre className="text-xs px-3 py-2 bg-sunken border border-line rounded-lg whitespace-pre-wrap break-all font-mono text-muted max-h-32 overflow-y-auto">
                {acceptanceOutput}
              </pre>
            </div>
          )}

          {/* 품질 게이트 — 조건부·실패가 하나라도 있으면 펼친 채로 연다. 그건 "의심이 갈 때
              내려가는 근거"가 아니라 승인자가 이미 알아야 할 판정이기 때문. */}
          {gate && Object.keys(gate.counts).length > 0 && (
            <div>
              <span className="text-[11px] font-medium text-faint uppercase tracking-wider block mb-1">
                {t("goalSquashDialogQualityGate")}
              </span>
              <details open={gateIssues.length > 0} className="border border-line rounded-lg bg-sunken overflow-hidden">
                <summary className="cursor-pointer select-none list-none px-3 py-2 text-xs text-muted hover:text-fg flex items-center gap-2">
                  {([
                    ["pass", "text-success bg-success-subtle"],
                    ["conditional", "text-warning bg-warning-subtle"],
                    ["fail", "text-danger bg-danger-subtle"],
                  ] as [string, string][])
                    .filter(([k]) => gate.counts[k])
                    .map(([k, cls]) => (
                      <span key={k} className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${cls}`}>
                        {t(`goalSquashDialogVerdict_${k}`)} {gate.counts[k]}
                      </span>
                    ))}
                  {gateIssues.length > 0 && (
                    <span className="ml-auto text-[11px] text-faint">{t("goalSquashDialogGateIssues", { count: gateIssues.length })}</span>
                  )}
                </summary>
                {gateIssues.length > 0 && (
                  <div className="border-t border-line px-3 py-2.5 space-y-2.5 max-h-48 overflow-y-auto">
                    {gateIssues.map((iss) => (
                      <div key={iss.issue_id} className="text-xs">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-warning-subtle text-warning shrink-0">
                            {iss.dimension}
                          </span>
                          <span className="text-fg font-medium truncate">{iss.severity}</span>
                        </div>
                        {iss.evidence && (
                          <p className="mt-1 text-[11px] text-muted leading-relaxed whitespace-pre-wrap">{iss.evidence}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </details>
            </div>
          )}

          {/* 코드 변경 — 항상 접힘. 서사가 1차 화면이고 이것만이 진짜 2차 근거다. */}
          <div>
            <span className="text-[11px] font-medium text-faint uppercase tracking-wider block mb-1">
              {t("goalSquashDialogCodeChanges")}
            </span>
            <details
              className="border border-line rounded-lg bg-sunken overflow-hidden"
              onToggle={(e) => setDiffOpen((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary className="cursor-pointer select-none list-none px-3 py-2 text-xs text-muted hover:text-fg flex items-center gap-2">
                <svg
                  className={`w-2.5 h-2.5 shrink-0 transition-transform ${diffOpen ? "rotate-90" : ""}`}
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                {t("goalSquashDialogViewCode")}
                {filesChanged && filesChanged.length > 0 && (
                  <span className="ml-auto text-[11px] text-faint tabular-nums">
                    {t("goalSquashDialogFileCount", { count: filesChanged.length })}
                  </span>
                )}
              </summary>
              {diffOpen && (
                <div className="border-t border-line max-h-72 overflow-y-auto">
                  <DiffPane goalId={goal.id} />
                </div>
              )}
            </details>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line-soft shrink-0">
          <button
            onClick={onCancel}
            disabled={isApproving}
            className="text-xs px-4 py-2 text-muted hover:text-fg disabled:opacity-40 transition-colors"
          >
            {t("cancel")}
          </button>
          <button
            onClick={() => onConfirm(dirty ? draft : undefined)}
            disabled={isApproving}
            className="text-xs px-5 py-2 bg-accent hover:bg-accent-hover text-on-accent rounded-lg font-semibold disabled:opacity-50 transition-colors flex items-center gap-2"
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
