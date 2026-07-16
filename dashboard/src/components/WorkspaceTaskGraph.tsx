import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  Blueprint,
  CheckCircle,
  CircleNotch,
  FloppyDisk,
  GitBranch,
  LockSimple,
  PlayCircle,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { api, type TaskGraphItem, type TaskGraphResponse } from "../lib/api";
import { ConfirmDialog } from "./ConfirmDialog";

interface GraphAgent {
  id: string;
  name: string;
  role: string;
}

const STATUS_TRANSITIONS: Record<string, string[]> = {
  pending_approval: ["pending_approval", "todo", "blocked"],
  todo: ["todo", "in_progress", "blocked", "pending_approval"],
  in_progress: ["in_progress", "in_review", "blocked", "todo"],
  in_review: ["in_review", "done", "todo", "blocked"],
  done: ["done", "todo"],
  blocked: ["blocked", "todo", "in_progress", "pending_approval"],
};

function deriveState(task: TaskGraphItem, tasks: TaskGraphItem[]): TaskGraphItem["execution_state"] {
  if (task.status === "done") return "complete";
  const taskById = new Map(tasks.map((item) => [item.id, item]));
  if (task.status === "blocked" || task.depends_on.some((dependencyId) => taskById.get(dependencyId)?.status !== "done")) {
    return "blocked";
  }
  if (task.status === "in_progress" || task.status === "in_review") return "active";
  return "ready";
}

function stateIcon(state: TaskGraphItem["execution_state"]) {
  if (state === "complete") return <CheckCircle size={16} weight="fill" className="text-success" />;
  if (state === "active") return <CircleNotch size={16} weight="bold" className="animate-spin text-accent" />;
  if (state === "blocked") return <LockSimple size={16} weight="fill" className="text-warning" />;
  return <PlayCircle size={16} weight="fill" className="text-success" />;
}

