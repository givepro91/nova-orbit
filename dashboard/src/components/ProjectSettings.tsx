import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../stores/useStore";
import { api } from "../lib/api";
import { Toast } from "./Toast";

interface Props {
  projectId: string;
}

export function ProjectSettings({ projectId }: Props) {
  const { t } = useTranslation();
  const { projects, updateProject, removeProject, setCurrentProject } = useStore();
  const project = projects.find((p) => p.id === projectId);

  const [editingMission, setEditingMission] = useState(false);
  const [missionDraft, setMissionDraft] = useState("");
  const [ideateAutoOpen, setIdeateAutoOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [autoPush, setAutoPush] = useState(project?.github?.autoPush ?? false);
  const [prMode, setPrMode] = useState(project?.github?.prMode ?? false);
  const [gitMode, setGitMode] = useState<string>(project?.github?.gitMode ?? "local_only");
  const [baseBranch, setBaseBranch] = useState(project?.base_branch ?? "main");
  const [savingBaseBranch, setSavingBaseBranch] = useState(false);
  // GitHub origin 연동 상태 — gitMode 선택이 실제로 의미 있는지 판단 근거
  const [gitRemote, setGitRemote] = useState<{ hasOrigin: boolean; isGitHub: boolean; repo: string | null } | null>(null);
  // Agent role files
  const [agentFiles, setAgentFiles] = useState<Array<{ filename: string; content: string }>>([]);
  const [agentFilesLoading, setAgentFilesLoading] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!project?.workdir) return;
    setAgentFilesLoading(true);
    api.projects.agentFiles(projectId)
      .then((files) => setAgentFiles(files))
      .catch(() => setAgentFiles([]))
      .finally(() => setAgentFilesLoading(false));
  }, [projectId, project?.workdir]);

  const toggleFileExpand = useCallback((filename: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  }, []);

  // Branch management
  const [branches, setBranches] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);
  const [mergeAgent, setMergeAgent] = useState<string | null>(null);
  const [deletingBranches, setDeletingBranches] = useState(false);
  const [confirmDeleteBranches, setConfirmDeleteBranches] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadBranches = useCallback(async () => {
    try {
      const data = await api.projects.listBranches(projectId);
      setBranches(data.branches);
      // Stop polling when no branches remain
      if (data.branches.length === 0 && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        if (merging) {
          setMerging(false);
          setMergeAgent(null);
          setToast(t("branchMergeAgentDone"));
        }
      }
    } catch { /* ignore */ }
  }, [projectId, merging, t]);

  useEffect(() => { loadBranches(); }, [loadBranches]);

  // GitHub origin 연동 여부 조회 (read-only) — gitMode 선택 맥락 표시용
  useEffect(() => {
    let cancelled = false;
    api.projects.gitRemote(projectId)
      .then((r) => { if (!cancelled) setGitRemote(r); })
      .catch(() => { if (!cancelled) setGitRemote(null); });
    return () => { cancelled = true; };
  }, [projectId]);

  // Listen for merge completion via WebSocket custom event
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.type === "project:branch-merge-complete" && detail?.data?.projectId === projectId) {
        setMerging(false);
        setMergeAgent(null);
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        loadBranches();
        const d = detail.data;
        if (d.error) {
          setToast(t("branchMergeError"));
        } else if (d.remaining?.length > 0) {
          setToast(t("branchMergePartial", { merged: d.merged, remaining: d.remaining.length }));
        } else {
          setToast(t("branchMergeAgentDone"));
        }
      }
    };
    // W2 코얼레싱 이후 crewdeck:refresh detail에는 메시지 데이터가 없다 —
    // branch-merge 완료 payload가 필요하므로 즉시 패스스루(ws-event)를 구독한다.
    window.addEventListener("crewdeck:ws-event", handler);
    return () => {
      window.removeEventListener("crewdeck:ws-event", handler);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [projectId, loadBranches, t]);

  if (!project) return null;

  const startEditMission = () => {
    setIdeateAutoOpen(false);
    setMissionDraft(project.mission ?? "");
    setEditingMission(true);
  };

  // "AI로 방향 잡기" — 편집기 진입과 동시에 발산 패널 메뉴를 연다(진입 마찰 제거).
  const startIdeate = () => {
    setMissionDraft(project.mission ?? "");
    setEditingMission(true);
    setIdeateAutoOpen(true);
  };

  const cancelEditMission = () => {
    setEditingMission(false);
    setMissionDraft("");
    setIdeateAutoOpen(false);
  };

  const saveMission = async () => {
    if (missionDraft === project.mission) { cancelEditMission(); return; }
    setSaving(true);
    try {
      const updated = await api.projects.update(projectId, { mission: missionDraft });
      updateProject(updated);
      setEditingMission(false);
    } catch {
      setToast(t("errorSaveMissionFailed"));
    }
    finally { setSaving(false); }
  };

  const handleMissionKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); saveMission(); }
    if (e.key === "Escape") cancelEditMission();
  };

  const saveGithubField = async (patch: Partial<typeof project.github>) => {
    try {
      const updated = await api.projects.update(projectId, { github: { ...project.github, ...patch } });
      updateProject(updated);
    } catch {
      setToast(t("errorSaveSettingFailed"));
    }
  };

  const saveBaseBranch = async () => {
    const value = baseBranch.trim();
    if (!value || value === (project?.base_branch ?? "main") || savingBaseBranch) return;
    setSavingBaseBranch(true);
    try {
      const updated = await api.projects.update(projectId, { base_branch: value });
      updateProject(updated);
      setToast(t("baseBranchSaved"));
    } catch {
      setToast(t("errorSaveSettingFailed"));
      setBaseBranch(project?.base_branch ?? "main");
    } finally {
      setSavingBaseBranch(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.projects.delete(projectId);
      removeProject(projectId);
      setCurrentProject(null);
    } catch {
      setToast(t("errorDeleteFailed"));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const sourceLabel: Record<string, string> = {
    new: t("settingsSourceNew"),
    local_import: t("settingsSourceLocalImport"),
    github: t("settingsSourceGitHub"),
  };

  return (
    <div className="space-y-8">
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}

      {/* Mission */}
      <section>
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3">
          {t("settingsMission")}
        </h2>
        <div className="p-4 border border-line rounded-lg bg-surface">
          {editingMission ? (
            <div className="flex flex-col gap-2">
              <textarea
                autoFocus rows={3} value={missionDraft}
                onChange={(e) => setMissionDraft(e.target.value)}
                onKeyDown={handleMissionKeyDown} disabled={saving}
                className="w-full text-sm border border-accent rounded px-2 py-1 bg-sunken text-fg focus:outline-none focus:ring-1 focus:ring-accent resize-none"
                placeholder={t("missionPlaceholderDetailed")}
              />
              <div className="flex items-center gap-2">
                <button onClick={saveMission} disabled={saving}
                  className="text-xs px-3 py-1 bg-fg text-canvas rounded hover:bg-fg/90 disabled:opacity-50">
                  {saving ? t("settingsSaving") : t("settingsSave")}
                </button>
                <button onClick={cancelEditMission} disabled={saving}
                  className="text-xs px-3 py-1 border border-line rounded hover:bg-fg/5 text-muted">
                  {t("settingsCancel")}
                </button>
              </div>
              <MissionIdeation projectId={projectId} onPick={setMissionDraft} disabled={saving} initialOpen={ideateAutoOpen} />
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <div className="flex-1 group cursor-pointer" onClick={startEditMission} title={t("clickToEdit")}>
                <p className="text-sm text-muted">
                  {project.mission || <span className="text-faint italic">{t("settingsNoMission")}</span>}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                <button onClick={startEditMission}
                  className="text-xs text-faint hover:text-muted transition-colors">
                  {t("settingsEdit")}
                </button>
                <button
                  onClick={startIdeate}
                  className="text-xs text-accent hover:text-accent-hover transition-colors"
                >
                  {t("missionIdeate")}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Project Info */}
      <section>
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3">
          {t("settingsProjectInfo")}
        </h2>
        <div className="p-4 border border-line rounded-lg bg-surface space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted">{t("settingsWorkDirectory")}</span>
            <span className="text-sm font-mono text-muted bg-sunken px-2 py-0.5 rounded">
              {project.workdir || "\u2014"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted">{t("settingsSourceType")}</span>
            <span className="text-xs px-2 py-0.5 bg-sunken text-muted rounded">
              {sourceLabel[project.source] ?? project.source}
            </span>
          </div>
        </div>
      </section>

      {/* Git Workflow Mode — 모든 프로젝트 공통 */}
      <section>
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3">
          {t("settingsGitWorkflow")}
        </h2>
        <div className="p-4 border border-line rounded-lg bg-surface space-y-3">
          {gitRemote && (() => {
            if (gitRemote.isGitHub) {
              return (
                <div className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded bg-info-subtle text-info">
                  <span>🔗</span>
                  <span>{t("gitRemoteConnected")}{gitRemote.repo ? ` · ${gitRemote.repo}` : ""}</span>
                </div>
              );
            }
            return (
              <div className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded bg-warning-subtle text-warning">
                <span>⚠</span>
                <span>{gitRemote.hasOrigin ? t("gitRemoteNonGithub") : t("gitRemoteNone")}</span>
              </div>
            );
          })()}
          <div className="grid gap-2">
            {([
              { value: "local_only", icon: "💻", label: t("gitModeLocalOnly"), desc: t("gitModeLocalOnlyDesc") },
              { value: "branch_only", icon: "🔀", label: t("gitModeBranchOnly"), desc: t("gitModeBranchOnlyDesc") },
              { value: "auto", icon: "✨", label: t("gitModeAuto"), desc: t("gitModeAutoDesc") },
              { value: "pr", icon: "📋", label: t("gitModePR"), desc: t("gitModePRDesc") },
              { value: "main_direct", icon: "🚀", label: t("gitModeMainDirect"), desc: t("gitModeMainDirectDesc") },
            ] as const).map((opt) => (
              <button
                key={opt.value}
                onClick={async () => {
                  setGitMode(opt.value);
                  await saveGithubField({ gitMode: opt.value as any });
                }}
                className={`w-full text-left p-3 rounded-lg border-2 transition-all ${
                  gitMode === opt.value
                    ? "border-accent bg-accent/10"
                    : "border-line-soft hover:border-line"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">{opt.icon}</span>
                  <span className={`text-sm font-medium ${
                    gitMode === opt.value
                      ? "text-accent"
                      : "text-muted"
                  }`}>
                    {opt.label}
                  </span>
                  {opt.value === "local_only" && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-success-subtle text-success rounded-full font-medium">
                      {t("gitModeRecommended")}
                    </span>
                  )}
                </div>
                <p className="text-xs text-faint mt-1 ml-6">
                  {opt.desc}
                </p>
              </button>
            ))}
          </div>
          <div>
            <label className="text-xs font-medium text-muted mb-1 block">
              {t("baseBranchLabel")}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveBaseBranch(); }}
                onBlur={saveBaseBranch}
                disabled={savingBaseBranch}
                className="w-48 px-3 py-1.5 text-sm border border-line rounded-lg bg-sunken text-fg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50 font-mono"
              />
            </div>
            <p className="text-[11px] text-faint mt-1">{t("baseBranchHelp")}</p>
          </div>
          <div>
            <label className="text-xs font-medium text-muted mb-1 block">
              goal 병렬 (동시성)
            </label>
            <select
              value={(project as any)?.max_concurrency ?? ""}
              onChange={async (e) => {
                const val = e.target.value === "" ? null : Number(e.target.value);
                const updated = await api.projects.update(projectId, { max_concurrency: val });
                updateProject(updated);
              }}
              className="w-48 px-3 py-1.5 text-sm border border-line rounded-lg bg-sunken text-fg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="">자동 (전역 기본)</option>
              {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                <option key={n} value={n}>{n} 병렬</option>
              ))}
            </select>
            <p className="text-[11px] text-faint mt-1">
              동시에 돌릴 goal 수 상한 — 재시작 없이 즉시 반영. 실제 병렬은 독립 실행가능 태스크·팀 수에 따라 달라집니다.
            </p>
          </div>
          <div>
            <label className="text-xs font-medium text-muted mb-1 block">
              {t("defaultEngineLabel")}
            </label>
            <select
              value={(project as any)?.default_provider ?? ""}
              onChange={async (e) => {
                const val = e.target.value || null;
                const updated = await api.projects.update(projectId, { default_provider: val });
                updateProject(updated);
              }}
              className="w-48 px-3 py-1.5 text-sm border border-line rounded-lg bg-sunken text-fg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="">{t("engineAuto")} (Claude)</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
            <p className="text-[11px] text-faint mt-1">{t("defaultEngineHelp")}</p>
          </div>
          <div>
            <label className="text-xs font-medium text-muted mb-1 block">
              실행 방식
            </label>
            <select
              value={(project as any)?.execution_mode ?? "headless"}
              onChange={async (e) => {
                const updated = await api.projects.update(projectId, { execution_mode: e.target.value });
                updateProject(updated);
              }}
              className="w-48 px-3 py-1.5 text-sm border border-line rounded-lg bg-sunken text-fg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="headless">무인 실행 (기본)</option>
              <option value="pty">터미널에서 실행 — 보면서 개입</option>
            </select>
            <p className="text-[11px] text-faint mt-1">
              터미널 실행을 고르면 담당 에이전트가 실제 터미널에서 일하고, 그 화면을 그대로 보거나 끼어들 수 있습니다.
              담당자가 바뀌면 그 에이전트용 터미널이 하나 더 열립니다. 작업 공간을 닫아두면 자동으로 무인 실행으로 처리되니 진행이 멈추지 않습니다.
              언제든 되돌릴 수 있습니다.
            </p>
          </div>
          <div className="flex items-start gap-2 p-2 bg-sunken rounded-lg">
            <span className="text-xs text-faint">ℹ️</span>
            <p className="text-xs text-faint">
              {t("gitModeAutoMergeNote")}
            </p>
          </div>
        </div>
      </section>

      {/* Unmerged agent branches */}
      {branches.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-warning uppercase tracking-wider mb-3">
            {t("branchSectionTitle", { count: branches.length })}
          </h2>
          <div className="p-4 border border-warning/50 rounded-lg bg-surface space-y-3">
            <div className="max-h-40 overflow-y-auto space-y-1">
              {branches.map((b) => (
                <div key={b} className="flex items-center gap-2 px-2 py-1.5 bg-sunken rounded text-xs font-mono text-muted">
                  <span className="text-warning">⎇</span>
                  <span className="flex-1 truncate">{b}</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-faint">
              {t("branchDesc")}
            </p>
            {merging && mergeAgent && (
              <div className="flex items-center gap-2 p-2 bg-info-subtle rounded-lg">
                <span className="inline-block w-2 h-2 bg-accent rounded-full animate-pulse" />
                <p className="text-xs text-accent">
                  {t("branchMergeAgentWorking", { agent: mergeAgent })}
                </p>
              </div>
            )}
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={async () => {
                  setMerging(true);
                  try {
                    const result = await api.projects.mergeAllBranches(projectId);
                    if (result.status === "started") {
                      setMergeAgent(result.agentName ?? null);
                      // Poll branches until agent finishes
                      pollRef.current = setInterval(() => loadBranches(), 5000);
                    } else {
                      setMerging(false);
                    }
                  } catch {
                    setToast(t("branchMergeError"));
                    setMerging(false);
                  }
                }}
                disabled={merging || deletingBranches}
                className="text-xs px-3 py-1.5 bg-warning text-white rounded hover:opacity-90 disabled:opacity-50 transition-colors"
              >
                {merging ? t("branchMerging") : t("branchMergeAll")}
              </button>
              {confirmDeleteBranches ? (
                <div className="flex items-center gap-2">
                  <button
                    onClick={async () => {
                      setDeletingBranches(true);
                      try {
                        const result = await api.projects.deleteAllBranches(projectId);
                        setToast(t("branchDeleteSuccess", { count: result.deleted.length }));
                        await loadBranches();
                      } catch { setToast(t("branchDeleteError")); }
                      finally { setDeletingBranches(false); setConfirmDeleteBranches(false); }
                    }}
                    disabled={deletingBranches}
                    className="text-xs px-3 py-1.5 bg-danger text-white rounded hover:opacity-90 disabled:opacity-50"
                  >
                    {deletingBranches ? t("branchDeleting") : t("branchConfirmDelete")}
                  </button>
                  <button
                    onClick={() => setConfirmDeleteBranches(false)}
                    disabled={deletingBranches}
                    className="text-xs px-3 py-1.5 border border-line rounded hover:bg-fg/5 text-muted"
                  >
                    {t("settingsCancel")}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDeleteBranches(true)}
                  disabled={merging}
                  className="text-xs px-3 py-1.5 border border-line rounded hover:bg-fg/5 text-muted"
                >
                  {t("branchDeleteAll")}
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {/* GitHub Config — GitHub 연결 프로젝트 추가 설정 */}
      {project.source === "github" && project.github && (
        <section>
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3">
            {t("settingsGitHub")}
          </h2>
          <div className="p-4 border border-line rounded-lg bg-surface space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">{t("settingsRepository")}</span>
              <span className="text-sm font-mono text-muted">{project.github.repoUrl}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">{t("settingsBranch")}</span>
              <span className="text-xs px-2 py-0.5 bg-info-subtle text-info rounded font-mono">
                {project.github.branch}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">{t("settingsAutoPush")}</span>
              <Toggle checked={autoPush} onChange={() => { const n = !autoPush; setAutoPush(n); saveGithubField({ autoPush: n }); }} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">{t("settingsPrMode")}</span>
              <Toggle checked={prMode} onChange={() => { const n = !prMode; setPrMode(n); saveGithubField({ prMode: n }); }} />
            </div>
          </div>
        </section>
      )}

      {/* Agent Role Files */}
      <section>
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3">
          {t("settingsAgentFiles")}
        </h2>
        <div className="border border-line rounded-lg bg-surface">
          {!project.workdir ? (
            <p className="px-4 py-3 text-xs text-faint">
              {t("settingsAgentFilesNoWorkdir")}
            </p>
          ) : agentFilesLoading ? (
            <p className="px-4 py-3 text-xs text-faint">{t("loading")}</p>
          ) : agentFiles.length === 0 ? (
            <p className="px-4 py-3 text-xs text-faint">
              {t("settingsAgentFilesEmpty")}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700">
              {agentFiles.map(({ filename, content }) => {
                const isExpanded = expandedFiles.has(filename);
                const previewLines = content.split("\n").slice(0, 3).join("\n");
                const hasMore = content.split("\n").length > 3;
                return (
                  <li key={filename} className="p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-mono font-medium text-muted">
                        {filename}
                      </span>
                      {hasMore && (
                        <button
                          onClick={() => toggleFileExpand(filename)}
                          className="text-xs text-faint hover:text-muted transition-colors"
                        >
                          {isExpanded ? t("settingsAgentFilesCollapse") : t("settingsAgentFilesExpand")}
                        </button>
                      )}
                    </div>
                    <pre className="text-xs text-muted bg-sunken rounded px-3 py-2 whitespace-pre-wrap break-words overflow-hidden">
                      {isExpanded ? content : previewLines}
                      {!isExpanded && hasMore && (
                        <span className="text-faint">…</span>
                      )}
                    </pre>
                  </li>
                );
              })}
            </ul>
          )}
          {agentFiles.length > 0 && (
            <p className="px-4 py-2 border-t border-line-soft text-[11px] text-faint">
              {t("settingsAgentFilesDesc")}
            </p>
          )}
        </div>
      </section>

      {/* Danger Zone */}
      <section>
        <h2 className="text-sm font-semibold text-danger uppercase tracking-wider mb-3">
          {t("settingsDangerZone")}
        </h2>
        <div className="p-4 border border-danger/50 rounded-lg bg-surface">
          {confirmDelete ? (
            <div className="space-y-3">
              <p className="text-sm text-danger">{t("settingsDeleteConfirm")}</p>
              <p className="text-xs text-faint">{t("settingsDeleteDirNote")}</p>
              <div className="flex items-center gap-3">
                <button onClick={handleDelete} disabled={deleting}
                  className="text-xs px-3 py-1.5 bg-danger text-white rounded hover:opacity-90 disabled:opacity-50">
                  {deleting ? t("settingsDeleting") : t("settingsYesDelete")}
                </button>
                <button onClick={() => setConfirmDelete(false)} disabled={deleting}
                  className="text-xs px-3 py-1.5 border border-line rounded hover:bg-fg/5 text-muted">
                  {t("settingsCancel")}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted">{t("settingsDeleteProject")}</p>
                <p className="text-xs text-faint mt-0.5">{t("settingsDeleteDesc")}</p>
              </div>
              <button onClick={() => setConfirmDelete(true)}
                className="text-xs px-3 py-1.5 border border-danger text-danger rounded hover:bg-danger-subtle">
                {t("settingsDelete")}
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

interface MissionIdeationProps {
  projectId: string;
  onPick: (draft: string) => void;
  disabled?: boolean;
  initialOpen?: boolean;
}

// 미션 발산 이데이션 패널 — 원샷 추천 대신 야망 축으로 벌린 방향 3~4개를 고르게 한다.
// 두 진입: 바로 발산(옵션) / 질문먼저(하이브리드, stateless 2-step). 멀티턴 세션 없음.
function MissionIdeation({ projectId, onPick, disabled, initialOpen }: MissionIdeationProps) {
  const { t } = useTranslation();
  type Phase = "idle" | "menu" | "loading" | "options" | "question";
  // "AI로 방향 잡기"로 진입하면 곧장 메뉴부터(view 모드 진입 마찰 제거). 순수 편집 진입은 idle.
  const [phase, setPhase] = useState<Phase>(initialOpen ? "menu" : "idle");
  const [options, setOptions] = useState<Array<{ id: string; label: string; draft: string; rationale: string }>>([]);
  const [question, setQuestion] = useState<{ text: string; chips: string[] } | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 순수 네비게이션(뒤로/idle↔menu) 시 이전 실패 문구를 함께 지운다.
  const go = (p: Phase) => { setError(null); setPhase(p); };

  const loadOptions = async (ans?: string) => {
    setPhase("loading");
    setError(null);
    try {
      const res = await api.projects.suggestMissionOptions(projectId, ans);
      setOptions(res.options ?? []);
      setPhase("options");
    } catch (err: any) {
      setError(err?.message || t("missionSuggestFailed"));
      setPhase("menu");
    }
  };

  const loadQuestion = async () => {
    setPhase("loading");
    setError(null);
    try {
      const res = await api.projects.suggestMissionQuestion(projectId);
      setQuestion(res.question ?? { text: "", chips: [] });
      setPhase("question");
    } catch (err: any) {
      setError(err?.message || t("missionSuggestFailed"));
      setPhase("menu");
    }
  };

  const pick = (draft: string) => {
    onPick(draft);
    setPhase("idle");
  };

  const spinner = (
    <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );

  const renderBody = () => {
    if (phase === "loading") {
      return (
        <div className="flex items-center gap-2 text-xs text-faint">
          {spinner} {t("missionIdeateThinking")}
        </div>
      );
    }
    if (phase === "menu") {
      return (
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={() => loadOptions()}
            className="text-xs px-2.5 py-1 border border-accent/25 text-accent rounded-full hover:bg-accent/10 transition-colors">
            {t("missionIdeateDirect")}
          </button>
          <button type="button" onClick={loadQuestion}
            className="text-xs px-2.5 py-1 border border-line text-muted rounded-full hover:bg-fg/5 transition-colors">
            {t("missionIdeateInterview")}
          </button>
          <button type="button" onClick={() => go("idle")}
            className="text-xs text-faint hover:text-muted">
            {t("missionIdeateBack")}
          </button>
        </div>
      );
    }
    if (phase === "question" && question) {
      return (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">{question.text}</p>
          <div className="flex flex-wrap gap-1.5">
            {question.chips.map((c, i) => (
              <button key={`${i}-${c}`} type="button" onClick={() => loadOptions(c)}
                className="text-xs px-2.5 py-1 bg-sunken text-muted rounded-full hover:bg-accent/20 transition-colors">
                {c}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && answer.trim()) loadOptions(answer.trim()); }}
              placeholder={t("missionIdeateAnswerPlaceholder")}
              className="flex-1 text-xs border border-line rounded px-2 py-1 bg-sunken text-fg focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button type="button" disabled={!answer.trim()} onClick={() => loadOptions(answer.trim())}
              className="text-xs px-2.5 py-1 bg-accent text-on-accent rounded hover:bg-accent-hover disabled:opacity-40">
              {t("missionIdeateSubmitAnswer")}
            </button>
          </div>
          <button type="button" onClick={() => go("menu")}
            className="self-start text-xs text-faint hover:text-muted">
            {t("missionIdeateBack")}
          </button>
        </div>
      );
    }
    if (phase === "options") {
      return (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] text-faint">
            {options.length === 0 ? t("missionIdeateEmpty") : t("missionIdeateOptionsHint")}
          </p>
          <div className="flex flex-col gap-1.5">
            {options.map((o) => (
              <button key={o.id} type="button" onClick={() => pick(o.draft)}
                className="text-left p-2 rounded-lg border border-line hover:border-accent hover:bg-accent/10 transition-colors">
                <span className="text-[10px] px-1.5 py-0.5 bg-accent/20 text-accent rounded-full font-medium">
                  {o.label}
                </span>
                <p className="text-xs text-muted mt-1">{o.draft}</p>
                {o.rationale && <p className="text-[11px] text-faint mt-0.5">{o.rationale}</p>}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => loadOptions()}
              className="text-xs text-accent hover:text-accent-hover">
              {t("missionIdeateRegenerate")}
            </button>
            <button type="button" onClick={() => go("menu")}
              className="text-xs text-faint hover:text-muted">
              {t("missionIdeateBack")}
            </button>
          </div>
        </div>
      );
    }
    // idle
    return (
      <button type="button" onClick={() => go("menu")} disabled={disabled}
        className="text-xs text-accent hover:text-accent-hover disabled:opacity-50 transition-colors">
        ✨ {t("missionIdeate")}
      </button>
    );
  };

  return (
    <div className="pt-1">
      {renderBody()}
      {error && <p className="text-xs text-danger mt-1">{error}</p>}
    </div>
  );
}

interface ToggleProps { checked: boolean; onChange: () => void; }

function Toggle({ checked, onChange }: ToggleProps) {
  return (
    <button onClick={onChange} role="switch" aria-checked={checked}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
        checked ? "bg-accent" : "bg-fg/10"
      }`}>
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
        checked ? "translate-x-4.5" : "translate-x-0.5"
      }`} />
    </button>
  );
}
