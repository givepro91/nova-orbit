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
  const [saving, setSaving] = useState(false);
  const [suggestingMission, setSuggestingMission] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [autoPush, setAutoPush] = useState(project?.github?.autoPush ?? false);
  const [prMode, setPrMode] = useState(project?.github?.prMode ?? false);
  const [gitMode, setGitMode] = useState<string>(project?.github?.gitMode ?? "local_only");
  const [baseBranch, setBaseBranch] = useState(project?.base_branch ?? "main");
  const [savingBaseBranch, setSavingBaseBranch] = useState(false);
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
    window.addEventListener("crewdeck:refresh", handler);
    return () => {
      window.removeEventListener("crewdeck:refresh", handler);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [projectId, loadBranches, t]);

  if (!project) return null;

  const startEditMission = () => {
    setMissionDraft(project.mission ?? "");
    setEditingMission(true);
  };

  const cancelEditMission = () => {
    setEditingMission(false);
    setMissionDraft("");
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
        <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
          {t("settingsMission")}
        </h2>
        <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-[#25253d]">
          {editingMission ? (
            <div className="flex flex-col gap-2">
              <textarea
                autoFocus rows={3} value={missionDraft}
                onChange={(e) => setMissionDraft(e.target.value)}
                onKeyDown={handleMissionKeyDown} disabled={saving}
                className="w-full text-sm border border-blue-400 rounded px-2 py-1 bg-white dark:bg-[#1a1a2e] text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none"
                placeholder={t("missionPlaceholderDetailed")}
              />
              <div className="flex items-center gap-2">
                <button onClick={saveMission} disabled={saving}
                  className="text-xs px-3 py-1 bg-gray-900 dark:bg-gray-200 text-white dark:text-gray-900 rounded hover:bg-gray-700 dark:hover:bg-gray-300 disabled:opacity-50">
                  {saving ? t("settingsSaving") : t("settingsSave")}
                </button>
                <button onClick={cancelEditMission} disabled={saving}
                  className="text-xs px-3 py-1 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">
                  {t("settingsCancel")}
                </button>
                <button
                  onClick={async () => {
                    setSuggestingMission(true);
                    try {
                      const result = await api.projects.suggestMission(projectId);
                      setMissionDraft(result.mission);
                      setToast(result.reason);
                    } catch (err: any) {
                      setToast(err.message || t("missionSuggestFailed"));
                    } finally {
                      setSuggestingMission(false);
                    }
                  }}
                  disabled={suggestingMission || saving}
                  className="text-xs px-3 py-1 border border-indigo-300 dark:border-indigo-700 text-indigo-600 dark:text-indigo-400 rounded hover:bg-indigo-50 dark:hover:bg-indigo-900/30 disabled:opacity-50 flex items-center gap-1"
                >
                  {suggestingMission ? (
                    <><svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg> {t("missionSuggesting")}</>
                  ) : (
                    <>{t("missionSuggest")}</>
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <div className="flex-1 group cursor-pointer" onClick={startEditMission} title={t("clickToEdit")}>
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  {project.mission || <span className="text-gray-400 dark:text-gray-500 italic">{t("settingsNoMission")}</span>}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                <button onClick={startEditMission}
                  className="text-xs text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 transition-colors">
                  {t("settingsEdit")}
                </button>
                <button
                  onClick={async () => {
                    setSuggestingMission(true);
                    try {
                      const result = await api.projects.suggestMission(projectId);
                      setMissionDraft(result.mission);
                      setEditingMission(true);
                      setToast(result.reason);
                    } catch (err: any) {
                      setToast(err.message || t("missionSuggestFailed"));
                    } finally {
                      setSuggestingMission(false);
                    }
                  }}
                  disabled={suggestingMission}
                  className="text-xs text-indigo-400 dark:text-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 disabled:opacity-50 transition-colors"
                >
                  {suggestingMission ? t("missionSuggesting") : t("missionSuggest")}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Project Info */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
          {t("settingsProjectInfo")}
        </h2>
        <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-[#25253d] space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">{t("settingsWorkDirectory")}</span>
            <span className="text-sm font-mono text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-[#1a1a2e] px-2 py-0.5 rounded">
              {project.workdir || "\u2014"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">{t("settingsSourceType")}</span>
            <span className="text-xs px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded">
              {sourceLabel[project.source] ?? project.source}
            </span>
          </div>
        </div>
      </section>

      {/* Git Workflow Mode — 모든 프로젝트 공통 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
          {t("settingsGitWorkflow")}
        </h2>
        <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-[#25253d] space-y-3">
          <div className="grid gap-2">
            {([
              { value: "local_only", icon: "💻", label: t("gitModeLocalOnly"), desc: t("gitModeLocalOnlyDesc") },
              { value: "branch_only", icon: "🔀", label: t("gitModeBranchOnly"), desc: t("gitModeBranchOnlyDesc") },
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
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                    : "border-gray-100 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-500"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">{opt.icon}</span>
                  <span className={`text-sm font-medium ${
                    gitMode === opt.value
                      ? "text-blue-700 dark:text-blue-300"
                      : "text-gray-700 dark:text-gray-300"
                  }`}>
                    {opt.label}
                  </span>
                  {opt.value === "local_only" && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 rounded-full font-medium">
                      {t("gitModeRecommended")}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 ml-6">
                  {opt.desc}
                </p>
              </button>
            ))}
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
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
                className="w-48 px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-[#1a1a2e] text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 disabled:opacity-50 font-mono"
              />
            </div>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">{t("baseBranchHelp")}</p>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
              goal 병렬 (동시성)
            </label>
            <select
              value={(project as any)?.max_concurrency ?? ""}
              onChange={async (e) => {
                const val = e.target.value === "" ? null : Number(e.target.value);
                const updated = await api.projects.update(projectId, { max_concurrency: val });
                updateProject(updated);
              }}
              className="w-48 px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-[#1a1a2e] text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
            >
              <option value="">자동 (전역 기본)</option>
              {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                <option key={n} value={n}>{n} 병렬</option>
              ))}
            </select>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
              동시에 돌릴 goal 수 상한 — 재시작 없이 즉시 반영. 실제 병렬은 독립 실행가능 태스크·팀 수에 따라 달라집니다.
            </p>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
              {t("defaultEngineLabel")}
            </label>
            <select
              value={(project as any)?.default_provider ?? ""}
              onChange={async (e) => {
                const val = e.target.value || null;
                const updated = await api.projects.update(projectId, { default_provider: val });
                updateProject(updated);
              }}
              className="w-48 px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-[#1a1a2e] text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
            >
              <option value="">{t("engineAuto")} (Claude)</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">{t("defaultEngineHelp")}</p>
          </div>
          <div className="flex items-start gap-2 p-2 bg-gray-50 dark:bg-[#1a1a2e] rounded-lg">
            <span className="text-xs text-gray-400">ℹ️</span>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              {t("gitModeAutoMergeNote")}
            </p>
          </div>
        </div>
      </section>

      {/* Unmerged agent branches */}
      {branches.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-amber-500 dark:text-amber-400 uppercase tracking-wider mb-3">
            {t("branchSectionTitle", { count: branches.length })}
          </h2>
          <div className="p-4 border border-amber-200 dark:border-amber-800/50 rounded-lg bg-white dark:bg-[#25253d] space-y-3">
            <div className="max-h-40 overflow-y-auto space-y-1">
              {branches.map((b) => (
                <div key={b} className="flex items-center gap-2 px-2 py-1.5 bg-gray-50 dark:bg-[#1a1a2e] rounded text-xs font-mono text-gray-600 dark:text-gray-400">
                  <span className="text-amber-500">⎇</span>
                  <span className="flex-1 truncate">{b}</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              {t("branchDesc")}
            </p>
            {merging && mergeAgent && (
              <div className="flex items-center gap-2 p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                <span className="inline-block w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                <p className="text-xs text-blue-600 dark:text-blue-400">
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
                className="text-xs px-3 py-1.5 bg-amber-500 text-white rounded hover:bg-amber-600 disabled:opacity-50 transition-colors"
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
                    className="text-xs px-3 py-1.5 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                  >
                    {deletingBranches ? t("branchDeleting") : t("branchConfirmDelete")}
                  </button>
                  <button
                    onClick={() => setConfirmDeleteBranches(false)}
                    disabled={deletingBranches}
                    className="text-xs px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
                  >
                    {t("settingsCancel")}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDeleteBranches(true)}
                  disabled={merging}
                  className="text-xs px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
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
          <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
            {t("settingsGitHub")}
          </h2>
          <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-[#25253d] space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">{t("settingsRepository")}</span>
              <span className="text-sm font-mono text-gray-700 dark:text-gray-300">{project.github.repoUrl}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">{t("settingsBranch")}</span>
              <span className="text-xs px-2 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded font-mono">
                {project.github.branch}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">{t("settingsAutoPush")}</span>
              <Toggle checked={autoPush} onChange={() => { const n = !autoPush; setAutoPush(n); saveGithubField({ autoPush: n }); }} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">{t("settingsPrMode")}</span>
              <Toggle checked={prMode} onChange={() => { const n = !prMode; setPrMode(n); saveGithubField({ prMode: n }); }} />
            </div>
          </div>
        </section>
      )}

      {/* Agent Role Files */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
          {t("settingsAgentFiles")}
        </h2>
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-[#25253d]">
          {!project.workdir ? (
            <p className="px-4 py-3 text-xs text-gray-400 dark:text-gray-500">
              {t("settingsAgentFilesNoWorkdir")}
            </p>
          ) : agentFilesLoading ? (
            <p className="px-4 py-3 text-xs text-gray-400 dark:text-gray-500">{t("loading")}</p>
          ) : agentFiles.length === 0 ? (
            <p className="px-4 py-3 text-xs text-gray-400 dark:text-gray-500">
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
                      <span className="text-sm font-mono font-medium text-gray-700 dark:text-gray-300">
                        {filename}
                      </span>
                      {hasMore && (
                        <button
                          onClick={() => toggleFileExpand(filename)}
                          className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                        >
                          {isExpanded ? t("settingsAgentFilesCollapse") : t("settingsAgentFilesExpand")}
                        </button>
                      )}
                    </div>
                    <pre className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-[#1a1a2e] rounded px-3 py-2 whitespace-pre-wrap break-words overflow-hidden">
                      {isExpanded ? content : previewLines}
                      {!isExpanded && hasMore && (
                        <span className="text-gray-300 dark:text-gray-600">…</span>
                      )}
                    </pre>
                  </li>
                );
              })}
            </ul>
          )}
          {agentFiles.length > 0 && (
            <p className="px-4 py-2 border-t border-gray-100 dark:border-gray-700 text-[11px] text-gray-400 dark:text-gray-500">
              {t("settingsAgentFilesDesc")}
            </p>
          )}
        </div>
      </section>

      {/* Danger Zone */}
      <section>
        <h2 className="text-sm font-semibold text-red-400 uppercase tracking-wider mb-3">
          {t("settingsDangerZone")}
        </h2>
        <div className="p-4 border border-red-100 dark:border-red-900/50 rounded-lg bg-white dark:bg-[#25253d]">
          {confirmDelete ? (
            <div className="space-y-3">
              <p className="text-sm text-red-600 dark:text-red-400">{t("settingsDeleteConfirm")}</p>
              <p className="text-xs text-gray-400 dark:text-gray-500">{t("settingsDeleteDirNote")}</p>
              <div className="flex items-center gap-3">
                <button onClick={handleDelete} disabled={deleting}
                  className="text-xs px-3 py-1.5 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
                  {deleting ? t("settingsDeleting") : t("settingsYesDelete")}
                </button>
                <button onClick={() => setConfirmDelete(false)} disabled={deleting}
                  className="text-xs px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">
                  {t("settingsCancel")}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t("settingsDeleteProject")}</p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{t("settingsDeleteDesc")}</p>
              </div>
              <button onClick={() => setConfirmDelete(true)}
                className="text-xs px-3 py-1.5 border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 rounded hover:bg-red-50 dark:hover:bg-red-900/30">
                {t("settingsDelete")}
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

interface ToggleProps { checked: boolean; onChange: () => void; }

function Toggle({ checked, onChange }: ToggleProps) {
  return (
    <button onClick={onChange} role="switch" aria-checked={checked}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
        checked ? "bg-blue-500" : "bg-gray-200 dark:bg-gray-600"
      }`}>
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
        checked ? "translate-x-4.5" : "translate-x-0.5"
      }`} />
    </button>
  );
}
