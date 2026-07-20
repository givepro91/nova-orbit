import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../stores/useStore";
import { ApiError, api, guardMutation, type WorkReport } from "../lib/api";

import { TaskTimeline } from "./TaskTimeline";
import { OrgChart, parseActivity, getCtoPhase } from "./OrgChart";
import { AgentDetail } from "./AgentDetail";
import { SummonChat } from "./SummonChat";
import { SessionWorkspace } from "./SessionWorkspace";
import { HelpGuide } from "./HelpGuide";
import { TaskList } from "./TaskList";
import { VerificationLog } from "./VerificationLog";
import { ActivityFeed } from "./ActivityFeed";
import { AddAgentDialog } from "./AddAgentDialog";
import { KanbanBoard } from "./KanbanBoard";
import { ProjectSettings } from "./ProjectSettings";
import { SessionList } from "./SessionList";
import { InputDialog } from "./InputDialog";
import { useToast } from "../stores/useToast";
import { WelcomeGuide } from "./WelcomeGuide";
import { ProjectStats } from "./ProjectStats";
import { AutopilotModal } from "./AutopilotModal";
import GoalSpecPanel from "./GoalSpecPanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { GoalSquashApprovalDialog } from "./GoalSquashApprovalDialog";
import { GoalDetail } from "./GoalDetail";
import { GoalReports } from "./GoalReports";

type Tab = "overview" | "agents" | "kanban" | "verification" | "reports" | "sessions" | "settings";