export function WorkspaceTaskGraph({
  goalId,
  agents,
  onClose,
  onOpenBlueprint,
  onChanged,
}: {
  goalId: string;
  agents: GraphAgent[];
  onClose: () => void;
  onOpenBlueprint: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [graph, setGraph] = useState<TaskGraphResponse | null>(null);
  const [drafts, setDrafts] = useState<TaskGraphItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "split" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmSplit, setConfirmSplit] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const applyGraph = useCallback((next: TaskGraphResponse) => {
    setGraph(next);
    setDrafts([...next.tasks].sort((a, b) => a.sort_order - b.sort_order));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      applyGraph(await api.tasks.getGraph(goalId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("workspaceTaskGraphLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [applyGraph, goalId, t]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      previousFocusRef.current?.focus();
    };
  }, []);

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((element) => element.getClientRects().length > 0);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const updateDraft = (taskId: string, patch: Partial<TaskGraphItem>) => {
    setDrafts((current) => current.map((task) => task.id === taskId ? { ...task, ...patch } : task));
  };

  const move = (taskId: string, direction: -1 | 1) => {
    setDrafts((current) => {
      const index = current.findIndex((task) => task.id === taskId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next.map((task, sortOrder) => ({ ...task, sort_order: sortOrder }));
    });
  };

  const dirty = useMemo(() => {
    if (!graph || graph.tasks.length !== drafts.length) return false;
    const originalById = new Map(graph.tasks.map((task) => [task.id, task]));
    return drafts.some((task) => {
      const original = originalById.get(task.id);
      return !original
        || task.title !== original.title
        || task.description !== original.description
        || task.assignee_id !== original.assignee_id
        || task.status !== original.status
        || task.sort_order !== original.sort_order
        || JSON.stringify(task.depends_on) !== JSON.stringify(original.depends_on);
    });
  }, [drafts, graph]);

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      const next = await api.tasks.updateGraph(goalId, drafts.map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        assignee_id: task.assignee_id,
        status: task.status,
        sort_order: task.sort_order,
        depends_on: task.depends_on,
      })));
      applyGraph(next);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("workspaceTaskGraphSaveFailed"));
    } finally {
      setBusy(null);
    }
  };

  const split = async () => {
    if (drafts.length > 0 && !confirmSplit) {
      setConfirmSplit(true);
      return;
    }
    setConfirmSplit(false);
    setBusy("split");
    setError(null);
    try {
      await api.orchestration.decomposeGoal(goalId);
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("workspaceGoalActionFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-2 sm:p-4" onClick={onClose}>
        <section
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="workspace-task-graph-title"
          aria-busy={loading || busy !== null}
          className="flex max-h-[calc(100dvh-1rem)] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl sm:max-h-[94vh]"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleDialogKeyDown}
        >
          <header className="flex shrink-0 flex-col items-stretch justify-between gap-3 border-b border-line px-3 py-3 sm:flex-row sm:items-start sm:gap-4 sm:px-5 sm:py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <GitBranch size={18} weight="duotone" className="shrink-0 text-accent" />
                <h2 id="workspace-task-graph-title" className="truncate text-sm font-semibold text-fg">{t("workspaceTaskGraphTitle")}</h2>
              </div>
              <p className="mt-1 truncate text-xs text-muted">{graph?.goal.title ?? t("workspaceTaskGraphLoading")}</p>
              {graph?.goal.description && <p className="mt-1 max-w-3xl text-[10px] leading-4 text-faint">{graph.goal.description}</p>}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <button type="button" onClick={onOpenBlueprint} className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[10px] text-muted hover:border-accent hover:text-accent"><Blueprint size={13} />{t("workspaceOpenBlueprint")}</button>
              <button type="button" onClick={() => void split()} disabled={busy !== null || loading} className="rounded-md border border-line px-2.5 py-1.5 text-[10px] text-muted hover:border-accent hover:text-accent disabled:opacity-40">{busy === "split" ? t("decomposing") : drafts.length ? t("reDecompose") : t("decompose")}</button>
              <button type="button" onClick={() => void save()} disabled={!dirty || busy !== null || loading} className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[10px] font-semibold text-white hover:bg-accent-hover disabled:opacity-40"><FloppyDisk size={13} />{busy === "save" ? t("workspaceTaskGraphSaving") : t("workspaceTaskGraphSave")}</button>
              <button ref={closeRef} type="button" onClick={onClose} aria-label={t("close")} className="rounded p-1.5 text-faint hover:bg-fg/5 hover:text-fg"><X size={17} /></button>
            </div>
          </header>

          {error && <div role="alert" aria-live="assertive" className="shrink-0 border-b border-danger/30 bg-danger/10 px-5 py-2 text-[10px] text-danger">{error}</div>}

          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-3 sm:p-5">
            {loading ? (
              <div role="status" aria-live="polite" className="flex h-56 items-center justify-center gap-2 text-xs text-muted"><CircleNotch size={18} className="animate-spin" />{t("workspaceTaskGraphLoading")}</div>
            ) : (
              <>
                <section className="rounded-lg border border-line-soft bg-elevated p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-[11px] font-semibold text-fg">{t("workspaceTaskGraphPlanSummary")}</h3>
                    {graph?.plan && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[9px] text-accent">{t(`workspaceTaskGraphPlanStatus_${graph.plan.status}`)}</span>}
                  </div>
                  {graph?.plan ? (
                    <div className="mt-2 grid gap-3 lg:grid-cols-[1.4fr_1fr]">
                      <p className="text-[10px] leading-5 text-muted">{graph.plan.scope || t("workspaceTaskGraphNoScope")}</p>
                      <div>
                        <div className="text-[9px] font-semibold uppercase tracking-wider text-faint">{t("workspaceTaskGraphAcceptance")}</div>
                        <ul className="mt-1 space-y-1 text-[9px] leading-4 text-muted">
                          {graph.plan.acceptance_criteria.slice(0, 4).map((item) => <li key={item}>• {item}</li>)}
                        </ul>
                      </div>
                    </div>
                  ) : (
                    <button type="button" onClick={onOpenBlueprint} className="mt-2 text-[10px] text-accent hover:underline">{t("workspaceTaskGraphNoPlan")}</button>
                  )}
                </section>

                <section className="mt-4">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-[11px] font-semibold text-fg">{t("workspaceTaskGraphOrder")}</h3>
                    <span className="font-mono text-[9px] text-faint">{t("workspaceTaskGraphCount", { count: drafts.length })}</span>
                  </div>
                  <div className="space-y-2">
                    {drafts.map((task, index) => {
                      const state = deriveState(task, drafts);
                      const blockedBy = task.depends_on.filter((dependencyId) => drafts.find((item) => item.id === dependencyId)?.status !== "done");
                      const originalStatus = graph?.tasks.find((item) => item.id === task.id)?.status ?? task.status;
                      return (
                        <article key={task.id} className="rounded-lg border border-line-soft bg-elevated p-3">
                          <div className="grid gap-3 lg:grid-cols-[54px_minmax(0,1fr)_180px_170px]">
                            <div className="flex flex-col items-center gap-1">
                              <span className="font-mono text-[10px] text-faint">{String(index + 1).padStart(2, "0")}</span>
                              <div className="flex items-center gap-0.5">
                                <button type="button" aria-label={t("workspaceTaskGraphMoveUp", { task: task.title })} onClick={() => move(task.id, -1)} disabled={index === 0} className="rounded p-1 text-faint hover:bg-fg/5 hover:text-fg disabled:opacity-20"><ArrowUp size={12} /></button>
                                <button type="button" aria-label={t("workspaceTaskGraphMoveDown", { task: task.title })} onClick={() => move(task.id, 1)} disabled={index === drafts.length - 1} className="rounded p-1 text-faint hover:bg-fg/5 hover:text-fg disabled:opacity-20"><ArrowDown size={12} /></button>
                              </div>
                            </div>
                            <div className="min-w-0">
                              <label className="block text-[9px] font-medium text-faint">
                                {t("workspaceTaskGraphTaskTitle")}
                                <input value={task.title} onChange={(event) => updateDraft(task.id, { title: event.target.value })} className="mt-1 w-full rounded border border-line bg-sunken px-2.5 py-1.5 text-[11px] text-fg outline-none focus:border-accent" />
                              </label>
                              <label className="mt-2 block text-[9px] font-medium text-faint">
                                {t("workspaceTaskGraphDescription")}
                                <textarea value={task.description} onChange={(event) => updateDraft(task.id, { description: event.target.value })} rows={2} className="mt-1 w-full resize-y rounded border border-line bg-sunken px-2.5 py-1.5 text-[10px] leading-4 text-muted outline-none focus:border-accent" />
                              </label>
                            </div>
                            <div className="space-y-2">
                              <label className="block text-[9px] font-medium text-faint">
                                {t("workspaceTaskGraphAssignee")}
                                <select value={task.assignee_id ?? ""} onChange={(event) => updateDraft(task.id, { assignee_id: event.target.value || null })} className="mt-1 w-full rounded border border-line bg-sunken px-2 py-1.5 text-[10px] text-fg outline-none focus:border-accent">
                                  <option value="">{t("workspaceUnassigned")}</option>
                                  {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.role}</option>)}
                                </select>
                              </label>
                              <label className="block text-[9px] font-medium text-faint">
                                {t("workspaceTaskGraphStatus")}
                                <select value={task.status} onChange={(event) => updateDraft(task.id, { status: event.target.value })} className="mt-1 w-full rounded border border-line bg-sunken px-2 py-1.5 text-[10px] text-fg outline-none focus:border-accent">
                                  {(STATUS_TRANSITIONS[originalStatus] ?? [originalStatus]).map((status) => <option key={status} value={status}>{t(`taskStatus_${status}`)}</option>)}
                                </select>
                              </label>
                            </div>
                            <div>
                              <label className="block text-[9px] font-medium text-faint">
                                {t("workspaceTaskGraphDependencies")}
                                <select
                                  multiple
                                  value={task.depends_on}
                                  onChange={(event) => updateDraft(task.id, { depends_on: Array.from(event.target.selectedOptions, (option) => option.value) })}
                                  className="mt-1 h-[76px] w-full rounded border border-line bg-sunken px-2 py-1 text-[9px] text-fg outline-none focus:border-accent"
                                >
                                  {drafts.filter((candidate) => candidate.id !== task.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
                                </select>
                              </label>
                              <div className="mt-2 flex items-center gap-1.5 text-[9px]">
                                {stateIcon(state)}
                                <span className={state === "blocked" ? "text-warning" : state === "ready" || state === "complete" ? "text-success" : "text-accent"}>{t(`workspaceTaskGraphState_${state}`)}</span>
                              </div>
                              {blockedBy.length > 0 && <p className="mt-1 text-[8px] leading-3 text-faint">{t("workspaceTaskGraphWaitingFor", { tasks: blockedBy.map((id) => drafts.find((item) => item.id === id)?.title ?? id).join(", ") })}</p>}
                            </div>
                          </div>
                        </article>
                      );
                    })}
                    {drafts.length === 0 && (
                      <div className="rounded-lg border border-dashed border-line p-8 text-center">
                        <WarningCircle size={24} weight="duotone" className="mx-auto text-faint" />
                        <p className="mt-2 text-[10px] text-muted">{t("workspaceNoTasksHint")}</p>
                        <button type="button" onClick={() => void split()} className="mt-3 rounded-md bg-accent px-3 py-1.5 text-[10px] font-semibold text-white">{t("decompose")}</button>
                      </div>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>
        </section>
      </div>

      {confirmSplit && <div className="relative z-[80]"><ConfirmDialog message={t("reDecomposeConfirm", { count: drafts.length })} onConfirm={() => void split()} onCancel={() => setConfirmSplit(false)} /></div>}
    </>
  );
}