// 역할별 아이콘 + 소프트 컬러 — 에이전트 팀 프레즌스 패널에서 한눈에 역할 구분
const AGENT_ROLE_META: Record<string, { icon: string; tone: string }> = {
  cto: { icon: "🧭", tone: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300" },
  pm: { icon: "📋", tone: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300" },
  backend: { icon: "⚙️", tone: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
  frontend: { icon: "🎨", tone: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300" },
  ux: { icon: "✨", tone: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300" },
  qa: { icon: "🔍", tone: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" },
  reviewer: { icon: "🛡️", tone: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300" },
  devops: { icon: "🚀", tone: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300" },
  marketer: { icon: "📣", tone: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300" },
  coder: { icon: "⚙️", tone: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
  designer: { icon: "🎨", tone: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300" },
};
const roleMeta = (role: string) =>
  AGENT_ROLE_META[role] ?? { icon: "🤖", tone: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300" };

// ─── AddGoalDialog ───────────────────────────────────
type Suggestion = { title: string; description: string; priority: string; reason: string };

export function AddGoalDialog({
  onCreateDirect,
  onCreateWithSpec,
  onCancel,
  suggestions,
  suggestLoading,
  suggestError,
  suggestErrorDetail,
  onStartSuggest,
  onDismissSuggestions,
}: {
  onCreateDirect: (title: string, description: string, acceptanceScript?: string, skipAdversarial?: boolean, sourceMaterial?: string) => void;
  onCreateWithSpec: (title: string, description: string, acceptanceScript?: string, skipAdversarial?: boolean) => void;
  onCancel: () => void;
  suggestions: Suggestion[];
  suggestLoading: boolean;
  suggestError: string;
  suggestErrorDetail: string;
  onStartSuggest: (count?: number, material?: string) => void;
  onDismissSuggestions: () => void;
}) {
  const { t } = useTranslation();
  // Auto-select mode based on whether we have suggestion results
  const hasSuggestState = suggestLoading || suggestError || suggestions.length > 0;
  const [mode, setMode] = useState<"material" | "input" | "suggest">(hasSuggestState ? "suggest" : "material");
  const [sourceMaterial, setSourceMaterial] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const materialFileRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acceptanceScript, setAcceptanceScript] = useState("");
  const [skipAdversarial, setSkipAdversarial] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [suggestCount, setSuggestCount] = useState(3);

  useEffect(() => { if (mode === "input") inputRef.current?.focus(); }, [mode]);

  // Sync mode when suggestion state changes (e.g., results arrive while dialog open)
  useEffect(() => {
    if (suggestions.length > 0 || suggestError) setMode("suggest");
  }, [suggestions, suggestError]);

  const handleSubmit = (submitMode: "direct" | "spec") => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    const script = acceptanceScript.trim() || undefined;
    if (submitMode === "spec") {
      onCreateWithSpec(title.trim(), description.trim(), script, skipAdversarial || undefined);
    } else {
      onCreateDirect(title.trim(), description.trim(), script, skipAdversarial || undefined);
    }
  };

  const handleSuggest = () => {
    setMode("suggest");
    onStartSuggest(suggestCount);
  };

  const handleAnalyzeMaterial = () => {
    if (!sourceMaterial.trim() || submitting) return;
    setMode("suggest");
    // 자료 기반: AI가 문서 규모에 따라 1~N개로 분해 (최대 6개 상한 힌트)
    onStartSuggest(6, sourceMaterial.trim());
  };

  // 드래그앤드롭/파일선택으로 .md·텍스트 파일 적재 → 기존 내용에 이어붙임
  const handleMaterialFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const parts: string[] = [];
    for (const f of Array.from(files)) {
      const okExt = /\.(md|markdown|mdx|txt|text)$/i.test(f.name);
      if (!okExt && !(f.type && f.type.startsWith("text/"))) continue;
      try {
        const content = (await f.text()).slice(0, 20000);
        parts.push(files.length > 1 ? `<!-- ${f.name} -->\n${content}` : content);
      } catch { /* skip unreadable */ }
    }
    if (parts.length === 0) return;
    const joined = parts.join("\n\n");
    setSourceMaterial((prev) => (prev.trim() ? `${prev.trim()}\n\n${joined}` : joined));
  };

  const toggleSelect = (idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const handleAddSelected = async () => {
    if (selected.size === 0 || submitting) return;
    setSubmitting(true);
    // Resolve selected indices to suggestion objects, dropping any stale index.
    // `suggestions` is reactive (it swaps on re-render / project switch), so a
    // selected index can point past the current array. An undefined entry would
    // throw on `.title` below, abort the whole loop, and lose every selected goal
    // with zero feedback — the parallel multi-project "goal 유실" repro.
    const selectedGoals = [...selected].map((i) => suggestions[i]).filter(Boolean);
    const script = acceptanceScript.trim() || undefined;
    // Always use direct creation — autopilot scheduler handles spec→decompose
    // sequentially in priority/sort_order. No need for client-side spec trigger.
    try {
      for (const goal of selectedGoals) {
        await onCreateDirect(goal.title, goal.description, script, skipAdversarial || undefined, sourceMaterial.trim() || undefined);
      }
    } catch {
      // Per-goal failures are surfaced by onCreateDirect's own error toast; swallow
      // here so one rejection can't crash the handler or wedge the dialog.
    } finally {
      // Never leave the dialog stuck in a submitting state.
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/20 dark:bg-black/50 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        className="bg-surface rounded-xl shadow-lg w-[560px] max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 space-y-3 flex-1 overflow-y-auto">
          <h3 className="text-sm font-semibold text-fg">
            {t("addGoalTitle")}
          </h3>

          {mode !== "suggest" && (
            <div className="flex gap-1 p-0.5 bg-sunken rounded-lg">
              <button
                onClick={() => setMode("material")}
                className={`flex-1 text-[11px] py-1.5 rounded-md transition-colors ${mode === "material" ? "bg-surface text-fg font-medium shadow-sm" : "text-muted"}`}
              >
                {t("addGoalModeMaterial")}
              </button>
              <button
                onClick={() => setMode("input")}
                className={`flex-1 text-[11px] py-1.5 rounded-md transition-colors ${mode === "input" ? "bg-surface text-fg font-medium shadow-sm" : "text-muted"}`}
              >
                {t("addGoalModeManual")}
              </button>
            </div>
          )}

          {mode === "material" ? (
            <div className="space-y-2">
              <p className="text-[11px] text-muted">{t("addGoalMaterialHelp")}</p>
              <div
                onDragOver={(e) => { e.preventDefault(); if (!submitting && !isDragging) setIsDragging(true); }}
                onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
                onDrop={(e) => { e.preventDefault(); setIsDragging(false); if (!submitting) handleMaterialFiles(e.dataTransfer.files); }}
                className={`relative rounded-lg ${isDragging ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : ""}`}
              >
                <textarea
                  autoFocus
                  value={sourceMaterial}
                  onChange={(e) => setSourceMaterial(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
                  placeholder={t("addGoalMaterialPlaceholder")}
                  disabled={submitting}
                  rows={12}
                  className="w-full px-3 py-2 text-xs border border-line rounded-lg bg-sunken text-fg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50 resize-y font-mono leading-relaxed"
                />
                {isDragging && (
                  <div className="absolute inset-0 flex items-center justify-center bg-accent/10 rounded-lg pointer-events-none text-xs font-medium text-accent">
                    {t("addGoalMaterialDrop")}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  ref={materialFileRef}
                  type="file"
                  accept=".md,.markdown,.mdx,.txt,text/markdown,text/plain"
                  multiple
                  className="hidden"
                  onChange={(e) => { handleMaterialFiles(e.target.files); e.target.value = ""; }}
                />
                <button
                  type="button"
                  onClick={() => materialFileRef.current?.click()}
                  disabled={submitting}
                  className="text-[11px] text-accent hover:text-accent-hover disabled:opacity-40"
                >
                  {t("addGoalMaterialChooseFile")}
                </button>
                {sourceMaterial.trim() && (
                  <span className="text-[10px] text-faint ml-auto">
                    {t("addGoalMaterialChars", { n: sourceMaterial.length.toLocaleString() })}
                  </span>
                )}
              </div>
            </div>
          ) : mode === "input" ? (
            <>
              <input
                ref={inputRef}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && title.trim() && !description) handleSubmit("direct");
                  if (e.key === "Escape") onCancel();
                }}
                placeholder={t("promptGoalTitleHint")}
                disabled={submitting}
                className="w-full px-3 py-2 text-sm border border-line rounded-lg bg-sunken text-fg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50"
              />
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") onCancel();
                }}
                placeholder={t("promptGoalDescHint")}
                disabled={submitting}
                rows={3}
                className="w-full px-3 py-2 text-sm border border-line rounded-lg bg-sunken text-fg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50 resize-none"
              />
              <p className="text-[11px] text-faint">{t("goalDescHelp")}</p>
              <div>
                <label className="text-[11px] font-medium text-muted mb-1 block">
                  {t("acceptanceScriptLabel")}
                </label>
                <textarea
                  value={acceptanceScript}
                  onChange={(e) => setAcceptanceScript(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
                  placeholder={t("acceptanceScriptPlaceholder")}
                  disabled={submitting}
                  rows={2}
                  className="w-full px-3 py-2 text-xs border border-line rounded-lg bg-sunken text-fg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50 resize-none font-mono"
                />
                <p className="text-[11px] text-faint mt-0.5">{t("acceptanceScriptHelp")}</p>
              </div>
              <label className="flex items-start gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={skipAdversarial}
                  onChange={(e) => setSkipAdversarial(e.target.checked)}
                  disabled={submitting}
                  className="mt-0.5 accent-accent"
                />
                <span>
                  <span className="text-[11px] font-medium text-muted block">
                    {t("skipAdversarialLabel")}
                  </span>
                  <span className="text-[11px] text-faint">{t("skipAdversarialHelp")}</span>
                </span>
              </label>
            </>
          ) : (
            <div className="space-y-2">
              {suggestLoading ? (
                <div className="flex flex-col items-center justify-center py-8 gap-3">
                  <svg className="animate-spin w-6 h-6 text-accent" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  <p className="text-xs text-muted">{t("addGoalAiSuggestLoading")}</p>
                </div>
              ) : suggestError ? (
                <div className="text-center py-6 space-y-2">
                  <p className="text-xs text-danger">{suggestError}</p>
                  {suggestErrorDetail && (
                    <pre className="text-[10px] text-danger bg-danger-subtle rounded px-3 py-2 text-left whitespace-pre-wrap break-all max-h-24 overflow-y-auto mx-4">
                      {suggestErrorDetail}
                    </pre>
                  )}
                  <div className="flex justify-center gap-3">
                    <button onClick={handleSuggest} className="text-xs text-accent hover:text-accent-hover">
                      {t("retry")}
                    </button>
                    <button onClick={() => setMode("input")} className="text-xs text-faint hover:text-muted">
                      {t("addGoalCreateDirect")}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-[11px] text-muted font-medium">{t("addGoalAiSuggestSelect")}</p>
                  {suggestions.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => toggleSelect(i)}
                      className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                        selected.has(i)
                          ? "border-accent bg-accent/10"
                          : "border-line hover:border-line"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <div className={`mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center ${
                          selected.has(i)
                            ? "bg-accent border-accent text-white"
                            : "border-line"
                        }`}>
                          {selected.has(i) && (
                            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium text-fg">{s.title}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                              s.priority === "high" ? "bg-danger-subtle text-danger"
                              : s.priority === "low" ? "bg-sunken text-muted"
                              : "bg-warning-subtle text-warning"
                            }`}>{s.priority}</span>
                          </div>
                          <p className="text-[11px] text-muted mt-0.5 line-clamp-2">{s.description}</p>
                          <p className="text-[10px] text-accent mt-1">{s.reason}</p>
                        </div>
                      </div>
                    </button>
                  ))}
                  {/* M-2: AI 추천 경로 acceptance_script 공용 입력 */}
                  <div className="pt-1">
                    <label className="text-[11px] font-medium text-muted mb-1 block">
                      {t("acceptanceScriptLabel")}
                    </label>
                    <textarea
                      value={acceptanceScript}
                      onChange={(e) => setAcceptanceScript(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
                      placeholder={t("acceptanceScriptPlaceholder")}
                      disabled={submitting}
                      rows={2}
                      className="w-full px-3 py-2 text-xs border border-line rounded-lg bg-sunken text-fg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50 resize-none font-mono"
                    />
                    <p className="text-[11px] text-faint mt-0.5">{t("acceptanceScriptHelp")}</p>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-line-soft flex flex-col gap-2">
          {mode === "material" ? (
            <button
              onClick={handleAnalyzeMaterial}
              disabled={!sourceMaterial.trim() || submitting}
              className="w-full text-xs px-4 py-2.5 bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-40 transition-colors font-semibold flex items-center justify-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
              {t("addGoalMaterialAnalyze")}
            </button>
          ) : mode === "input" ? (
            <>
              <button
                onClick={() => handleSubmit("direct")}
                disabled={!title.trim() || submitting}
                className="w-full text-xs px-4 py-2.5 bg-fg text-canvas rounded-lg hover:bg-fg/90 disabled:opacity-40 transition-colors text-left"
              >
                <div className="font-semibold">{t("addGoalCreateDirect")}</div>
                <div className="mt-0.5 opacity-60">{t("addGoalCreateDirectDesc")}</div>
              </button>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-px bg-line" />
                <span className="text-[10px] text-faint">or</span>
                <div className="flex-1 h-px bg-line" />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSuggest}
                  disabled={submitting}
                  className="flex-1 text-xs px-4 py-2.5 border border-accent text-accent rounded-lg hover:bg-accent/20 disabled:opacity-40 transition-colors text-center"
                >
                  <div className="font-semibold flex items-center justify-center gap-1.5">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                    </svg>
                    {t("addGoalAiSuggest")}
                  </div>
                  <div className="mt-0.5 opacity-60">{t("addGoalAiSuggestDesc")}</div>
                </button>
                <select
                  value={suggestCount}
                  onChange={(e) => setSuggestCount(Number(e.target.value))}
                  className="w-14 text-xs border border-accent text-accent rounded-lg bg-sunken focus:outline-none focus:border-accent text-center"
                >
                  {[1, 2, 3, 5].map((n) => (
                    <option key={n} value={n}>{n}{t("addGoalAiSuggestCountUnit")}</option>
                  ))}
                </select>
              </div>
            </>
          ) : !suggestLoading && !suggestError && suggestions.length > 0 ? (
            <>
              {/* withSpec checkbox removed — autopilot handles spec generation sequentially */}
              <button
                onClick={handleAddSelected}
                disabled={selected.size === 0 || submitting}
                className="w-full text-xs px-4 py-2.5 bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-40 transition-colors font-semibold"
              >
                {submitting ? (
                  <div className="flex items-center justify-center gap-2">
                    <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    <span>{t("loading")}</span>
                  </div>
                ) : (
                  `${t("addGoalAiSuggestAddSelected")} (${selected.size})`
                )}
              </button>
            </>
          ) : null}
          {mode === "suggest" && suggestLoading ? (
            /* Loading: close dialog but keep background fetch running */
            <button
              onClick={onCancel}
              className="text-xs text-faint hover:text-muted py-1"
            >
              {t("addGoalAiSuggestMinimize")}
            </button>
          ) : mode === "suggest" && (suggestions.length > 0 || suggestError) ? (
            /* Results: "직접 입력" + "모두 무시" */
            <div className="flex items-center justify-center gap-4">
              <button
                onClick={() => setMode("input")}
                disabled={submitting}
                className="text-xs text-faint hover:text-muted py-1"
              >
                {"← " + t("addGoalCreateDirect")}
              </button>
              <button
                onClick={() => { onDismissSuggestions(); onCancel(); }}
                className="text-xs text-danger hover:text-danger py-1"
              >
                {t("addGoalAiSuggestDismiss")}
              </button>
            </div>
          ) : (
            <button
              onClick={onCancel}
              disabled={submitting}
              className="text-xs text-faint hover:text-muted py-1"
            >
              {t("cancel")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── EditGoalDialog ──────────────────────────────────
function EditGoalDialog({
  goal,
  projectId,
  onSave,
  onCancel,
}: {
  goal: { id: string; title: string; description: string; references: string; goal_model?: string; acceptance_script?: string | null };
  projectId: string;
  onSave: (id: string, title: string, description: string, references: string[], acceptanceScript?: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(goal.title || "");
  const [description, setDescription] = useState(
    goal.title && goal.description !== goal.title ? goal.description : ""
  );
  const [acceptanceScript, setAcceptanceScript] = useState(goal.acceptance_script ?? "");
  const parsedRefs = (() => { try { const r = JSON.parse(goal.references || "[]"); return Array.isArray(r) ? r : []; } catch { return []; } })();
  const [selectedRefs, setSelectedRefs] = useState<string[]>(parsedRefs);
  const [availableDocs, setAvailableDocs] = useState<Array<{ path: string; name: string; dir: string }>>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Load available docs from project
  useEffect(() => {
    api.projects.listDocs(projectId)
      .then((docs) => setAvailableDocs(docs))
      .catch(() => {})
      .finally(() => setDocsLoading(false));
  }, [projectId]);

  const toggleRef = (path: string) => {
    setSelectedRefs((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  };

  const handleSave = () => {
    if (!title.trim()) return;
    const script = acceptanceScript.trim() || undefined;
    onSave(goal.id, title.trim(), description.trim(), selectedRefs, script);
  };

  // Group docs by directory
  const groupedDocs = useMemo(() => {
    const groups: Record<string, typeof availableDocs> = {};
    for (const doc of availableDocs) {
      const key = doc.dir || "/";
      if (!groups[key]) groups[key] = [];
      groups[key].push(doc);
    }
    // Root first, then alphabetical
    const sorted: [string, typeof availableDocs][] = [];
    if (groups["/"]) { sorted.push(["/", groups["/"]]); delete groups["/"]; }
    sorted.push(...Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)));
    return sorted;
  }, [availableDocs]);

  return (
    <div
      className="fixed inset-0 bg-black/20 dark:bg-black/50 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        className="bg-surface rounded-xl shadow-lg w-[560px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 space-y-3 overflow-y-auto flex-1">
          <h3 className="text-sm font-semibold text-fg">
            {t("editGoal")}
          </h3>
          <div>
            <label className="text-[11px] font-medium text-muted mb-1 block">{t("goalTitleLabel")}</label>
            <input
              ref={inputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && title.trim()) handleSave();
                if (e.key === "Escape") onCancel();
              }}
              placeholder={t("promptGoalTitleHint")}
              className="w-full px-3 py-2 text-sm border border-line rounded-lg bg-sunken text-fg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted mb-1 block">{t("goalDescLabel")}</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
              placeholder={t("promptGoalDescHint")}
              rows={5}
              className="w-full px-3 py-2 text-sm border border-line rounded-lg bg-sunken text-fg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent resize-none"
            />
            <p className="text-[11px] text-faint mt-1">{t("goalDescHelp")}</p>
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted mb-1 block">
              {t("goalRefsLabel")} {selectedRefs.length > 0 && <span className="text-accent">({selectedRefs.length})</span>}
            </label>
            <p className="text-[11px] text-faint mb-1.5">{t("goalRefsHelp")}</p>
            {docsLoading ? (
              <div className="text-xs text-faint py-2">{t("loading")}</div>
            ) : availableDocs.length === 0 ? (
              <div className="text-xs text-faint py-2 border border-dashed border-line rounded-lg text-center">
                {t("noDocsFound")}
              </div>
            ) : (
              <div className="border border-line rounded-lg max-h-[180px] overflow-y-auto">
                {groupedDocs.map(([dir, docs]) => (
                  <div key={dir}>
                    <div className="px-3 py-1 text-[10px] font-medium text-faint bg-sunken sticky top-0">
                      {dir === "/" ? t("goalRefsRoot") : `${dir}/`}
                    </div>
                    {docs.map((doc) => (
                      <label
                        key={doc.path}
                        className="flex items-center gap-2 px-3 py-1.5 hover:bg-fg/5 cursor-pointer transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={selectedRefs.includes(doc.path)}
                          onChange={() => toggleRef(doc.path)}
                          className="w-3.5 h-3.5 rounded border-line text-accent focus:ring-accent focus:ring-1"
                        />
                        <span className="text-xs text-muted truncate">{doc.name}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          {goal.goal_model === "goal_as_unit" && (
            <div>
              <label className="text-[11px] font-medium text-muted mb-1 block">
                {t("acceptanceScriptLabel")}
              </label>
              <textarea
                value={acceptanceScript}
                onChange={(e) => setAcceptanceScript(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
                placeholder={t("acceptanceScriptPlaceholder")}
                rows={2}
                className="w-full px-3 py-2 text-xs border border-line rounded-lg bg-sunken text-fg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent resize-none font-mono"
              />
              <p className="text-[11px] text-faint mt-0.5">{t("acceptanceScriptHelp")}</p>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-line-soft flex justify-end gap-2 shrink-0">
          <button
            onClick={onCancel}
            className="text-xs px-4 py-2 text-muted hover:text-muted"
          >
            {t("cancel")}
          </button>
          <button
            onClick={handleSave}
            disabled={!title.trim()}
            className="text-xs px-4 py-2 bg-fg text-canvas rounded-lg hover:bg-fg/90 disabled:opacity-40 transition-colors"
          >
            {t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProjectHome() {
  const { t } = useTranslation();
  const { currentProjectId, projects, agents, setAgents, goals, setGoals, tasks, setTasks, updateProject, updateGoal } =
    useStore();
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [addAgentSmart, setAddAgentSmart] = useState(false);
  const [duplicateTeamConfirm, setDuplicateTeamConfirm] = useState(false);
  const [duplicatingTeam, setDuplicatingTeam] = useState(false);
  // AI 팀 설계 진행 상태 — 새로고침/모달 이탈 후에도 진행 중·미확인 결과를 칩으로 표시
  const [teamDesign, setTeamDesign] = useState<"running" | "ready" | null>(null);
  // 관리(설정) 패널 — 대화 모달의 ⚙ 또는 조직도 "상세 열기"로 연다.
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  // 소환/대화(⚡·💬): 대화 집중 모달. taskId 있으면 작업 공간·판정·최근 출력이 주입된다(일반 대화면 null).
  const [chat, setChat] = useState<{ agentId: string; taskId: string | null } | null>(null);
  // 워크스페이스(⤢): Orca형 탐색 / 로컬 PTY / Crewdeck 인스펙터.
  const [workspace, setWorkspace] = useState<{
    workspaceId?: string | null;
    workspaceName?: string;
    worktreeBranch?: string | null;
    agentId?: string | null;
    agentName?: string;
    goalId: string | null;
    taskId: string | null;
  } | null>(null);
  // 웹 세션 워크스페이스 도움말 모달 — 어디서든 crewdeck:open-help로 연다.
  const [helpOpen, setHelpOpen] = useState(false);

  // AI 팀 설계 상태 복원(새로고침 대비) + 실시간 반영(WS)
  useEffect(() => {
    if (!currentProjectId) return;
    setTeamDesign(null);
    api.agents.designStatus(currentProjectId)
      .then((s) => setTeamDesign(s.running ? "running" : s.ready ? "ready" : null))
      .catch(() => { /* 서버 미지원/오류 시 칩 없음 */ });

    const onDesignStatus = (e: Event) => {
      const d = (e as CustomEvent).detail as { projectId?: string; state?: string } | undefined;
      if (!d || d.projectId !== currentProjectId) return;
      if (d.state === "failed") {
        setTeamDesign(null);
        useToast.getState().showToast(t("teamDesignFailed"), "error");
      } else if (d.state === "running" || d.state === "ready") {
        setTeamDesign(d.state);
      }
    };
    window.addEventListener("crewdeck:team-design-status", onDesignStatus);
    return () => window.removeEventListener("crewdeck:team-design-status", onDesignStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId]);

  // Header mission inline edit state
  const [editingHeaderMission, setEditingHeaderMission] = useState(false);
  const [headerMissionDraft, setHeaderMissionDraft] = useState("");
  const [savingMission, setSavingMission] = useState(false);

  // Queue state
  const [queueRunning, setQueueRunning] = useState(false);
  const [queueConcurrency, setQueueConcurrency] = useState(0);
  const [queuePaused, setQueuePaused] = useState(false);
  const [queuePausedInfo, setQueuePausedInfo] = useState<{
    nextRetryAt: string | null;
    retryNumber: number;
    maxRetries: number;
    reason?: string;        // "rate_limit" | "rate_limit_cooldown"
    backoffMs?: number;
  } | null>(null);
  const [queueStoppedByRateLimit, setQueueStoppedByRateLimit] = useState(false);
  // Countdown re-render tick — nextRetryAt is absolute, but we need the
  // visible label to decrement without reloading the whole page.
  const [countdownTick, setCountdownTick] = useState(0);

  // Autopilot state
  const [autopilotMode, setAutopilotMode] = useState<"off" | "goal" | "full">("off");
  const [autopilotChanging, setAutopilotChanging] = useState(false);
  const [showAutopilotModal, setShowAutopilotModal] = useState(false);

  // Dialog / toast state
  const [showDialog, setShowDialog] = useState<"addGoal" | "addTask" | null>(null);
  const [addTaskGoalId, setAddTaskGoalId] = useState<string | null>(null);

  // Goal search (#13)
  const [goalSearch, setGoalSearch] = useState("");

  // AI Goal Suggestion — lifted from AddGoalDialog for background persistence
  type Suggestion = { title: string; description: string; priority: string; reason: string };
  // 프로젝트별로 독립 보유 — 한 프로젝트에서 추천을 돌려도 다른 프로젝트의
  // 준비된(아직 추가 안 한) 제안이 덮이지 않도록 projectId 키 맵으로 관리한다.
  type SuggestState = { suggestions: Suggestion[]; loading: boolean; error: string; errorDetail: string };
  const [aiSuggestByProject, setAiSuggestByProject] = useState<Record<string, SuggestState>>({});

  const startAiSuggest = useCallback(async (count?: number, material?: string) => {
    // pid를 호출 시점에 캡처 — 완료 시 사용자가 다른 프로젝트로 옮겨가도 결과는 원래 슬롯에 안착.
    const pid = currentProjectId;
    if (!pid || aiSuggestByProject[pid]?.loading) return;
    setAiSuggestByProject((prev) => ({ ...prev, [pid]: { suggestions: [], loading: true, error: "", errorDetail: "" } }));
    try {
      const result = await api.goals.suggest(pid, count, material);
      setAiSuggestByProject((prev) => ({
        ...prev,
        [pid]: {
          suggestions: result.length === 0 ? [] : result,
          loading: false,
          error: result.length === 0 ? t("addGoalAiSuggestEmpty") : "",
          errorDetail: "",
        },
      }));
    } catch (err: any) {
      setAiSuggestByProject((prev) => ({
        ...prev,
        [pid]: { suggestions: [], loading: false, error: err.message || t("addGoalAiSuggestError"), errorDetail: err.detail || "" },
      }));
    }
  }, [currentProjectId, aiSuggestByProject, t]);

  const dismissAiSuggestions = useCallback(() => {
    const pid = currentProjectId;
    if (!pid) return;
    setAiSuggestByProject((prev) => {
      if (!prev[pid]) return prev;
      const next = { ...prev };
      delete next[pid];
      return next;
    });
  }, [currentProjectId]);
  // toast state removed — using global useToast store
  const [decomposingGoalId, setDecomposingGoalId] = useState<string | null>(null);
  const [reDecomposeGoalId, setReDecomposeGoalId] = useState<string | null>(null);
  const [deleteGoalId, setDeleteGoalId] = useState<string | null>(null);
  const [queueToggling, setQueueToggling] = useState(false);
  const [goalMenuOpenId, setGoalMenuOpenId] = useState<string | null>(null);

  // Spec generation tracking (goal IDs currently generating)
  const [generatingSpecGoalIds, setGeneratingSpecGoalIds] = useState<Set<string>>(new Set());

  // Goals 접기 상태
  const [showCompletedGoals, setShowCompletedGoals] = useState(false);
  const COMPLETED_GOALS_THRESHOLD = 3;
  const AGENT_IDLE_CAP = 16;

  // Goal edit state
  const [editGoalId, setEditGoalId] = useState<string | null>(null);
  const [expandedGoalDescs, setExpandedGoalDescs] = useState<Set<string>>(new Set());
  // goal 카드의 진행 상세(GoalDetail: 상태+품질 타임라인+활동) 기본 접힘 — overview 스크롤 절감
  const [expandedGoalDetails, setExpandedGoalDetails] = useState<Set<string>>(new Set());

  // Goal Spec state
  const [specGoalId, setSpecGoalId] = useState<string | null>(null);

  // Goal-as-Unit squash state
  const [squashApprovalGoalId, setSquashApprovalGoalId] = useState<string | null>(null);
  const [refreshingPrGoalId, setRefreshingPrGoalId] = useState<string | null>(null);
  const [isApproving, setIsApproving] = useState(false);
  const [squashPayloadByGoalId, setSquashPayloadByGoalId] = useState<
    Record<string, { commitMessage?: string; filesChanged?: string[]; acceptanceOutput?: string; workReport?: WorkReport | null; skippedTasks?: Array<{ id: string; title: string; skip_reason?: string | null }> }>
  >({});

  // Direct prompt state (side panel)
  const [panelPromptMessage, setPanelPromptMessage] = useState("");
  const [panelPromptAgentId, setPanelPromptAgentId] = useState<string>("");
  const [panelPromptSending, setPanelPromptSending] = useState(false);
  const [panelPromptToast, setPanelPromptToast] = useState<string | null>(null);

  // Full autopilot status (from WebSocket)
  const [fullAutopilotStatus, setFullAutopilotStatus] = useState<{
    phase: string; currentGoalIndex: number; totalGoals: number; message: string; goalId?: string;
  } | null>(null);

  // Multi-agent prompt state
  const [multiAgentMode, setMultiAgentMode] = useState(false);
  const [multiAgentIds, setMultiAgentIds] = useState<string[]>([]);
  const [multiPromptProgress, setMultiPromptProgress] = useState<{ current: number; total: number } | null>(null);
  const [multiPromptResults, setMultiPromptResults] = useState<{ agentId: string; agentName: string; result: string }[]>([]);

  // GitHub 연동 상태 — 실제 git origin remote 기준(source 문자열이 아니라). 프로젝트 전환 시 조회.
  const [gitRemote, setGitRemote] = useState<{ isGitHub: boolean; repo: string | null } | null>(null);
  // 열린 PR 목록 — "아직 main에 반영 안 됨" 신호. GitHub origin일 때만 조회.
  const [openPrs, setOpenPrs] = useState<{ number: number; title: string; url: string; isDraft: boolean; author: string; updatedAt: string }[] | null>(null);
  const [prsLoading, setPrsLoading] = useState(false);
  const [showPrList, setShowPrList] = useState(false);

  const project = projects.find((p) => p.id === currentProjectId);

  // AI 제안 상태는 현재 프로젝트 슬롯에서만 도출 — 각 프로젝트가 독립 보유하므로 누수·덮어쓰기 없음
  const curSuggest = currentProjectId ? aiSuggestByProject[currentProjectId] : undefined;
  const visibleSuggestions = curSuggest?.suggestions ?? [];
  const visibleSuggestLoading = curSuggest?.loading ?? false;
  const visibleSuggestError = curSuggest?.error ?? "";
  const visibleSuggestErrorDetail = curSuggest?.errorDetail ?? "";

  const specPollRefs = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  // loadData 요청 세대 — 늦게 도착한 구세대 응답을 폐기하는 stale guard용
  const loadGenRef = useRef(0);

  const { showToast } = useToast();

  // 프로젝트 전환 시 GitHub origin 연동 여부 조회 → GitHub면 열린 PR 목록도 조회(gh, 수 초)
  useEffect(() => {
    if (!currentProjectId) { setGitRemote(null); setOpenPrs(null); return; }
    let cancelled = false;
    setOpenPrs(null); setShowPrList(false);
    api.projects.gitRemote(currentProjectId)
      .then((r) => {
        if (cancelled) return;
        setGitRemote({ isGitHub: r.isGitHub, repo: r.repo });
        if (r.isGitHub) {
          setPrsLoading(true);
          api.projects.pullRequests(currentProjectId)
            .then((d) => { if (!cancelled) setOpenPrs(d.pullRequests); })
            .catch(() => { if (!cancelled) setOpenPrs([]); })
            .finally(() => { if (!cancelled) setPrsLoading(false); });
        }
      })
      .catch(() => { if (!cancelled) { setGitRemote(null); setOpenPrs(null); } });
    return () => { cancelled = true; };
  }, [currentProjectId]);

  const loadData = useCallback(() => {
    // stale guard: 프로젝트 전환·연속 refresh 중 늦게 도착한 구세대 응답이
    // 최신 상태를 덮지 않도록 요청 세대를 기록하고, 응답 시 최신이 아니면 폐기.
    const gen = ++loadGenRef.current;
    // 선택된 프로젝트가 없으면 로딩을 풀어 빈 상태(WelcomeGuide)를 렌더한다.
    // (안 풀면 loading=true가 유지돼 스켈레톤에 영원히 갇힌다 — 프로젝트 0개 fresh DB 버그)
    if (!currentProjectId) {
      setLoading(false);
      return;
    }
    Promise.all([
      api.agents.list(currentProjectId),
      api.goals.list(currentProjectId),
      api.tasks.list(currentProjectId),
      api.orchestration.queueStatus(currentProjectId).catch(() => ({ running: false, paused: false, maxConcurrency: 0, rateLimitRetries: 0, nextRetryAt: null as string | null })),
    ]).then(([a, g, t, qs]) => {
      if (gen !== loadGenRef.current) return; // 구세대 응답 — 폐기
      setAgents(a);
      setGoals(g);
      setTasks(t);
      setQueueRunning(qs.running);
      setQueueConcurrency(qs.maxConcurrency ?? 0);
      setQueuePaused(qs.paused ?? false);
      if (qs.paused && qs.nextRetryAt) {
        setQueuePausedInfo({
          nextRetryAt: qs.nextRetryAt,
          retryNumber: qs.rateLimitRetries ?? 0,
          maxRetries: 3,
        });
      } else {
        setQueuePausedInfo(null);
      }
      setLoading(false);
    }).catch(() => {
      if (gen !== loadGenRef.current) return; // 구세대 응답 — 폐기
      // 로드 실패 시에도 스켈레톤에 갇히지 않게 로딩 해제
      setLoading(false);
    });
  }, [currentProjectId, setAgents, setGoals, setTasks]);

  useEffect(() => {
    setLoading(true);
    loadData();
  }, [loadData]);

  // Sync autopilot mode from project data
  useEffect(() => {
    if (project) {
      setAutopilotMode((project as any).autopilot ?? "off");
    }
  }, [project]);

  // Resume spec polling for goals that are still generating (survives page refresh)
  useEffect(() => {
    for (const goal of goals) {
      if ((goal as any).spec_status === "generating" && !specPollRefs.current.has(goal.id)) {
        startSpecPolling(goal.id);
      }
    }
  // Only run when goals array reference changes (initial load / refresh)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goals]);

  // Listen for WebSocket refresh events
  useEffect(() => {
    const handler = (e: Event) => {
      // 다른 프로젝트로 스코프된 refresh는 스킵 — 현 프로젝트 데이터와 무관
      const scoped = (e as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (scoped && currentProjectId && scoped !== currentProjectId) return;
      loadData();
    };
    window.addEventListener("crewdeck:refresh", handler);
    return () => window.removeEventListener("crewdeck:refresh", handler);
  }, [loadData, currentProjectId]);

  // Listen for queue pause/resume/stop events
  useEffect(() => {
    const onPaused = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setQueuePaused(true);
      setQueuePausedInfo({
        nextRetryAt: detail.nextRetryAt,
        retryNumber: detail.retryNumber,
        maxRetries: detail.maxRetries,
        reason: detail.reason,
        backoffMs: detail.backoffMs,
      });
    };
    const onResumed = () => {
      setQueuePaused(false);
      setQueuePausedInfo(null);
      useToast.getState().showToast(t("rateLimitResumed"), "success");
    };
    const onStopped = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setQueueRunning(false);
      setQueuePaused(false);
      setQueuePausedInfo(null);
      setQueueStoppedByRateLimit(detail?.reason === "rate_limit_exceeded");
    };
    const onAutopilotChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.projectId === currentProjectId) {
        setAutopilotMode(detail.mode);
      }
    };
    const onFullStatus = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.projectId === currentProjectId) {
        if (detail.phase === "completed" || detail.phase === "error") {
          // Clear after short delay so user sees final message
          setFullAutopilotStatus(detail);
          setTimeout(() => setFullAutopilotStatus(null), 5000);
        } else {
          setFullAutopilotStatus(detail);
        }
      }
    };
    window.addEventListener("crewdeck:queue-paused", onPaused);
    window.addEventListener("crewdeck:queue-resumed", onResumed);
    window.addEventListener("crewdeck:queue-stopped", onStopped);
    window.addEventListener("crewdeck:autopilot-changed", onAutopilotChanged);
    window.addEventListener("crewdeck:autopilot-full-status", onFullStatus);
    return () => {
      window.removeEventListener("crewdeck:queue-paused", onPaused);
      window.removeEventListener("crewdeck:queue-resumed", onResumed);
      window.removeEventListener("crewdeck:queue-stopped", onStopped);
      window.removeEventListener("crewdeck:autopilot-changed", onAutopilotChanged);
      window.removeEventListener("crewdeck:autopilot-full-status", onFullStatus);
    };
  }, [currentProjectId]);

  // Live countdown while queue is paused for rate-limit cooldown — ticks
  // once per second so the "HH:MM 자동 재개 · N분 남음" label updates
  // without requiring the user to reload. The interval is cheap (pure
  // state tick) and only runs while the pause banner is visible.
  useEffect(() => {
    if (!queuePaused || !queuePausedInfo?.nextRetryAt) return;
    const id = setInterval(() => setCountdownTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [queuePaused, queuePausedInfo?.nextRetryAt]);

  // Listen for goal:squash_ready to store payload for dialog
  useEffect(() => {
    const handler = (e: Event) => {
      const { goalId, commitMessage, filesChanged, acceptanceOutput, workReport, skippedTasks } = (e as CustomEvent).detail;
      setSquashPayloadByGoalId((prev) => ({
        ...prev,
        [goalId]: { commitMessage, filesChanged, acceptanceOutput, workReport, skippedTasks },
      }));
    };
    window.addEventListener("crewdeck:goal-squash-ready", handler);
    return () => window.removeEventListener("crewdeck:goal-squash-ready", handler);
  }, []);

  // 비동기 서사 요약(goal:work_report) 도착 시 기존 페이로드에 병합
  useEffect(() => {
    const handler = (e: Event) => {
      const { goalId, workReport } = (e as CustomEvent).detail;
      setSquashPayloadByGoalId((prev) => ({
        ...prev,
        [goalId]: { ...prev[goalId], workReport },
      }));
    };
    window.addEventListener("crewdeck:goal-work-report", handler);
    return () => window.removeEventListener("crewdeck:goal-work-report", handler);
  }, []);

  // 승인 다이얼로그를 열었는데 WS 페이로드가 없으면(페이지 리로드 등) 서버에서 재조회
  useEffect(() => {
    if (!squashApprovalGoalId) return;
    if (squashPayloadByGoalId[squashApprovalGoalId]?.commitMessage) return;
    let cancelled = false;
    api.goals
      .squashPreview(squashApprovalGoalId)
      .then((preview) => {
        if (cancelled || !preview) return;
        setSquashPayloadByGoalId((prev) => ({
          ...prev,
          [squashApprovalGoalId]: {
            ...prev[squashApprovalGoalId],
            commitMessage: preview.commitMessage,
            filesChanged: preview.filesChanged,
            workReport: preview.workReport,
            skippedTasks: preview.skippedTasks,
          },
        }));
      })
      .catch(() => { /* 프리뷰 없이도 승인 자체는 가능 */ });
    return () => {
      cancelled = true;
    };
  }, [squashApprovalGoalId, squashPayloadByGoalId]);

  // Listen for system:error events — show as toast
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{
        agentName?: string;
        error?: { code?: string; message?: string; recovery?: string };
      }>).detail;
      // payload: { agentId, agentName, taskId, error: { code, message, detail, recovery } }
      const err = detail?.error;
      const agent = detail?.agentName;
      const msg = err?.message
        ? `${agent ? `[${agent}] ` : ""}${err.message}`
        : t("systemErrorGeneric");
      showToast(msg, "error");
    };
    window.addEventListener("crewdeck:system-error", handler);
    return () => window.removeEventListener("crewdeck:system-error", handler);
  }, [t]);

  // Listen for CommandPalette navigation events
  useEffect(() => {
    const onGoTab = (e: Event) => {
      const { tab } = (e as CustomEvent<{ tab: string }>).detail;
      if (tab === "kanban" || tab === "verification" || tab === "reports" || tab === "sessions" || tab === "settings" || tab === "overview" || tab === "agents") {
        setTab(tab as Tab);
      }
    };
    const onAddAgent = () => setShowAddAgent(true);
    const onAddGoal = () => {
      if (!currentProjectId) return;
      setShowDialog("addGoal");
    };

    // 소환(⚡)·대화(💬): 탭 이동 없이 대화 집중 모달을 연다. taskId 있으면 맥락 주입.
    const onOpenAgent = (e: Event) => {
      const { agentId, taskId } = (e as CustomEvent<{ agentId: string; taskId?: string }>).detail;
      setChat({ agentId, taskId: taskId ?? null });
    };
    // ⚙ 설정: 대화 모달에서 관리 패널(AgentDetail)로 전환.
    const onOpenAgentSettings = (e: Event) => {
      const { agentId } = (e as CustomEvent<{ agentId: string }>).detail;
      setSelectedAgentId(agentId);
    };
    // 워크스페이스(⤢): 풀 2-pane 오버레이 열기.
    const onOpenWorkspace = (e: Event) => {
      setWorkspace((e as CustomEvent<{
        workspaceId?: string | null;
        workspaceName?: string;
        worktreeBranch?: string | null;
        agentId?: string | null;
        agentName?: string;
        goalId: string | null;
        taskId: string | null;
      }>).detail);
    };
    window.addEventListener("crewdeck:go-tab", onGoTab);
    window.addEventListener("crewdeck:add-agent", onAddAgent);
    window.addEventListener("crewdeck:add-goal", onAddGoal);
    window.addEventListener("crewdeck:open-agent", onOpenAgent);
    window.addEventListener("crewdeck:open-agent-settings", onOpenAgentSettings);
    window.addEventListener("crewdeck:open-workspace", onOpenWorkspace);
    const onOpenHelp = () => setHelpOpen(true);
    window.addEventListener("crewdeck:open-help", onOpenHelp);
    return () => {
      window.removeEventListener("crewdeck:go-tab", onGoTab);
      window.removeEventListener("crewdeck:add-agent", onAddAgent);
      window.removeEventListener("crewdeck:add-goal", onAddGoal);
      window.removeEventListener("crewdeck:open-agent", onOpenAgent);
      window.removeEventListener("crewdeck:open-agent-settings", onOpenAgentSettings);
      window.removeEventListener("crewdeck:open-workspace", onOpenWorkspace);
      window.removeEventListener("crewdeck:open-help", onOpenHelp);
    };
  }, [currentProjectId]);

  // Listen for prompt-complete to reset sending state
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ agentId: string; error?: string }>).detail;
      if (detail.agentId === panelPromptAgentId) {
        setPanelPromptSending(false);
        setPanelPromptToast(detail.error ?? t("promptComplete"));
      }
    };
    window.addEventListener("crewdeck:prompt-complete", handler);
    return () => window.removeEventListener("crewdeck:prompt-complete", handler);
  }, [panelPromptAgentId, t]);

  // Listen for multi-prompt WebSocket events
  useEffect(() => {
    const onAgentDone = (e: Event) => {
      const { agentName, result, index, total } = (e as CustomEvent).detail;
      void agentName;
      setMultiPromptProgress({ current: index + 1, total });
      setMultiPromptResults((prev) => [...prev, { agentId: (e as CustomEvent).detail.agentId, agentName, result }]);
    };
    const onComplete = (e: Event) => {
      const { results } = (e as CustomEvent).detail;
      setMultiPromptResults(results);
      setMultiPromptProgress(null);
      setPanelPromptSending(false);
    };
    const onSingleComplete = () => {
      if (!multiAgentMode) setPanelPromptSending(false);
    };

    window.addEventListener("crewdeck:multi-agent-done", onAgentDone);
    window.addEventListener("crewdeck:multi-complete", onComplete);
    window.addEventListener("crewdeck:prompt-complete", onSingleComplete);
    return () => {
      window.removeEventListener("crewdeck:multi-agent-done", onAgentDone);
      window.removeEventListener("crewdeck:multi-complete", onComplete);
      window.removeEventListener("crewdeck:prompt-complete", onSingleComplete);
    };
  }, [multiAgentMode]);

  // Spec polling — cleanup on unmount
  useEffect(() => {
    return () => {
      specPollRefs.current.forEach((timer) => clearInterval(timer));
      specPollRefs.current.clear();
    };
  }, []);

  // useMemo MUST be called before any early returns (Rules of Hooks)
  const agentMap = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents]);
  const activeTasks = useMemo(() => tasks.filter((t) => t.status === "in_progress" || t.status === "in_review"), [tasks]);
  const hasActiveTasks = activeTasks.length > 0;
  const pendingApprovalCount = useMemo(() => tasks.filter((t) => t.status === "pending_approval").length, [tasks]);
  const tasksByGoalId = useMemo(() => {
    const map = new Map<string, typeof tasks>();
    for (const t of tasks) {
      const arr = map.get(t.goal_id);
      if (arr) arr.push(t);
      else map.set(t.goal_id, [t]);
    }
    return map;
  }, [tasks]);

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto py-8 px-6 animate-pulse">
          {/* Header skeleton */}
          <div className="mb-6">
            <div className="h-7 w-48 bg-line rounded mb-2" />
            <div className="h-4 w-80 bg-sunken rounded mb-3" />
            <div className="flex gap-2">
              <div className="h-5 w-16 bg-sunken rounded" />
              <div className="h-5 w-20 bg-sunken rounded" />
            </div>
          </div>
          {/* Tabs skeleton */}
          <div className="flex gap-4 mb-6 border-b border-line-soft pb-2">
            {[56, 64, 48, 72, 48].map((w, i) => (
              <div key={i} className="h-4 rounded bg-sunken" style={{ width: w }} />
            ))}
          </div>
          {/* Content skeleton */}
          <div className="grid grid-cols-3 gap-6">
            <div className="col-span-2 space-y-4">
              <div className="h-24 bg-sunken rounded-lg" />
              <div className="h-32 bg-sunken rounded-lg" />
              <div className="h-20 bg-sunken rounded-lg" />
            </div>
            <div className="space-y-4">
              <div className="h-28 bg-sunken rounded-lg" />
              <div className="h-36 bg-sunken rounded-lg" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!project) {
    return <WelcomeGuide />;
  }

  const handleAddAgent = () => setShowAddAgent(true);

  const handleDuplicateTeam = async () => {
    setDuplicateTeamConfirm(false);
    if (!currentProjectId) return;
    setDuplicatingTeam(true);
    try {
      const res = await api.agents.duplicateTeam(currentProjectId);
      showToast(t("duplicateTeamSuccess", { team: res.team, count: res.count }), "success");
      loadData();
    } catch (err: any) {
      showToast(t("duplicateTeamFailed"), "error", err.message);
    } finally {
      setDuplicatingTeam(false);
    }
  };

  const handleAgentCreated = (agent: any) => {
    setAgents([...agents, agent]);
    setShowAddAgent(false);
  };

  const handleAddGoal = () => setShowDialog("addGoal");

  const startSpecPolling = (goalId: string) => {
    // Prevent duplicate polling
    if (specPollRefs.current.has(goalId)) return;
    setGeneratingSpecGoalIds((prev) => new Set(prev).add(goalId));
    let retryCount = 0;
    const MAX_RETRIES = 60; // 3s × 60 = 3min max
    const timer = setInterval(async () => {
      retryCount++;
      try {
        const generation = await api.goals.getSpecGenerationState(goalId);
        const status = generation.generation_status;
        if (status === "generating" && retryCount >= MAX_RETRIES) {
          clearInterval(timer);
          specPollRefs.current.delete(goalId);
          setGeneratingSpecGoalIds((prev) => {
            const next = new Set(prev);
            next.delete(goalId);
            return next;
          });
          showToast(t("specGenerateFailed"), "error", "Timeout: spec generation took too long");
        } else if (status !== "generating") {
          clearInterval(timer);
          specPollRefs.current.delete(goalId);
          setGeneratingSpecGoalIds((prev) => {
            const next = new Set(prev);
            next.delete(goalId);
            return next;
          });
          if (status === "failed") {
            showToast(t("specGenerateFailed"), "error", generation.generation_error ?? undefined);
          } else {
            const spec = await api.goals.getSpec(goalId);
            if (spec.versions.length > 0) {
              showToast(t("specGenerateComplete"), "success");
            } else {
              showToast(t("specGenerateFailed"), "error", "Spec generation completed without a snapshot");
            }
          }
        }
      } catch (err: any) {
        // 404 = spec row not yet created, keep polling
        if (err.status === 404) {
          if (retryCount >= MAX_RETRIES) {
            clearInterval(timer);
            specPollRefs.current.delete(goalId);
            setGeneratingSpecGoalIds((prev) => {
              const next = new Set(prev);
              next.delete(goalId);
              return next;
            });
            showToast(t("specGenerateFailed"), "error", "Timeout: spec generation took too long");
          }
          return; // keep polling
        }
        clearInterval(timer);
        specPollRefs.current.delete(goalId);
        setGeneratingSpecGoalIds((prev) => {
          const next = new Set(prev);
          next.delete(goalId);
          return next;
        });
        showToast(t("specGenerateFailed"), "error", err.message);
      }
    }, 3000);
    specPollRefs.current.set(goalId, timer);
  };

  const handleAddGoalDirect = async (title: string, description: string, acceptanceScript?: string, skipAdversarial?: boolean, sourceMaterial?: string) => {
    // Snapshot the target project up front — currentProjectId can change while the
    // create is in flight (parallel multi-project use). A silent early-return here
    // would drop the goal with no feedback.
    const projectId = currentProjectId;
    setShowDialog(null);
    dismissAiSuggestions();
    if (!projectId) {
      showToast(t("decomposeFailed"), "error", "No project selected");
      return;
    }
    try {
      const goal = await api.goals.create({
        project_id: projectId,
        title,
        description,
        ...(acceptanceScript ? { acceptance_script: acceptanceScript } : {}),
        ...(skipAdversarial ? { skip_adversarial: true } : {}),
        ...(sourceMaterial ? { source_material: sourceMaterial } : {}),
      });
      // Append against the freshest store state, not the stale `goals` closure —
      // in a multi-add loop the closure never updates between awaits, so each
      // append would clobber the previous one. Only reflect it in the list when the
      // user is still viewing the project the goal was created for.
      if (useStore.getState().currentProjectId === projectId) {
        setGoals([...useStore.getState().goals, goal]);
      }
      showToast(t("addGoalSuccess"), "success");
    } catch (err: any) {
      showToast(t("decomposeFailed"), "error", err.message);
    }
  };

  const handleAddGoalWithSpec = async (title: string, description: string, acceptanceScript?: string, skipAdversarial?: boolean) => {
    const projectId = currentProjectId;
    setShowDialog(null);
    dismissAiSuggestions();
    if (!projectId) {
      showToast(t("specGenerateFailed"), "error", "No project selected");
      return;
    }
    try {
      const goal = await api.goals.create({
        project_id: projectId,
        title,
        description,
        withSpec: true,
        ...(acceptanceScript ? { acceptance_script: acceptanceScript } : {}),
        ...(skipAdversarial ? { skip_adversarial: true } : {}),
      });
      if (useStore.getState().currentProjectId === projectId) {
        setGoals([...useStore.getState().goals, goal]);
      }
      showToast(t("addGoalSuccess"), "success");
      // When autopilot is active, scheduler handles spec→decompose sequentially.
      // Client only triggers spec generation in manual mode.
      if (!goal.autopilotHandled) {
        await api.goals.generateSpec(goal.id);
        startSpecPolling(goal.id);
      }
    } catch (err: any) {
      showToast(t("specGenerateFailed"), "error", err.message);
    }
  };

  const handleUpdateGoal = async (goalId: string, title: string, description: string, references?: string[], acceptanceScript?: string) => {
    setEditGoalId(null);
    try {
      const updated = await api.goals.update(goalId, {
        title,
        description,
        ...(references ? { references } : {}),
        ...(acceptanceScript !== undefined ? { acceptance_script: acceptanceScript || null } : {}),
      });
      setGoals(goals.map((g) => g.id === goalId ? { ...g, ...updated } : g));
      showToast(t("goalUpdated"), "success");
    } catch (err: any) {
      showToast(t("decomposeFailed"), "error", err.message);
    }
  };

  const handleSquashApprove = async (goalId: string, commitMessage?: string) => {
    setIsApproving(true);
    try {
      const result = await api.goals.squashApprove(goalId, commitMessage);
      if (result.resolving) {
        // base 전진과 겹침 — 에이전트가 해결 중 (완료는 WS goal:merged로 통지)
        showToast(t("toastSquashResolving"), "info");
        updateGoal({ id: goalId, squash_status: "resolving" });
      } else {
        showToast(t("toastSquashApproveStart"), "info");
        updateGoal({ id: goalId, squash_status: "approved" });
      }
      setSquashApprovalGoalId(null);
    } catch (err: any) {
      showToast(err.message ?? t("toastSquashApproveFailed"), "error", err.detail);
      // 다이얼로그 유지 (isApproving만 해제)
    } finally {
      setIsApproving(false);
    }
  };

  // pr_open goal의 실제 GitHub PR 상태를 재조회 (수동). 결과는 WS goal:pr_state로 store 반영.
  const handleRefreshPrState = async (goalId: string) => {
    setRefreshingPrGoalId(goalId);
    try {
      const result = await api.goals.refreshPrState(goalId);
      updateGoal({ id: goalId, pr_state: result.prState, pr_state_checked_at: result.prStateCheckedAt });
    } catch (err: any) {
      showToast(err.message ?? "PR 상태 조회 실패", "error", err.detail);
    } finally {
      setRefreshingPrGoalId(null);
    }
  };

  const handleDecomposeGoal = async (goalId: string) => {
    const goal = goals.find((candidate) => candidate.id === goalId);
    if (goal?.spec_approval_required === 1 && !goal.execution_spec_version_id) {
      showToast(t("specNotApprovedToast"), "error");
      setSpecGoalId(goalId);
      return;
    }
    // If tasks already exist (re-decompose), show confirm modal
    const existingTasks = tasksByGoalId.get(goalId) ?? [];
    if (existingTasks.length > 0) {
      setReDecomposeGoalId(goalId);
      return;
    }
    await executeDecompose(goalId, false);
  };

  const executeDecompose = async (goalId: string, isReDecompose: boolean) => {
    setDecomposingGoalId(goalId);
    try {
      await api.orchestration.decomposeGoal(goalId);
      loadData();
      showToast(isReDecompose ? t("reDecomposeSuccess") : t("decomposeSuccess"), "success");
    } catch (err: any) {
      // 승인 게이트 차단(spec_not_approved): generic toast 대신 해당 goal의 승인 화면(Blueprint)을 연다
      if (err instanceof ApiError && err.code === "spec_not_approved") {
        showToast(t("specNotApprovedToast"), "error", err.message);
        setSpecGoalId(goalId);
      } else {
        showToast(t("decomposeFailed"), "error", err.message);
      }
    } finally {
      setDecomposingGoalId(null);
    }
  };

  const handleAddTask = (goalId: string) => {
    setAddTaskGoalId(goalId);
    setShowDialog("addTask");
  };

  const handleDeleteGoal = (goalId: string) => {
    setDeleteGoalId(goalId);
  };

  const executeDeleteGoal = async (goalId: string) => {
    try {
      await guardMutation(api.goals.delete(goalId));
    } catch {
      return; // 실패 토스트는 guardMutation
    }
    loadData();
  };

  const handleAddTaskSubmit = async (title: string) => {
    setShowDialog(null);
    if (!addTaskGoalId) return;
    const task = await api.tasks.create({
      goal_id: addTaskGoalId,
      project_id: currentProjectId,
      title,
    });
    setTasks([...tasks, task]);
    setAddTaskGoalId(null);
  };

  const startEditHeaderMission = () => {
    setHeaderMissionDraft(project?.mission ?? "");
    setEditingHeaderMission(true);
  };

  const cancelEditHeaderMission = () => {
    setEditingHeaderMission(false);
    setHeaderMissionDraft("");
  };

  const saveHeaderMission = async () => {
    if (!currentProjectId || !project) return;
    if (headerMissionDraft === project.mission) {
      cancelEditHeaderMission();
      return;
    }
    setSavingMission(true);
    try {
      const updated = await api.projects.update(currentProjectId, { mission: headerMissionDraft });
      updateProject(updated);
      setEditingHeaderMission(false);
    } catch {
      showToast(t("errorSaveMissionFailed"), "error");
    } finally {
      setSavingMission(false);
    }
  };

  const handleHeaderMissionKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      saveHeaderMission();
    }
    if (e.key === "Escape") cancelEditHeaderMission();
  };

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;
  const chatAgent = chat ? agents.find((a) => a.id === chat.agentId) ?? null : null;

  // 소환 대화 → "다시 해결": 태스크를 todo로 되돌려 정규 실행+자동 재검증 파이프라인에 다시 태운다(fail→pass 완결).
  const handleSummonRework = async (taskId: string) => {
    try {
      await api.tasks.update(taskId, { status: "todo" });
      showToast(t("reworkStarted"), "info");
      setChat(null);
      loadData();
    } catch (err: any) {
      showToast(t("taskStatusUpdateFailed"), "error", err?.message);
    }
  };

  const handleAutopilotChange = async (mode: "off" | "goal" | "full") => {
    if (!currentProjectId || autopilotChanging) return;
    setShowAutopilotModal(false);
    setAutopilotChanging(true);
    try {
      const updated = await api.projects.update(currentProjectId, { autopilot: mode });
      updateProject(updated);
      setAutopilotMode(mode);
    } catch (err: any) {
      showToast(t("errorAutopilotChange"), "error", err.message);
    } finally {
      setAutopilotChanging(false);
    }
  };

  const handleResumeQueue = async () => {
    if (!currentProjectId) return;
    try {
      await api.orchestration.resumeQueue(currentProjectId);
      setQueuePaused(false);
      setQueuePausedInfo(null);
    } catch (err: any) {
      showToast(t("errorResumeQueue"), "error", err.message);
    }
  };

  const handleToggleQueue = async () => {
    if (!currentProjectId || queueToggling) return;
    setQueueToggling(true);
    try {
      if (queueRunning) {
        await api.orchestration.stopQueue(currentProjectId);
        setQueueRunning(false);
      } else {
        await api.orchestration.startQueue(currentProjectId);
        setQueueRunning(true);
        setQueueStoppedByRateLimit(false);
      }
    } catch {
      // 409 = already running, just sync state
      const status = await api.orchestration.queueStatus(currentProjectId).catch(() => ({ running: false }));
      setQueueRunning(status.running);
    } finally {
      setQueueToggling(false);
    }
  };

  const handleSendPanelPrompt = async () => {
    if (!panelPromptMessage.trim() || !panelPromptAgentId || panelPromptSending) return;
    setPanelPromptSending(true);
    setPanelPromptToast(null);
    try {
      await api.orchestration.sendPrompt(panelPromptAgentId, panelPromptMessage.trim());
      setPanelPromptMessage("");
      // Don't set sending=false here — wait for prompt-complete event
    } catch (err: any) {
      setPanelPromptToast(err.message ?? t("promptSendError"));
      setPanelPromptSending(false);
    }
  };

  const handleSendMultiPrompt = async () => {
    if (!panelPromptMessage.trim() || multiAgentIds.length < 2 || panelPromptSending || !currentProjectId) return;
    setPanelPromptSending(true);
    setPanelPromptToast(null);
    setMultiPromptProgress({ current: 0, total: multiAgentIds.length });
    setMultiPromptResults([]);
    try {
      await api.orchestration.multiPrompt(multiAgentIds, panelPromptMessage.trim(), currentProjectId);
      setPanelPromptMessage("");
      // Don't set sending=false — wait for multi-prompt:complete event
    } catch (err: any) {
      setPanelPromptToast(err.message ?? t("promptSendError"));
      setPanelPromptSending(false);
      setMultiPromptProgress(null);
    }
  };

  const toggleMultiAgentId = (agentId: string) => {
    setMultiAgentIds((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId]
    );
  };

  // activeTasks / hasActiveTasks are defined above (before early returns)

  return (
    <div className="flex-1 overflow-y-auto">
      {showDialog === "addGoal" && currentProjectId && (
        <AddGoalDialog
          onCreateDirect={handleAddGoalDirect}
          onCreateWithSpec={handleAddGoalWithSpec}
          onCancel={() => setShowDialog(null)}
          suggestions={visibleSuggestions}
          suggestLoading={visibleSuggestLoading}
          suggestError={visibleSuggestError}
          suggestErrorDetail={visibleSuggestErrorDetail}
          onStartSuggest={startAiSuggest}
          onDismissSuggestions={dismissAiSuggestions}
        />
      )}
      {editGoalId && currentProjectId && (() => {
        const goal = goals.find((g) => g.id === editGoalId);
        if (!goal) return null;
        return (
          <EditGoalDialog
            goal={goal}
            projectId={currentProjectId}
            onSave={handleUpdateGoal}
            onCancel={() => setEditGoalId(null)}
          />
        );
      })()}
      {showDialog === "addTask" && (
        <InputDialog
          title={t("promptTaskTitle")}
          placeholder={t("promptTaskTitleHint")}
          onSubmit={handleAddTaskSubmit}
          onCancel={() => { setShowDialog(null); setAddTaskGoalId(null); }}
        />
      )}
      {duplicateTeamConfirm && (
        <ConfirmDialog
          message={t("duplicateTeamConfirmMsg")}
          onConfirm={handleDuplicateTeam}
          onCancel={() => setDuplicateTeamConfirm(false)}
        />
      )}
      {deleteGoalId && (
        <ConfirmDialog
          message={t("deleteGoalConfirm")}
          onConfirm={() => {
            const goalId = deleteGoalId;
            setDeleteGoalId(null);
            executeDeleteGoal(goalId);
          }}
          onCancel={() => setDeleteGoalId(null)}
        />
      )}
      {reDecomposeGoalId && (() => {
        const goalTasks = tasksByGoalId.get(reDecomposeGoalId) ?? [];
        const doneCount = goalTasks.filter((tk) => tk.status === "done").length;
        const msg = doneCount > 0
          ? t("reDecomposeConfirmWithDone").replace("{count}", String(goalTasks.length)).replace("{done}", String(doneCount))
          : t("reDecomposeConfirm").replace("{count}", String(goalTasks.length));
        return (
          <ConfirmDialog
            message={msg}
            onConfirm={() => {
              const goalId = reDecomposeGoalId;
              setReDecomposeGoalId(null);
              executeDecompose(goalId, true);
            }}
            onCancel={() => setReDecomposeGoalId(null)}
          />
        );
      })()}
      {squashApprovalGoalId && (() => {
        const goal = goals.find((g) => g.id === squashApprovalGoalId);
        if (!goal) return null;
        const payload = squashPayloadByGoalId[squashApprovalGoalId] ?? {};
        return (
          <GoalSquashApprovalDialog
            goal={goal}
            commitMessage={payload.commitMessage}
            filesChanged={payload.filesChanged}
            acceptanceOutput={payload.acceptanceOutput}
            workReport={payload.workReport}
            skippedTasks={payload.skippedTasks}
            onConfirm={(msg) => handleSquashApprove(squashApprovalGoalId, msg)}
            onCancel={() => { if (!isApproving) setSquashApprovalGoalId(null); }}
            isApproving={isApproving}
          />
        );
      })()}
      {specGoalId && (
        <GoalSpecPanel goalId={specGoalId} goalTitle={goals.find((g) => g.id === specGoalId)?.title || goals.find((g) => g.id === specGoalId)?.description} onClose={() => setSpecGoalId(null)} onGeneratingClose={() => startSpecPolling(specGoalId)} />
      )}
      {showAutopilotModal && (
        <AutopilotModal
          currentMode={autopilotMode}
          hasMission={!!project?.mission?.trim()}
          hasCto={agents.some((a) => a.role === "cto")}
          todoCount={tasks.filter((t) => t.status === "todo").length}
          runningCount={tasks.filter((t) => t.status === "in_progress" || t.status === "in_review").length}
          onConfirm={handleAutopilotChange}
          onClose={() => setShowAutopilotModal(false)}
        />
      )}
      {showAddAgent && currentProjectId && (
        <AddAgentDialog
          projectId={currentProjectId}
          mission={project?.mission ?? undefined}
          initialSmart={addAgentSmart}
          existingAgents={agents}
          onCreated={handleAgentCreated}
          onClose={() => {
            setShowAddAgent(false);
            setAddAgentSmart(false);
            // 닫은 뒤 칩 상태를 서버 기준으로 동기화 (결과를 확인했으면 칩 제거)
            if (currentProjectId) {
              api.agents.designStatus(currentProjectId)
                .then((s) => setTeamDesign(s.running ? "running" : s.ready ? "ready" : null))
                .catch(() => {});
            }
          }}
        />
      )}
      {chat && chatAgent && (
        <SummonChat
          agent={chatAgent}
          taskId={chat.taskId}
          goalId={chat.taskId ? tasks.find((tk) => tk.id === chat.taskId)?.goal_id ?? null : null}
          onClose={() => setChat(null)}
          onOpenSettings={() => {
            setSelectedAgentId(chat.agentId);
            setChat(null);
          }}
          onRework={chat.taskId ? () => handleSummonRework(chat.taskId!) : undefined}
        />
      )}
      {selectedAgent && (
        <AgentDetail
          agent={selectedAgent}
          agents={agents}
          tasks={tasks}
          onClose={() => setSelectedAgentId(null)}
          onKill={() => {
            setSelectedAgentId(null);
            loadData();
          }}
        />
      )}
      {workspace && (
        <SessionWorkspace
          agentId={workspace.agentId}
          agentName={workspace.agentName}
          goalId={workspace.goalId}
          taskId={workspace.taskId}
          workspaceId={workspace.workspaceId}
          workspaceName={workspace.workspaceName}
          worktreeBranch={workspace.worktreeBranch}
          onClose={() => setWorkspace(null)}
        />
      )}
      {helpOpen && <HelpGuide onClose={() => setHelpOpen(false)} />}
      <div className="max-w-6xl mx-auto py-8 px-6">
        {/* Project Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-fg">{project.name}</h1>
          <div className="mt-1">
            {editingHeaderMission ? (
              <div className="flex items-start gap-2">
                <textarea
                  autoFocus
                  rows={3}
                  value={headerMissionDraft}
                  onChange={(e) => setHeaderMissionDraft(e.target.value)}
                  onKeyDown={handleHeaderMissionKeyDown}
                  disabled={savingMission}
                  className="flex-1 text-sm border border-accent rounded px-2 py-1 text-muted bg-sunken focus:outline-none focus:ring-1 focus:ring-accent resize-none"
                  placeholder={t("missionPlaceholderDetailed")}
                />
                <button
                  onClick={saveHeaderMission}
                  disabled={savingMission}
                  className="text-xs px-2 py-0.5 bg-fg text-canvas rounded hover:bg-fg/90 disabled:opacity-50"
                >
                  {savingMission ? t("savingLabel") : t("saveLabel")}
                </button>
                <button
                  onClick={cancelEditHeaderMission}
                  disabled={savingMission}
                  className="text-xs px-2 py-0.5 border border-line rounded hover:bg-fg/5"
                >
                  {t("cancelLabel")}
                </button>
              </div>
            ) : (
              <p
                className="text-muted cursor-pointer hover:text-muted group inline-flex items-center gap-1"
                onClick={startEditHeaderMission}
                title={t("clickToEdit")}
              >
                {project.mission || <span className="italic text-faint">{t("noMission")}</span>}
                <span className="text-xs text-faint group-hover:text-faint transition-colors">
                  {t("edit")}
                </span>
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2 mt-2 items-center">
            <span className="text-xs px-2 py-0.5 bg-success-subtle text-success rounded">
              {t(`projectStatus_${project.status}`)}
            </span>
            <span className="text-xs px-2 py-0.5 bg-sunken text-muted rounded">
              {t(`projectSource_${project.source}`)}
            </span>
            {project.workdir && (
              <span className="text-xs px-2 py-0.5 bg-sunken text-faint rounded font-mono">
                {project.workdir}
              </span>
            )}
            {gitRemote?.isGitHub && gitRemote.repo && (
              <a
                href={`https://github.com/${gitRemote.repo}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs px-2 py-0.5 bg-accent/10 text-accent rounded hover:underline"
                title={t("githubConnectedTitle")}
              >
                🔗 {gitRemote.repo}
              </a>
            )}
            {gitRemote?.isGitHub && (openPrs?.length ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => setShowPrList((v) => !v)}
                className="text-xs px-2 py-0.5 bg-warning-subtle text-warning rounded hover:bg-warning-subtle"
                title={t("openPrTitle")}
              >
                🔀 {t("openPrChip", { count: openPrs!.length })} {showPrList ? "▲" : "▼"}
              </button>
            )}
            {gitRemote?.isGitHub && prsLoading && (
              <span className="text-xs px-2 py-0.5 text-faint">{t("openPrLoading")}</span>
            )}
            {/* Dev server controls */}
          </div>
          {showPrList && openPrs && openPrs.length > 0 && (
            <div className="mt-2 flex flex-col gap-1 max-w-3xl">
              {openPrs.map((pr) => (
                <a
                  key={pr.number}
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-sunken hover:bg-fg/5 text-muted"
                >
                  <span className="text-faint shrink-0">#{pr.number}</span>
                  <span className="truncate flex-1">{pr.title}</span>
                  {pr.isDraft && (
                    <span className="shrink-0 text-[10px] px-1 rounded bg-line text-muted">draft</span>
                  )}
                  <span className="shrink-0 text-faint">{pr.author}</span>
                </a>
              ))}
            </div>
          )}
        </div>

        {/* Project Stats */}
        <ProjectStats tasks={tasks} projectId={currentProjectId ?? undefined} />

        {/* Tabs */}
        <div className="flex gap-4 mb-6 border-b border-line items-center overflow-x-auto">
          {(["overview", "agents", "kanban", "verification", "reports", "sessions", "settings"] as Tab[]).map((tabId) => {
            const tabLabel: Record<Tab, string> = {
              overview: t("tabOverview"),
              agents: t("tabAgents"),
              kanban: t("tabKanban"),
              verification: t("tabVerification"),
              reports: t("tabReports"),
              sessions: t("tabSessions"),
              settings: t("tabSettings"),
            };
            return (
              <button
                key={tabId}
                onClick={() => setTab(tabId)}
                className={`pb-2 text-sm transition-colors shrink-0 whitespace-nowrap ${
                  tab === tabId
                    ? "text-fg border-b-2 border-line font-medium"
                    : "text-faint hover:text-muted"
                }`}
              >
                {tabLabel[tabId]}
              </button>
            );
          })}
          <div className="ml-auto mb-2 flex shrink-0 items-center gap-2">
            {/* AI 팀 설계 상태 칩 — 탭 바에 두어 어느 탭·에이전트 0명 상태에서도 보이게 */}
            {!showAddAgent && teamDesign && (
              <button
                onClick={() => { setAddAgentSmart(true); setShowAddAgent(true); }}
                className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg font-medium transition-colors whitespace-nowrap ${
                  teamDesign === "running"
                    ? "bg-accent/10 text-accent hover:bg-accent/20"
                    : "bg-success-subtle text-success hover:bg-success-subtle"
                }`}
              >
                {teamDesign === "running" && (
                  <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                )}
                {teamDesign === "running" ? t("teamDesignRunning") : t("teamDesignReady")}
              </button>
            )}
            <button
              onClick={() => window.dispatchEvent(new CustomEvent("crewdeck:show-guide"))}
              title={t("viewGuide")}
              className="text-faint hover:text-muted transition-colors text-sm font-medium w-5 h-5 flex items-center justify-center rounded-full border border-line hover:border-line"
            >
              ?
            </button>
          </div>
        </div>

        {tab === "reports" && <GoalReports projectId={currentProjectId!} />}
        {tab !== "reports" && (tab === "settings" ? (
          <ProjectSettings projectId={currentProjectId!} />
        ) : tab === "sessions" ? (
          <SessionList projectId={currentProjectId!} />
        ) : tab === "overview" ? (
          <div className="flex flex-col gap-6 xl:flex-row">
            {/* Main column — scrollable, takes remaining width */}
            <div className="flex-1 min-w-0">
              {/* Autopilot Trigger */}
              <section className="mb-6">
                <button
                  onClick={() => setShowAutopilotModal(true)}
                  disabled={autopilotChanging}
                  className="flex items-center gap-2.5 px-4 py-2.5 bg-sunken border border-line rounded-xl hover:border-line transition-colors w-full text-left"
                >
                  <span className={`text-xs font-semibold uppercase tracking-wider shrink-0 ${
                    autopilotMode === "full"
                      ? "text-warning"
                      : autopilotMode === "goal"
                        ? "text-accent"
                        : "text-faint"
                  }`}>
                    Autopilot
                  </span>
                  <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${
                    autopilotMode === "full"
                      ? "bg-warning-subtle text-warning"
                      : autopilotMode === "goal"
                        ? "bg-accent/10 text-accent"
                        : "bg-sunken text-muted"
                  }`}>
                    {autopilotMode === "off" ? t("autopilotMode_off") : autopilotMode === "goal" ? t("autopilotMode_goal") : t("autopilotMode_full")}
                  </span>
                  <span className="text-[11px] text-faint flex-1 truncate">
                    {autopilotMode === "off" && t("autopilotDescManual")}
                    {autopilotMode === "goal" && t("autopilotDescGoal")}
                    {autopilotMode === "full" && t("autopilotDescFull")}
                  </span>
                  {autopilotChanging && (
                    <svg className="animate-spin w-3.5 h-3.5 text-faint shrink-0" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                  )}
                  <svg className="w-4 h-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </section>

              {/* Rate Limit Banner — removed, now shown as overlay on task area */}

              {/* Agents Section — team presence panel */}
              <section className="mb-8">
                {agents.length === 0 ? (
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <span className="font-medium text-muted shrink-0">{t("agents")}:</span>
                    <button
                      onClick={handleAddAgent}
                      className="text-accent hover:text-accent-hover transition-colors"
                    >
                      {t("addAgent")}
                    </button>
                  </div>
                ) : (() => {
                  const workingAgents = agents.filter((a) => a.status === "working");
                  const idleAgents = agents.filter((a) => a.status !== "working");
                  const visibleIdle = idleAgents.slice(0, AGENT_IDLE_CAP);
                  return (
                    <div className="overflow-hidden rounded-xl border border-line">
                      {/* Header — count + working badge + actions */}
                      <div className="flex items-center justify-between gap-2 border-b border-line-soft bg-sunken px-3 py-2">
                        <div className="flex min-w-0 items-center gap-2 text-xs">
                          <span className="shrink-0 font-semibold text-muted">{t("agents")}</span>
                          <span className="shrink-0 text-faint">{t("agentCount", { count: agents.length })}</span>
                          {workingAgents.length > 0 && (
                            <span className="inline-flex shrink-0 items-center gap-1 text-success">
                              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                              {t("agentsWorking", { count: workingAgents.length })}
                            </span>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-3 text-[11px]">
                          <button
                            onClick={() => setTab("agents")}
                            className="whitespace-nowrap text-accent transition-colors hover:text-accent-hover"
                          >
                            {t("goToAgentsTab")}
                          </button>
                          <button
                            onClick={() => setDuplicateTeamConfirm(true)}
                            disabled={duplicatingTeam}
                            title={t("duplicateTeamTip")}
                            className="whitespace-nowrap text-faint transition-colors hover:text-accent-hover disabled:opacity-50"
                          >
                            {duplicatingTeam ? t("duplicateTeamRunning") : t("duplicateTeam")}
                          </button>
                        </div>
                      </div>

                      {/* Working agents — hero rows with live activity */}
                      {workingAgents.length > 0 && (
                        <div className="divide-y divide-gray-50 dark:divide-gray-800">
                          {workingAgents.map((a) => {
                            const meta = roleMeta(a.role);
                            const phase = getCtoPhase(a.current_activity);
                            return (
                              <div key={a.id} className="flex items-center gap-2.5 px-3 py-2">
                                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm ${meta.tone}`}>
                                  {meta.icon}
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-xs font-medium text-muted">{a.name}</div>
                                  {a.current_activity && (
                                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px]">
                                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${phase ? "bg-accent animate-pulse" : "bg-success animate-pulse"}`} />
                                      <span className={`truncate ${phase ? "text-accent" : "text-success"}`}>
                                        {parseActivity(a.current_activity, t)}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Idle agents — compact role-avatar cluster */}
                      {idleAgents.length > 0 && (
                        <div className={`flex items-center gap-2 px-3 py-2 ${workingAgents.length > 0 ? "border-t border-line-soft/60" : ""}`}>
                          <span className="shrink-0 text-[11px] text-faint">
                            {t("agentsIdle")} {idleAgents.length}
                          </span>
                          <div className="flex min-w-0 flex-wrap items-center gap-1">
                            {visibleIdle.map((a) => {
                              const meta = roleMeta(a.role);
                              return (
                                <span
                                  key={a.id}
                                  title={a.name}
                                  className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-sunken text-[11px] opacity-70"
                                >
                                  {meta.icon}
                                </span>
                              );
                            })}
                            {idleAgents.length > visibleIdle.length && (
                              <button
                                onClick={() => setTab("agents")}
                                className="text-[11px] text-faint transition-colors hover:text-accent-hover"
                              >
                                {t("agentsMore", { count: idleAgents.length - visibleIdle.length })}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </section>

              {/* Goals Section */}
              <section className="mb-8">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-1.5">
                    <h2 className="text-sm font-semibold text-muted uppercase tracking-wider">
                      {t("goals")}
                    </h2>
                    <div className="relative group">
                      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-line text-[9px] font-bold text-muted cursor-help">?</span>
                      <div className="absolute left-0 top-6 z-50 w-64 p-3 bg-elevated border border-line rounded-lg shadow-lg text-xs text-muted opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
                        <p className="font-semibold text-fg mb-1">{t("specGuideTitle")}</p>
                        <p>{t("specGuideBody")}</p>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={handleAddGoal}
                    className="text-xs text-faint hover:text-muted"
                  >
                    {t("addGoal")}
                  </button>
                </div>
                {/* Goal search (#13) */}
                <div className="mb-3">
                  <input
                    type="text"
                    value={goalSearch}
                    onChange={(e) => setGoalSearch(e.target.value)}
                    placeholder={t("goalSearchPlaceholder")}
                    className="w-full text-xs px-3 py-1.5 rounded-lg border border-line bg-sunken text-muted placeholder-faint focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
                {/* AI Suggestion Banner — shown when loading or results ready */}
                {visibleSuggestLoading && showDialog !== "addGoal" && (
                  <button
                    onClick={() => setShowDialog("addGoal")}
                    className="w-full mb-3 px-4 py-2.5 bg-accent/10 border border-accent rounded-lg flex items-center gap-3 hover:bg-accent/20 transition-colors"
                  >
                    <svg className="animate-spin w-4 h-4 text-accent flex-shrink-0" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    <span className="text-xs text-accent font-medium">
                      {t("addGoalAiSuggestLoading")}
                    </span>
                  </button>
                )}
                {!visibleSuggestLoading && visibleSuggestions.length > 0 && showDialog !== "addGoal" && (
                  <button
                    onClick={() => setShowDialog("addGoal")}
                    className="w-full mb-3 px-4 py-2.5 bg-success-subtle border border-success rounded-lg flex items-center justify-between hover:bg-success-subtle transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <svg className="w-4 h-4 text-success flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                      </svg>
                      <span className="text-xs text-success font-medium">
                        {t("addGoalAiSuggestReady", { count: visibleSuggestions.length })}
                      </span>
                    </div>
                    <span className="text-[10px] text-success">
                      {t("addGoalAiSuggestReviewAction")}
                    </span>
                  </button>
                )}

                {goals.length === 0 && (
                  <div className="py-8 px-4 border border-dashed border-line rounded-lg text-center">
                    <div className="text-3xl mb-2 opacity-40">🎯</div>
                    <p className="text-sm font-medium text-muted mb-1">
                      {t("emptyGoalsTitle")}
                    </p>
                    <p className="text-xs text-faint mb-4">
                      {t("emptyGoalsDesc")}
                    </p>
                    <button
                      onClick={handleAddGoal}
                      className="text-xs px-3 py-1.5 bg-fg text-canvas rounded-lg hover:bg-fg/90 transition-colors"
                    >
                      {t("addGoal")}
                    </button>
                  </div>
                )}
                {(() => {
                  const renderGoalCard = (goal: typeof goals[0]) => {
                    const goalTasks = tasksByGoalId.get(goal.id) ?? [];
                    const doneTasks = goalTasks.filter((tk) => tk.status === "done");
                    // terminal = done|skipped: skipped는 active 목록에서 빼고(progress 분자에는
                    // 포함 — 서버 progress와 동일한 terminal-inclusive), degraded 칩으로 노출
                    const skippedTasks = goalTasks.filter((tk) => tk.status === "skipped");
                    const activeTasks = goalTasks.filter((tk) => tk.status !== "done" && tk.status !== "skipped");
                    const pct = goalTasks.length > 0 ? Math.round(((doneTasks.length + skippedTasks.length) / goalTasks.length) * 100) : 0;
                    const isComplete = pct === 100 && goalTasks.length > 0;
                    const TASK_PREVIEW = 3;
                    const visibleActiveTasks = activeTasks.slice(0, TASK_PREVIEW);
                    const hiddenTaskCount = activeTasks.length - visibleActiveTasks.length;
                    // Detect decompose-in-flight from EITHER source:
                    //   (a) local button click (decomposingGoalId), or
                    //   (b) any agent whose current_activity starts with
                    //       "decompose:" and matches this goal's title
                    //       (triggered by API, autopilot rescue, other tabs).
                    const goalActivityKey = (goal.title || goal.description || "").slice(0, 80);
                    const agentDecomposingThis = agents.some(
                      (a) =>
                        typeof a.current_activity === "string" &&
                        a.current_activity.startsWith("decompose:") &&
                        a.current_activity.slice("decompose:".length) === goalActivityKey,
                    );
                    const isDecomposing = decomposingGoalId === goal.id || agentDecomposingThis;
                    const isGeneratingSpec = generatingSpecGoalIds.has(goal.id);
                    // 승인 게이트가 실행을 막는 상태 — handleDecomposeGoal/서버 assertExecutionAllowed와 동일 조건.
                    // 기획서(draft)는 있으나 실행 기준으로 고정된 승인본이 없다 = 승인해야 실행됨.
                    const needsSpecApproval = goal.has_spec === 1
                      && goal.spec_approval_required === 1
                      && !goal.execution_spec_version_id
                      && !isGeneratingSpec;
                    const displayTitle = goal.title || goal.description;
                    const hasDescription = goal.description && goal.title && goal.description !== goal.title;
                    const goalRefs = (() => { try { const r = JSON.parse(goal.references || "[]"); return Array.isArray(r) ? r : []; } catch { return []; } })();
                    const cardAccentClass = isDecomposing
                      ? "border-accent bg-accent/10 ring-1 ring-accent animate-pulse"
                      : isGeneratingSpec
                        ? "border-accent bg-accent/10 ring-1 ring-accent"
                        : needsSpecApproval
                          ? "border-warning bg-warning-subtle ring-1 ring-warning"
                          : "border-line bg-surface";
                    return (
                      <div
                        key={goal.id}
                        className={`mb-3 border rounded-lg overflow-visible transition-all ${cardAccentClass}`}
                      >
                        <div className="flex items-center justify-between gap-3 px-3 py-2">
                          <button
                            onClick={() => setEditGoalId(goal.id)}
                            className={`text-sm font-medium min-w-0 truncate text-left hover:underline decoration-line underline-offset-2 ${isComplete ? "text-faint" : "text-fg"}`}
                            title={t("editGoal")}
                          >
                            {displayTitle}
                          </button>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-xs text-faint whitespace-nowrap">
                              {doneTasks.length}/{goalTasks.length} ({pct}%)
                            </span>
                            {goalTasks.length > 0 && !isComplete && (
                              <span className="text-[10px] text-faint whitespace-nowrap">
                                {t("remainingTasks", { count: goalTasks.length - doneTasks.length })}
                              </span>
                            )}
                            <div className="relative">
                              <button
                                onClick={(e) => { e.stopPropagation(); setGoalMenuOpenId(goalMenuOpenId === goal.id ? null : goal.id); }}
                                aria-label={t("goalMoreActions")}
                                className="text-faint hover:text-muted transition-colors p-0.5 rounded"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                                  <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                                </svg>
                              </button>
                              {goalMenuOpenId === goal.id && (
                                <div
                                  className="absolute right-0 top-full mt-1 w-28 bg-surface border border-line rounded-lg shadow-lg z-50 py-1"
                                  onMouseLeave={() => setGoalMenuOpenId(null)}
                                >
                                  <button
                                    onClick={() => { setGoalMenuOpenId(null); setEditGoalId(goal.id); }}
                                    className="w-full text-left text-xs px-3 py-1.5 text-muted hover:bg-fg/5 transition-colors"
                                  >
                                    {t("editGoal")}
                                  </button>
                                  <button
                                    onClick={() => { setGoalMenuOpenId(null); handleDeleteGoal(goal.id); }}
                                    className="w-full text-left text-xs px-3 py-1.5 text-danger hover:bg-danger-subtle transition-colors"
                                  >
                                    {t("deleteGoal")}
                                  </button>
                                </div>
                              )}
                            </div>
                            {isGeneratingSpec ? (
                              <span className="text-[10px] px-2 py-0.5 rounded bg-accent/10 text-accent whitespace-nowrap flex items-center gap-1">
                                <svg className="animate-spin w-2.5 h-2.5" viewBox="0 0 24 24" fill="none">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                                </svg>
                                {t("specGeneratingInCard")}
                              </span>
                            ) : needsSpecApproval ? (
                              <button
                                onClick={() => setSpecGoalId(goal.id)}
                                title={t("specApprovalNeededHint")}
                                className="text-[10px] px-2 py-0.5 rounded font-medium flex items-center gap-1 bg-warning-subtle text-warning hover:bg-warning-subtle ring-1 ring-warning transition-colors whitespace-nowrap"
                              >
                                <span aria-hidden="true">✎</span>
                                {t("specApprovalNeeded")}
                              </button>
                            ) : (
                              <button
                                onClick={() => setSpecGoalId(goal.id)}
                                className="text-[10px] px-2 py-0.5 rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors whitespace-nowrap"
                              >
                                {goal.has_spec ? t("specView") : t("specGenerate")}
                              </button>
                            )}
                            {(() => {
                              const goalTasks = tasksByGoalId.get(goal.id) ?? [];
                              const hasRunning = goalTasks.some((tk) => tk.status === "in_progress" || tk.status === "in_review");
                              if (goalTasks.length > 0 && !hasRunning) return (
                                <button
                                  onClick={() => handleDecomposeGoal(goal.id)}
                                  disabled={isDecomposing || isGeneratingSpec || decomposingGoalId !== null}
                                  className={`text-[10px] px-2 py-0.5 rounded flex items-center gap-1 transition-colors whitespace-nowrap ${
                                    decomposingGoalId === goal.id
                                      ? "bg-warning/20 text-warning cursor-wait"
                                      : isGeneratingSpec
                                        ? "bg-sunken text-faint cursor-not-allowed"
                                        : "bg-warning-subtle text-warning hover:bg-warning-subtle"
                                  }`}
                                >
                                  {decomposingGoalId === goal.id ? (
                                    <>
                                      <svg className="animate-spin w-2.5 h-2.5" viewBox="0 0 24 24" fill="none">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                                      </svg>
                                      {t("decomposing")}
                                    </>
                                  ) : (
                                    t("reDecompose")
                                  )}
                                </button>
                              );
                              if (goalTasks.length > 0 && hasRunning) return (
                                <span className="text-[10px] px-2 py-0.5 rounded bg-sunken text-faint whitespace-nowrap">
                                  {t("decomposed")}
                                </span>
                              );
                              return null;
                            })()}
                            {!tasks.some((tk) => tk.goal_id === goal.id) && (
                              isGeneratingSpec ? (
                                <span className="relative group">
                                  <span className="text-[10px] px-2 py-0.5 rounded bg-accent/10 text-accent whitespace-nowrap cursor-not-allowed opacity-50">
                                    {t("decompose")}
                                  </span>
                                  <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-fg text-canvas text-[10px] rounded shadow-lg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
                                    {t("decomposeDisabledSpecGen")}
                                  </span>
                                </span>
                              ) : isDecomposing ? (
                                <span className="text-[10px] px-2 py-0.5 rounded bg-accent/20 text-accent whitespace-nowrap flex items-center gap-1 cursor-wait">
                                  <svg className="animate-spin w-2.5 h-2.5" viewBox="0 0 24 24" fill="none">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                                  </svg>
                                  {t("decomposing")}
                                </span>
                              ) : autopilotMode !== "off" ? (
                                (() => {
                                  const isThisGoalActive = fullAutopilotStatus?.goalId === goal.id && !["completed", "error"].includes(fullAutopilotStatus.phase);
                                  const isAnyActive = fullAutopilotStatus && !["completed", "error"].includes(fullAutopilotStatus.phase);
                                  if (isThisGoalActive) return (
                                    <span className="text-[10px] px-2 py-0.5 rounded bg-accent/10 text-accent whitespace-nowrap flex items-center gap-1">
                                      <svg className="animate-spin w-2.5 h-2.5" viewBox="0 0 24 24" fill="none">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                                      </svg>
                                      {fullAutopilotStatus?.message?.slice(0, 30) || t("autoDecompose")}
                                    </span>
                                  );
                                  if (isAnyActive) return (
                                    <span className="text-[10px] px-2 py-0.5 rounded bg-sunken text-faint whitespace-nowrap">
                                      {t("autoDecomposeWaiting")}
                                    </span>
                                  );
                                  // Autopilot on but no active status — show manual trigger
                                  return (
                                    <button
                                      onClick={() => handleDecomposeGoal(goal.id)}
                                      disabled={isDecomposing || decomposingGoalId !== null}
                                      className="text-[10px] px-2 py-0.5 rounded bg-accent/10 text-accent hover:bg-accent/20 whitespace-nowrap"
                                    >
                                      {t("decompose")}
                                    </button>
                                  );
                                })()
                              ) : (
                                <button
                                  onClick={() => handleDecomposeGoal(goal.id)}
                                  disabled={isDecomposing || decomposingGoalId !== null}
                                  className={`text-[10px] px-2 py-0.5 rounded flex items-center gap-1 transition-colors whitespace-nowrap ${
                                    decomposingGoalId === goal.id
                                      ? "bg-accent/20 text-accent cursor-wait"
                                      : decomposingGoalId !== null
                                        ? "bg-sunken text-faint opacity-50 cursor-not-allowed"
                                        : "bg-accent/10 text-accent hover:bg-accent/20"
                                  }`}
                                >
                                  {decomposingGoalId === goal.id ? (
                                    <>
                                      <svg className="animate-spin w-2.5 h-2.5" viewBox="0 0 24 24" fill="none">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                                      </svg>
                                      {t("decomposing")}
                                    </>
                                  ) : (
                                    t("decompose")
                                  )}
                                </button>
                              )
                            )}
                            {isGeneratingSpec || isDecomposing ? (
                              <span className="relative group">
                                <span className="text-[10px] px-2 py-0.5 rounded bg-sunken text-faint cursor-not-allowed whitespace-nowrap">
                                  {t("addTask")}
                                </span>
                                <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-fg text-canvas text-[10px] rounded shadow-lg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
                                  {isGeneratingSpec ? t("decomposeDisabledSpecGen") : t("decomposing")}
                                </span>
                              </span>
                            ) : (
                            <button
                              onClick={() => handleAddTask(goal.id)}
                              className="text-[10px] px-2 py-0.5 bg-sunken text-muted rounded hover:bg-fg/10 whitespace-nowrap"
                            >
                              {t("addTask")}
                            </button>
                            )}
                          </div>
                        </div>
                        <div className="bg-sunken rounded-full h-1 mx-3 overflow-hidden">
                          {isDecomposing ? (
                            <div className="h-1 rounded-full bg-gradient-to-r from-accent via-accent/50 to-accent animate-shimmer" style={{ width: "100%", backgroundSize: "200% 100%" }} />
                          ) : (
                            <div className="bg-accent h-1 rounded-full transition-all" style={{ width: `${pct}%` }} />
                          )}
                        </div>
                        {/* degraded 표식 — skipped COUNT>0 파생값. non-goal-as-unit goal에도
                            노출되는 유일한 skipped 신호(사람 게이트는 goal-as-unit 한정). */}
                        {skippedTasks.length > 0 && (
                          <div className="px-3 pt-1.5 flex flex-wrap gap-1.5 items-center">
                            <span
                              className="text-[10px] px-2 py-0.5 rounded-full bg-warning-subtle text-warning font-medium whitespace-nowrap cursor-help"
                              title={t("goalSkippedBadgeHint")}
                            >
                              {t("goalSkippedBadge", { count: skippedTasks.length })}
                            </span>
                          </div>
                        )}
                        {/* Goal-as-Unit squash UI */}
                        {goal.goal_model === "goal_as_unit" && (() => {
                          const squashStatus = goal.squash_status;
                          const sha: string | null = goal.squash_commit_sha ?? null;
                          const qaTaskId: string | null = goal.qa_regression_task_id ?? null;
                          const qaTask = qaTaskId ? tasks.find((tk) => tk.id === qaTaskId) : null;
                          const qaWaiting = qaTask && qaTask.status !== "done" && qaTask.status !== "skipped";
                          return (
                            <div className="px-3 pt-1.5 pb-1 flex flex-wrap gap-1.5 items-center">
                              {squashStatus === "pending_approval" && (
                                <>
                                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-warning-subtle text-warning font-medium whitespace-nowrap">
                                    {t("goalSquashPendingBadge")}
                                  </span>
                                  <button
                                    onClick={() => setSquashApprovalGoalId(goal.id)}
                                    className="text-[10px] px-2 py-0.5 rounded bg-accent text-white hover:bg-accent-hover transition-colors font-medium whitespace-nowrap"
                                  >
                                    {t("goalSquashApproveBtn")}
                                  </button>
                                </>
                              )}
                              {squashStatus === "approved" && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent font-medium flex items-center gap-1 whitespace-nowrap">
                                  <svg className="animate-spin w-2.5 h-2.5" viewBox="0 0 24 24" fill="none">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                                  </svg>
                                  {t("goalSquashApprovedBadge")}
                                </span>
                              )}
                              {squashStatus === "resolving" && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent font-medium flex items-center gap-1 whitespace-nowrap">
                                  <svg className="animate-spin w-2.5 h-2.5" viewBox="0 0 24 24" fill="none">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                                  </svg>
                                  {t("goalSquashResolvingBadge")}
                                </span>
                              )}
                              {squashStatus === "merged" && (() => {
                                const outcome = goal.merge_outcome;
                                const prUrl = goal.pr_url;
                                const prState = goal.pr_state;
                                // pr_open: 실제 origin 반영은 아직 — PR 상태로 정직하게 구분
                                if (outcome === "pr_open") {
                                  const tone = prState === "merged"
                                    ? "bg-success-subtle text-success"
                                    : prState === "closed"
                                      ? "bg-sunken text-muted"
                                      : "bg-warning-subtle text-warning";
                                  const label = prState === "merged"
                                    ? t("goalPrMergedBadge")
                                    : prState === "closed"
                                      ? t("goalPrClosedBadge")
                                      : t("goalPrReviewBadge");
                                  return (
                                    <>
                                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${tone}`}>
                                        {label}
                                      </span>
                                      {prUrl && (
                                        <a
                                          href={prUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="text-[10px] px-2 py-0.5 rounded bg-sunken text-accent hover:underline whitespace-nowrap"
                                        >
                                          {t("goalPrOpenLink")} ↗
                                        </a>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => handleRefreshPrState(goal.id)}
                                        disabled={refreshingPrGoalId === goal.id}
                                        className="text-[10px] px-2 py-0.5 rounded bg-sunken text-muted hover:bg-fg/10 transition-colors whitespace-nowrap disabled:opacity-50"
                                      >
                                        {t("goalPrRefresh")}
                                      </button>
                                    </>
                                  );
                                }
                                // local_only/branch_only: 로컬에만 반영
                                if (outcome === "local") {
                                  return (
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-success-subtle text-success font-medium whitespace-nowrap">
                                      {t("goalMergeLocalBadge")} {sha ? sha.slice(0, 7) : ""}
                                    </span>
                                  );
                                }
                                // applied(origin 반영) / legacy(null): 반영 완료
                                return (
                                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-success-subtle text-success font-medium whitespace-nowrap">
                                    {t("goalSquashMergedBadge")} {sha ? sha.slice(0, 7) : ""}
                                  </span>
                                );
                              })()}
                              {squashStatus === "blocked" && (
                                <>
                                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-danger-subtle text-danger font-medium whitespace-nowrap">
                                    {t("goalSquashBlockedBadge")}
                                  </span>
                                  {/* 재시도 = squash 승인 재실행 (분할 아님) */}
                                  <button
                                    onClick={() => setSquashApprovalGoalId(goal.id)}
                                    className="text-[10px] px-2 py-0.5 rounded bg-sunken text-muted hover:bg-fg/10 transition-colors whitespace-nowrap"
                                  >
                                    {t("goalSquashRetryBtn")}
                                  </button>
                                </>
                              )}
                              {qaWaiting && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-warning-subtle text-warning font-medium whitespace-nowrap">
                                  {t("goalQaRegressionWaiting")}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                        {goal.goal_model === "goal_as_unit" && (
                          <div className="px-3 pb-1.5">
                            <button
                              type="button"
                              onClick={() => setExpandedGoalDetails((prev) => {
                                const next = new Set(prev);
                                if (next.has(goal.id)) next.delete(goal.id);
                                else next.add(goal.id);
                                return next;
                              })}
                              aria-expanded={expandedGoalDetails.has(goal.id)}
                              className="flex items-center gap-1 text-[11px] text-faint hover:text-muted transition-colors"
                            >
                              <svg
                                className={`w-3 h-3 transition-transform ${expandedGoalDetails.has(goal.id) ? "rotate-90" : ""}`}
                                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                              >
                                <polyline points="9 18 15 12 9 6" />
                              </svg>
                              {t("goalProgressDetail")}
                            </button>
                            {expandedGoalDetails.has(goal.id) && (
                              <div className="mt-1.5">
                                <GoalDetail goalId={goal.id} />
                              </div>
                            )}
                          </div>
                        )}
                        {hasDescription && (
                          <div
                            className="px-3 pt-1.5 pb-1 cursor-pointer group/desc"
                            onClick={() => setExpandedGoalDescs((prev) => {
                              const next = new Set(prev);
                              if (next.has(goal.id)) next.delete(goal.id);
                              else next.add(goal.id);
                              return next;
                            })}
                          >
                            <p className={`text-xs text-muted whitespace-pre-wrap ${expandedGoalDescs.has(goal.id) ? "" : "line-clamp-2"}`}>
                              {goal.description}
                            </p>
                            {!expandedGoalDescs.has(goal.id) && goal.description.length > 120 && (
                              <span className="text-[10px] text-accent group-hover/desc:underline">{t("showMore")}</span>
                            )}
                          </div>
                        )}
                        {goalRefs.length > 0 && (
                          <div className="px-3 pb-1 flex flex-wrap gap-1">
                            {goalRefs.map((ref: string, i: number) => (
                              <span key={i} className="text-[10px] px-1.5 py-0.5 bg-sunken text-muted rounded font-mono truncate max-w-[200px]" title={ref}>
                                {ref.split("/").pop()}
                              </span>
                            ))}
                          </div>
                        )}
                        {/* Inline tasks for this goal — 최대 3개 */}
                        {visibleActiveTasks.length > 0 && (
                          <div className="px-3 pb-2 space-y-1">
                            {visibleActiveTasks.map((tk) => (
                              <div key={tk.id} className="flex items-center gap-2 text-[11px] py-0.5">
                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                  tk.status === "in_progress" ? "bg-accent animate-pulse"
                                  : tk.status === "in_review" ? "bg-review"
                                  : tk.status === "blocked" ? "bg-danger"
                                  : "bg-line"
                                }`} />
                                <span className="text-muted truncate flex-1">{tk.title}</span>
                                {tk.assignee_id && agentMap[tk.assignee_id] && (
                                  <span className="text-[9px] text-faint shrink-0">{agentMap[tk.assignee_id].name}</span>
                                )}
                              </div>
                            ))}
                            {hiddenTaskCount > 0 && (
                              <span className="text-[10px] text-faint pl-3.5">
                                {t("showMoreTasks", { count: hiddenTaskCount })}
                              </span>
                            )}
                          </div>
                        )}
                        {doneTasks.length > 0 && (
                          <div className="px-3 pb-2">
                            <span className="text-[10px] text-faint">{t("doneCount", { count: doneTasks.length })}</span>
                          </div>
                        )}
                      </div>
                    );
                  };

                  const goalSearchLower = goalSearch.trim().toLowerCase();
                  const filteredGoals = goalSearchLower
                    ? goals.filter((g) => (g.title || g.description || "").toLowerCase().includes(goalSearchLower))
                    : goals;
                  const isGoalCompleted = (g: typeof goals[0]) => {
                    // 반영 대기/진행/차단 goal은 사용자 액션이 필요 — 완료 접힘에 숨기면
                    // 승인 배지·버튼이 가려진다 (R1 UX 발견)
                    const squash = g.squash_status;
                    if (squash === "pending_approval" || squash === "triggering" || squash === "blocked" || squash === "resolving") {
                      return false;
                    }
                    // Goal-as-Unit의 완료 = 반영(merged)까지. 태스크가 모두 done이어도
                    // squash_status가 'none'/'approved'면 worktree는 살아 있고 main에는
                    // 아무것도 반영되지 않았다 — 이걸 완료로 접으면 사용자는 끝난 줄 알지만
                    // 실제로는 결과물이 어디에도 없다. 서버 deriveGoalE2EStatus와 같은 기준.
                    if (g.goal_model === "goal_as_unit") {
                      return squash === "merged";
                    }
                    const goalTasks = tasksByGoalId.get(g.id) ?? [];
                    if (goalTasks.length > 0) {
                      // terminal = done|skipped (progress 의미론과 동일)
                      return goalTasks.every((tk) => tk.status === "done" || tk.status === "skipped");
                    }
                    return g.progress >= 100;
                  };
                  const activeGoals = filteredGoals.filter((g) => !isGoalCompleted(g));
                  const completedGoals = filteredGoals.filter((g) => isGoalCompleted(g));
                  const visibleCompleted = showCompletedGoals
                    ? completedGoals
                    : completedGoals.slice(0, COMPLETED_GOALS_THRESHOLD);
                  const hiddenCompletedCount = completedGoals.length - visibleCompleted.length;

                  return (
                    <>
                      {/* Active 목표 */}
                      {activeGoals.map(renderGoalCard)}

                      {/* 완료 목표 섹션 */}
                      {completedGoals.length > 0 && (
                        <div className="mt-4">
                          <button
                            onClick={() => setShowCompletedGoals((v) => !v)}
                            className="flex items-center gap-2 mb-2 text-xs text-faint hover:text-muted transition-colors"
                          >
                            <svg
                              className={`w-3 h-3 transition-transform ${showCompletedGoals ? "rotate-90" : ""}`}
                              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                            >
                              <polyline points="9 18 15 12 9 6" />
                            </svg>
                            <span>{t("completedGoals")} ({completedGoals.length})</span>
                          </button>
                          {showCompletedGoals && (
                            <>
                              {visibleCompleted.map(renderGoalCard)}
                              {hiddenCompletedCount > 0 && (
                                <button
                                  onClick={() => setShowCompletedGoals(true)}
                                  className="text-[11px] text-faint hover:text-muted transition-colors"
                                >
                                  {t("showMoreGoals", { count: hiddenCompletedCount })}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </>
                  );
                })()}
              </section>

              {/* Tasks Section */}
              <section className="mb-8">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-muted uppercase tracking-wider">
                    {t("tasks")}
                  </h2>
                  <div className="flex items-center gap-2">
                    {autopilotMode !== "off" && queueRunning && (
                      <span
                        className="text-[10px] text-accent flex items-center gap-1 cursor-help"
                        title={t("concurrencyHint")}
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                        Auto
                        {queueConcurrency > 0 &&
                          ` · ${agents.filter((a) => a.status === "working").length}/${queueConcurrency}`}
                      </span>
                    )}
                    {pendingApprovalCount > 0 && currentProjectId && (
                      <button
                        onClick={async () => {
                          let result: { approved: number; excluded: number };
                          try {
                            result = await guardMutation(api.orchestration.approveAll(currentProjectId));
                          } catch {
                            return; // 실패 토스트는 guardMutation
                          }
                          // fix-파생·리뷰 실패·사람 승인 필수 태스크는 bulk에서 제외 — 개별 승인 유도
                          if (result.excluded > 0) {
                            showToast(t("approveAllExcluded", { count: result.excluded }), "info");
                          }
                          loadData();
                        }}
                        className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg font-medium bg-warning-subtle text-warning hover:bg-warning-subtle transition-colors"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
                        {t("approveAll", { count: pendingApprovalCount })}
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        if (!currentProjectId) return;
                        let result: { count: number };
                        try {
                          result = await guardMutation(api.orchestration.reassignAll(currentProjectId));
                        } catch {
                          return; // 실패 토스트는 guardMutation
                        }
                        showToast(t("reassignAllDone", { count: result.count }), "success");
                        loadData();
                      }}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg font-medium bg-sunken text-muted hover:bg-fg/5 transition-colors"
                    >
                      {t("reassignAll")}
                    </button>
                    <button
                      onClick={handleToggleQueue}
                      disabled={queueToggling}
                      className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg font-medium transition-colors ${
                        queueToggling
                          ? "bg-sunken text-faint cursor-wait"
                          : queueRunning
                            ? "bg-danger-subtle text-danger hover:bg-danger-subtle"
                            : "bg-accent/10 text-accent hover:bg-accent/20"
                      }`}
                    >
                      {queueRunning && !queueToggling && (
                        <span className="w-1.5 h-1.5 rounded-full bg-danger animate-pulse" />
                      )}
                      {queueToggling ? "..." : queueRunning ? t("stopQueue") : t("runQueue")}
                    </button>
                  </div>
                </div>
                {queueRunning && !queuePaused && (
                  <p className="text-[10px] text-accent flex items-center gap-1 mb-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                    {t("queueRunning")}
                  </p>
                )}
                <div className="relative">
                  {/* Rate limit paused — inline banner (not modal) */}
                  {queuePaused && queuePausedInfo && (() => {
                    void countdownTick;
                    const now = Date.now();
                    const retryAt = queuePausedInfo.nextRetryAt
                      ? new Date(queuePausedInfo.nextRetryAt).getTime()
                      : null;
                    const msLeft = retryAt ? Math.max(0, retryAt - now) : null;
                    const minutesLeft = msLeft != null ? Math.floor(msLeft / 60000) : null;
                    const secondsLeft = msLeft != null ? Math.floor((msLeft % 60000) / 1000) : null;
                    const timeDisplay = minutesLeft != null && secondsLeft != null
                      ? (minutesLeft > 0 ? `${minutesLeft}:${String(secondsLeft).padStart(2, "0")}` : `${secondsLeft}${t("secondsSuffix")}`)
                      : null;

                    return (
                      <div className="mb-3 flex items-center gap-3 px-4 py-3 bg-sunken border border-line rounded-lg" role="status" aria-live="polite" aria-atomic="true">
                        <div className="w-8 h-8 rounded-full bg-line flex items-center justify-center flex-shrink-0">
                          <svg className="w-4 h-4 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12 6 12 12 16 14" />
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-muted">
                            {t("rateLimitPausedBrief")}
                            {timeDisplay && <span className="font-mono font-medium ml-1 tabular-nums">{timeDisplay}</span>}
                          </p>
                        </div>
                        <button
                          onClick={handleResumeQueue}
                          className="text-xs px-3 py-1.5 bg-line hover:bg-fg/10 text-muted rounded-md transition-colors flex-shrink-0"
                        >
                          {t("resumeNow")}
                        </button>
                      </div>
                    );
                  })()}
                  {/* Queue stopped by rate limit — inline banner */}
                  {queueStoppedByRateLimit && !queueRunning && (
                    <div className="mb-3 flex items-center gap-3 px-4 py-3 bg-warning-subtle border border-warning rounded-lg" role="status">
                        <div className="w-8 h-8 rounded-full bg-warning-subtle flex items-center justify-center flex-shrink-0">
                          <svg className="w-4 h-4 text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="12" y1="8" x2="12" y2="12" />
                            <line x1="12" y1="16" x2="12.01" y2="16" />
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-warning">{t("rateLimitStoppedBrief")}</p>
                        </div>
                        <button
                          onClick={handleToggleQueue}
                          disabled={queueToggling}
                          className="text-xs px-3 py-1.5 bg-warning-subtle hover:bg-warning-subtle text-warning rounded-md transition-colors disabled:opacity-50 flex-shrink-0"
                        >
                          {t("restartQueue")}
                        </button>
                    </div>
                  )}
                  <TaskList tasks={tasks} agents={agents} projectId={currentProjectId ?? undefined} onUpdate={loadData} autopilotMode={autopilotMode} onAddGoal={handleAddGoal} onOpenSpec={setSpecGoalId} />
                </div>
              </section>
            </div>

            {/* Side panel — sticky, fixed width, scrollable within */}
            <div className="w-full shrink-0 space-y-4 xl:sticky xl:top-0 xl:max-h-[calc(100vh-140px)] xl:w-[360px] xl:self-start xl:overflow-y-auto">
              {/* Task Timeline */}
              <div className="border border-line rounded-xl overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2.5 bg-sunken border-b border-line">
                  {hasActiveTasks ? (
                    <span className="w-2 h-2 rounded-full bg-accent animate-pulse shrink-0" />
                  ) : (
                    <span className="w-2 h-2 rounded-full bg-line shrink-0" />
                  )}
                  <span className="text-xs font-medium text-muted">
                    {t("taskTimeline")}
                  </span>
                  {hasActiveTasks && (
                    <span className="text-[10px] text-faint">
                      {activeTasks.length} {t("active")}
                    </span>
                  )}
                </div>
                <div className={`${hasActiveTasks ? "h-[300px]" : "h-[120px]"} bg-sunken transition-all`}>
                  <TaskTimeline activeTasks={activeTasks} agents={agents} />
                </div>
              </div>

              {/* Direct Prompt — only when no task is running */}
              {!hasActiveTasks && agents.length > 0 && (
                <div className="border border-line rounded-xl overflow-hidden">
                  <div className="px-4 py-2.5 bg-sunken border-b border-line flex items-center justify-between">
                    <h2 className="text-xs font-medium text-muted">
                      {t("directPromptTitle")}
                    </h2>
                    {/* Mode toggle */}
                    <button
                      onClick={() => {
                        setMultiAgentMode((m) => !m);
                        setMultiAgentIds([]);
                        setMultiPromptResults([]);
                        setMultiPromptProgress(null);
                      }}
                      disabled={panelPromptSending}
                      className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors disabled:opacity-40 ${
                        multiAgentMode
                          ? "bg-accent/10 border-accent text-accent"
                          : "bg-sunken border-line text-muted hover:border-accent"
                      }`}
                    >
                      {multiAgentMode ? t("multiAgentMode") : t("singleAgentMode")}
                    </button>
                  </div>
                  <div className="p-3 bg-sunken space-y-2">
                    {multiAgentMode ? (
                      <>
                        {/* Multi-agent checkbox list */}
                        <div className="space-y-1">
                          <p className="text-[10px] text-faint">{t("selectMultipleAgents")}</p>
                          <div className="max-h-[120px] overflow-y-auto space-y-1 border border-line-soft rounded-lg p-2">
                            {agents.map((a) => {
                              const isSelected = multiAgentIds.includes(a.id);
                              const order = multiAgentIds.indexOf(a.id);
                              return (
                                <label
                                  key={a.id}
                                  className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer transition-colors ${
                                    isSelected
                                      ? "bg-accent/10"
                                      : "hover:bg-fg/5"
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    disabled={panelPromptSending}
                                    onChange={() => toggleMultiAgentId(a.id)}
                                    className="rounded border-line text-accent focus:ring-accent disabled:opacity-50"
                                  />
                                  <span className="flex-1 text-xs text-muted">
                                    {a.name}
                                    <span className="ml-1 text-[10px] text-faint">({a.role})</span>
                                  </span>
                                  {isSelected && (
                                    <span className="text-[10px] font-medium text-accent w-4 text-center">
                                      {order + 1}
                                    </span>
                                  )}
                                </label>
                              );
                            })}
                          </div>
                          {multiAgentIds.length > 0 && (
                            <p className="text-[10px] text-faint">
                              {t("agentOrder")}: {multiAgentIds.map((id) => agents.find((a) => a.id === id)?.name ?? id).join(" → ")}
                            </p>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={panelPromptMessage}
                            onChange={(e) => setPanelPromptMessage(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") handleSendMultiPrompt(); }}
                            disabled={panelPromptSending || multiAgentIds.length < 2}
                            placeholder={t("promptPlaceholder")}
                            className="flex-1 text-xs text-muted bg-sunken rounded-lg px-3 py-1.5 border border-line focus:outline-none focus:border-accent disabled:opacity-50"
                          />
                          <button
                            onClick={handleSendMultiPrompt}
                            disabled={panelPromptSending || !panelPromptMessage.trim() || multiAgentIds.length < 2}
                            className="px-3 py-1.5 text-xs font-medium bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                          >
                            {panelPromptSending && multiPromptProgress
                              ? t("multiPromptRunning", { current: multiPromptProgress.current, total: multiPromptProgress.total })
                              : t("sendPrompt")}
                          </button>
                        </div>
                        {/* Multi-prompt results */}
                        {multiPromptResults.length > 0 && (
                          <div className="mt-2 space-y-2 max-h-[200px] overflow-y-auto">
                            {multiPromptResults.map((r, i) => (
                              <div key={r.agentId + i} className="border border-line-soft rounded-lg overflow-hidden">
                                <div className="px-2 py-1 bg-sunken flex items-center gap-1.5">
                                  <span className="text-[10px] font-medium text-muted">
                                    {i + 1}. {r.agentName}
                                  </span>
                                </div>
                                <div className="px-3 py-2 text-[11px] text-muted whitespace-pre-wrap break-words max-h-[80px] overflow-y-auto">
                                  {r.result}
                                </div>
                              </div>
                            ))}
                            {!panelPromptSending && multiPromptResults.length === multiAgentIds.length && (
                              <p className="text-[10px] text-center text-success font-medium">
                                {t("multiPromptComplete")}
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <select
                          value={panelPromptAgentId}
                          onChange={(e) => setPanelPromptAgentId(e.target.value)}
                          disabled={panelPromptSending}
                          className="w-full text-xs text-muted bg-sunken rounded-lg px-3 py-1.5 border border-line focus:outline-none focus:border-accent disabled:opacity-50"
                        >
                          <option value="">{t("selectAgent")}</option>
                          {agents.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} ({a.role})
                            </option>
                          ))}
                        </select>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={panelPromptMessage}
                            onChange={(e) => setPanelPromptMessage(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") handleSendPanelPrompt(); }}
                            disabled={panelPromptSending || !panelPromptAgentId}
                            placeholder={t("promptPlaceholder")}
                            className="flex-1 text-xs text-muted bg-sunken rounded-lg px-3 py-1.5 border border-line focus:outline-none focus:border-accent disabled:opacity-50"
                          />
                          <button
                            onClick={handleSendPanelPrompt}
                            disabled={panelPromptSending || !panelPromptMessage.trim() || !panelPromptAgentId}
                            className="px-3 py-1.5 text-xs font-medium bg-fg text-canvas rounded-lg hover:bg-fg/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                          >
                            {panelPromptSending ? t("promptRunning") : t("sendPrompt")}
                          </button>
                        </div>
                      </>
                    )}
                    {panelPromptToast && (
                      <p className="text-[10px] text-muted">{panelPromptToast}</p>
                    )}
                  </div>
                </div>
              )}

              {/* Recent Activity */}
              <div className="border border-line rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 bg-sunken border-b border-line">
                  <h2 className="text-xs font-medium text-muted">
                    {t("recentActivity")}
                  </h2>
                </div>
                <div className="max-h-[200px] overflow-y-auto bg-sunken">
                  <ActivityFeed projectId={currentProjectId!} />
                </div>
              </div>
            </div>
          </div>
        ) : tab === "agents" ? (
          <OrgChart
            agents={agents}
            tasks={tasks}
            onAddAgent={handleAddAgent}
            onAgentDeleted={() => { setSelectedAgentId(null); loadData(); }}
            onAgentKilled={() => { setSelectedAgentId(null); loadData(); }}
            onDuplicateTeam={() => setDuplicateTeamConfirm(true)}
          />
        ) : tab === "kanban" ? (
          <KanbanBoard tasks={tasks} agents={agents} onUpdate={loadData} />
        ) : (
          <section>
            <VerificationLog projectId={currentProjectId!} />
          </section>
        ))}
      </div>
    </div>
  );
}
