import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type SmartTeamCandidate, type SmartTeamPreview } from "../lib/api";

interface Preset {
  name: string;
  role: string;
  description: string;
  systemPrompt?: string;
}

interface TeamPreset {
  id: string;
  name: string;
  description: string;
  agents: Array<{ name: string; role: string }>;
}

interface ScannedAgent {
  file: string;
  lines: number;
  agentName: string;
}

interface SuggestedAgent extends Omit<SmartTeamCandidate, "key" | "matchedAgentId" | "action" | "warnings" | "provider" | "model" | "systemPrompt" | "reason" | "source"> {
  key?: string;
  matchedAgentId?: string | null;
  name: string;
  role: string;
  reason?: string;
  systemPrompt?: string;
  source?: string; // "ai" | "preset" | "tech-stack" | "project-agents"
  model?: string | null; // 설계자가 배정한 모델 (opus|sonnet|haiku) — 없으면 role 기본
  provider?: "claude" | "codex" | null;
  action?: SmartTeamCandidate["action"];
  warnings?: string[];
}

interface AddAgentDialogProps {
  projectId: string;
  mission?: string;
  goal?: { id: string; title: string; description?: string } | null;
  /** true면 열리자마자 스마트 팀 구성으로 진입 (진행 중 설계 재합류/캐시 확인용) */
  initialSmart?: boolean;
  existingAgents?: Array<{ id: string; name: string; role: string }>;
  onCreated: (agent: any) => void;
  onClose: () => void;
}

const PRESET_I18N: Record<string, { nameKey: string; descKey: string }> = {
  cto: { nameKey: "presetCtoName", descKey: "presetCtoDesc" },
  backend: { nameKey: "presetBackendName", descKey: "presetBackendDesc" },
  frontend: { nameKey: "presetFrontendName", descKey: "presetFrontendDesc" },
  ux: { nameKey: "presetUxName", descKey: "presetUxDesc" },
  qa: { nameKey: "presetQaName", descKey: "presetQaDesc" },
  reviewer: { nameKey: "presetReviewerName", descKey: "presetReviewerDesc" },
  marketer: { nameKey: "presetMarketerName", descKey: "presetMarketerDesc" },
  devops: { nameKey: "presetDevopsName", descKey: "presetDevopsDesc" },
};

const SMART_ROLE_OPTIONS = ["cto", "pm", "backend", "frontend", "ux", "devops", "qa", "reviewer", "coder", "designer", "marketer", "custom"];

type Mode = "pick" | "smart" | "presets" | "individual";
type IndividualStep = "select" | "preview";

export function AddAgentDialog({
  initialSmart,
  projectId,
  mission,
  goal,
  existingAgents = [],
  onCreated,
  onClose,
}: AddAgentDialogProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("pick");

  // Smart team state
  const [scanLoading, setScanLoading] = useState(false);
  const [scannedAgents, setScannedAgents] = useState<ScannedAgent[]>([]);
  const [suggestedAgents, setSuggestedAgents] = useState<SuggestedAgent[]>([]);
  const [selectedSmartAgents, setSelectedSmartAgents] = useState<Set<string>>(new Set());
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [teamPreview, setTeamPreview] = useState<SmartTeamPreview | null>(null);

  // Team preset state
  const [teamPresets, setTeamPresets] = useState<TeamPreset[]>([]);
  const [applyingPreset, setApplyingPreset] = useState<string | null>(null);

  // Individual state
  const [presets, setPresets] = useState<Preset[]>([]);
  const [indStep, setIndStep] = useState<IndividualStep>("select");
  const [selectedName, setSelectedName] = useState("");
  const [selectedRole, setSelectedRole] = useState("");
  const [editablePrompt, setEditablePrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedParentId, setSelectedParentId] = useState<string>("");
  const [customName, setCustomName] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Keep keyboard focus inside the modal and return it to the launcher on close.
  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      previousFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [indStep, mode]);

  // Load individual presets
  useEffect(() => {
    api.agents.presets().then(setPresets).catch(() => {
      setPresets([
        { name: "Backend Developer", role: "backend", description: "" },
        { name: "Frontend Developer", role: "frontend", description: "" },
        { name: "Reviewer", role: "reviewer", description: "" },
      ]);
    });
  }, []);

  // Load team presets
  useEffect(() => {
    if (mode === "presets") {
      api.agents.teamPresets().then(setTeamPresets).catch(() => setTeamPresets([]));
    }
  }, [mode]);

  // Enter smart mode: scan + suggest — 서버가 설계 결과를 캐시하므로(10분)
  // 새로고침/모달 이탈 후 재진입은 즉시 반환되거나 진행 중 설계에 합류한다
  const enterSmartMode = async (refresh = false) => {
    setMode("smart");
    setScanLoading(true);
    setScannedAgents([]);
    setSuggestedAgents([]);
    setSelectedSmartAgents(new Set());
    setTeamError(null);
    setTeamPreview(null);

    try {
      const [scanResult, suggestResult] = await Promise.allSettled([
        api.agents.scanProject(projectId),
        goal?.id
          ? api.agents.teamPreview(projectId, goal.id, refresh)
          : api.agents.suggest(mission ?? "", projectId, undefined, "ai", refresh),
      ]);

      const scanned: ScannedAgent[] =
        scanResult.status === "fulfilled" ? scanResult.value?.agents ?? [] : [];
      const preview = goal?.id && suggestResult.status === "fulfilled"
        ? suggestResult.value as SmartTeamPreview
        : null;
      const suggested: SuggestedAgent[] = preview
        ? preview.candidates
        : suggestResult.status === "fulfilled" ? (suggestResult.value as SuggestedAgent[]) : [];

      setScannedAgents(preview ? [] : scanned);
      setSuggestedAgents(suggested);
      setTeamPreview(preview);

      // Existing duplicates and name conflicts require an explicit choice/edit.
      const allKeys = new Set([
        ...(preview ? [] : scanned.map((a) => `scanned:${a.file}`)),
        ...suggested.flatMap((candidate, i) =>
          candidate.action === "keep" || candidate.action === "conflict"
            ? []
            : [candidate.key ?? `suggested:${i}`]),
      ]);
      setSelectedSmartAgents(allKeys);
    } finally {
      setScanLoading(false);
    }
  };

  // initialSmart: 진행 중 설계 재합류 / 미확인 결과 즉시 확인용 — 열리자마자 스마트 모드 진입
  useEffect(() => {
    if (initialSmart) enterSmartMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleSmartAgent = (key: string) => {
    setSelectedSmartAgents((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const updateSmartAgent = (index: number, patch: Partial<SuggestedAgent>) => {
    setSuggestedAgents((current) => current.map((agent, candidateIndex) =>
      candidateIndex === index ? { ...agent, ...patch } : agent));
  };

  // Create full team from smart selection
  const handleCreateSmartTeam = async (all: boolean) => {
    setCreatingTeam(true);
    setTeamError(null);

    try {
      if (goal?.id && teamPreview) {
        const selectedCandidates = suggestedAgents.filter((agent, index) => {
          if (agent.action === "keep") return false;
          if (all) return agent.action !== "conflict";
          return selectedSmartAgents.has(agent.key ?? `suggested:${index}`);
        }).map((agent, index) => ({
          key: agent.key ?? `suggested:${index}`,
          matchedAgentId: agent.matchedAgentId ?? null,
          name: agent.name,
          role: agent.role,
          reason: agent.reason ?? "",
          systemPrompt: agent.systemPrompt ?? "",
          source: agent.source ?? "preset",
          model: agent.model ?? null,
          provider: agent.provider ?? null,
          action: agent.action ?? "add",
          warnings: agent.warnings ?? [],
        })) satisfies SmartTeamCandidate[];
        if (selectedCandidates.length === 0) {
          setTeamError(t("smartTeamNothingSelected"));
          setCreatingTeam(false);
          return;
        }
        const result = await api.agents.applyTeamPreview(projectId, goal.id, selectedCandidates);
        [...result.created, ...result.updated].forEach((agent) => onCreated(agent));
        onClose();
        return;
      }

      // Determine which agents to create
      const toCreate: Array<{ name: string; role: string; fromProject: boolean; systemPrompt?: string; model?: string }> = [];

      for (const sa of scannedAgents) {
        const key = `scanned:${sa.file}`;
        if (all || selectedSmartAgents.has(key)) {
          toCreate.push({ name: sa.agentName, role: inferRole(sa.agentName), fromProject: true });
        }
      }
      for (const [i, sg] of suggestedAgents.entries()) {
        const key = `suggested:${i}`;
        if (all || selectedSmartAgents.has(key)) {
          toCreate.push({ name: sg.name, role: sg.role, fromProject: false, systemPrompt: sg.systemPrompt, model: sg.model ?? undefined });
        }
      }

      if (toCreate.length === 0) {
        setTeamError("선택된 에이전트가 없습니다.");
        setCreatingTeam(false);
        return;
      }

      // Find coordinator (cto/pm) to set as root
      const ctoIdx = toCreate.findIndex((a) => a.role === "cto" || a.role === "pm" || a.name.toLowerCase().includes("cto"));
      let rootAgent: any = null;

      if (ctoIdx !== -1) {
        const ctoData = toCreate[ctoIdx];
        rootAgent = await api.agents.create({
          project_id: projectId,
          name: ctoData.name,
          role: ctoData.role,
          system_prompt: ctoData.systemPrompt ?? "",
          prompt_source: ctoData.systemPrompt ? "preset" : "auto",
          model: ctoData.model,
        });
        toCreate.splice(ctoIdx, 1);
      }

      // Create the rest
      const created: any[] = rootAgent ? [rootAgent] : [];
      for (const agent of toCreate) {
        const a = await api.agents.create({
          project_id: projectId,
          name: agent.name,
          role: agent.role,
          system_prompt: agent.systemPrompt ?? "",
          prompt_source: agent.systemPrompt ? "preset" : "auto",
          parent_id: rootAgent?.id ?? undefined,
          model: agent.model,
        });
        created.push(a);
      }

      // Notify parent about all created agents (call onCreated for each)
      if (created.length > 0) {
        created.forEach((a) => onCreated(a));
      }
    } catch (err: any) {
      setTeamError(err.message ?? "팀 생성 실패");
      setCreatingTeam(false);
    }
  };

  // Apply team preset
  const handleApplyTeamPreset = async (presetId: string) => {
    setApplyingPreset(presetId);
    try {
      const result = await api.agents.createTeam(projectId, presetId);
      const agents = Array.isArray(result) ? result : result?.agents ?? [];
      agents.forEach((a: any) => onCreated(a));
      if (agents.length === 0) onClose();
    } catch (err: any) {
      setError(err.message ?? t("createAgentFailed"));
      setApplyingPreset(null);
    }
  };

  // Individual: select preset
  const handleSelectPreset = (preset: Preset) => {
    setSelectedName(preset.name);
    setSelectedRole(preset.role);
    setEditablePrompt(preset.systemPrompt ?? "");
    setIndStep("preview");
  };

  // Individual: custom agent
  const handleCustomNext = () => {
    if (!customName.trim()) return;
    setSelectedName(customName.trim());
    setSelectedRole("custom");
    setEditablePrompt(`You are a ${customName.trim()}. Implement assigned tasks following best practices.`);
    setIndStep("preview");
  };

  // Individual: confirm create
  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const agent = await api.agents.create({
        project_id: projectId,
        name: selectedName,
        role: selectedRole,
        system_prompt: editablePrompt,
        parent_id: selectedParentId || undefined,
      });
      onCreated(agent);
    } catch (err: any) {
      setError(err.message || t("createAgentFailed"));
      setCreating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-2 dark:bg-black/50 sm:p-4"
      onClick={() => {
        // 설계 로딩 중 backdrop 오클릭으로 모달이 닫히는 사고 방지 — 명시적 취소/뒤로만 허용
        if (mode === "smart" && scanLoading) return;
        onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-agent-dialog-title"
        aria-busy={scanLoading || creatingTeam || creating}
        className="max-h-[calc(100dvh-1rem)] w-[540px] max-w-full overflow-x-hidden overflow-y-auto rounded-xl bg-surface shadow-lg sm:max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mode picker */}
        {mode === "pick" && <ModePicker t={t} onSelect={(m) => { if (m === "smart") enterSmartMode(); else setMode(m); }} onClose={onClose} />}

        {/* Smart team */}
        {mode === "smart" && (
          <SmartTeamPanel
            t={t}
            onRedesign={() => enterSmartMode(true)}
            loading={scanLoading}
            scannedAgents={scannedAgents}
            suggestedAgents={suggestedAgents}
            selected={selectedSmartAgents}
            onToggle={toggleSmartAgent}
            onUpdate={updateSmartAgent}
            onCreate={handleCreateSmartTeam}
            creating={creatingTeam}
            error={teamError}
            onBack={() => setMode("pick")}
            onClose={onClose}
            preview={teamPreview}
          />
        )}

        {/* Team presets */}
        {mode === "presets" && (
          <TeamPresetsPanel
            t={t}
            teamPresets={teamPresets}
            applyingPreset={applyingPreset}
            onApply={handleApplyTeamPreset}
            onBack={() => setMode("pick")}
            onClose={onClose}
          />
        )}

        {/* Individual */}
        {mode === "individual" && indStep === "select" && (
          <IndividualSelectPanel
            t={t}
            presets={presets}
            customName={customName}
            onCustomNameChange={setCustomName}
            onSelectPreset={handleSelectPreset}
            onCustomNext={handleCustomNext}
            onBack={() => setMode("pick")}
            onClose={onClose}
          />
        )}
        {mode === "individual" && indStep === "preview" && (
          <IndividualPreviewPanel
            t={t}
            selectedName={selectedName}
            selectedRole={selectedRole}
            editablePrompt={editablePrompt}
            onPromptChange={setEditablePrompt}
            existingAgents={existingAgents}
            selectedParentId={selectedParentId}
            onParentChange={setSelectedParentId}
            creating={creating}
            error={error}
            onCreate={handleCreate}
            onBack={() => setIndStep("select")}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}

/* ─── Sub-panels ─── */

function ModePicker({ t, onSelect, onClose }: { t: any; onSelect: (m: Mode) => void; onClose: () => void }) {
  return (
    <>
      <div className="px-5 py-4 border-b border-line-soft">
        <h3 id="add-agent-dialog-title" className="text-sm font-semibold text-fg">{t("addAgentTitle")}</h3>
      </div>
      <div className="p-5 space-y-3">
        {/* Smart */}
        <button
          onClick={() => onSelect("smart")}
          className="w-full text-left px-4 py-3.5 rounded-xl border-2 border-accent/25 bg-accent/10 hover:border-accent hover:bg-accent/20 transition-colors"
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold text-accent">{t("smartTeamSetup")}</span>
            <span className="text-[10px] px-1.5 py-0.5 bg-accent/20 text-accent rounded font-medium">추천</span>
          </div>
          <p className="text-xs text-muted">{t("smartTeamDesc")}</p>
        </button>

        {/* Presets */}
        <button
          onClick={() => onSelect("presets")}
          className="w-full text-left px-4 py-3.5 rounded-xl border border-line hover:border-line hover:bg-fg/5 transition-colors"
        >
          <p className="text-sm font-medium text-fg mb-0.5">{t("teamPresets")}</p>
          <p className="text-xs text-muted">{t("teamPresetsDesc")}</p>
        </button>

        {/* Individual */}
        <button
          onClick={() => onSelect("individual")}
          className="w-full text-left px-4 py-3.5 rounded-xl border border-line hover:border-line hover:bg-fg/5 transition-colors"
        >
          <p className="text-sm font-medium text-fg mb-0.5">{t("addIndividual")}</p>
          <p className="text-xs text-muted">{t("addIndividualDesc")}</p>
        </button>
      </div>
      <div className="px-5 py-3 border-t border-line-soft flex justify-end">
        <button onClick={onClose} className="text-xs text-faint hover:text-muted">
          {t("cancel")}
        </button>
      </div>
    </>
  );
}

function SmartTeamPanel({
  t, loading, scannedAgents, suggestedAgents, selected, onToggle, onUpdate, onCreate, creating, error, onBack, onClose, onRedesign, preview,
}: {
  t: any;
  onRedesign: () => void;
  loading: boolean;
  scannedAgents: ScannedAgent[];
  suggestedAgents: SuggestedAgent[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  onUpdate: (index: number, patch: Partial<SuggestedAgent>) => void;
  onCreate: (all: boolean) => void;
  creating: boolean;
  error: string | null;
  onBack: () => void;
  onClose: () => void;
  preview: SmartTeamPreview | null;
}) {
  const hasAny = scannedAgents.length > 0 || suggestedAgents.length > 0;
  const hasRecommendedChanges = suggestedAgents.some((agent) => agent.action !== "keep" && agent.action !== "conflict");
  // AI 모드로 요청했지만 프로젝트 자체 역할 정의(.claude/agents/)가 있어 AI 설계가 생략된 경우 —
  // project-agents source가 곧 "AI 건너뜀" 신호다 (서버 agents.ts: hasProjectDefs 게이트)
  const aiSkipped = suggestedAgents.some((s) => s.source === "project-agents");

  return (
    <>
      <div className="px-5 py-4 border-b border-line-soft flex items-center gap-3">
        <button type="button" onClick={onBack} aria-label={t("back")} className="text-faint hover:text-muted">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <h3 id="add-agent-dialog-title" className="text-sm font-semibold text-fg">{t("smartTeamSetup")}</h3>
      </div>

      <div className="p-5">
        {loading && (
          <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 py-8 text-xs text-faint">
            <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeOpacity="0.3" />
              <path d="M21 12a9 9 0 00-9-9" />
            </svg>
            {t("aiDesigningTeam")}
          </div>
        )}

        {!loading && !hasAny && (
          <p className="text-xs text-faint text-center py-6">
            분석 결과가 없습니다. 팀 프리셋을 사용해보세요.
          </p>
        )}

        {!loading && hasAny && (
          <div className="space-y-4">
            {preview && (
              <div className="rounded-lg border border-accent/20 bg-accent/5 px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-accent">{t("smartTeamGoalFocus")}</p>
                <p className="mt-1 text-xs font-medium text-fg">{preview.goal.title}</p>
                <p className="mt-1 text-[10px] text-muted">
                  {t("smartTeamDiffSummary", {
                    preserved: preview.preservedExisting,
                    additions: preview.additions,
                    updates: preview.updates,
                    conflicts: preview.conflicts,
                    tasks: preview.goal.taskCount,
                  })}
                </p>
              </div>
            )}
            {/* Scanned agents */}
            {scannedAgents.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                  </svg>
                  <span className="text-xs font-semibold text-muted">
                    {t("projectAgentsFound")} ({scannedAgents.length})
                  </span>
                </div>
                <p className="text-[11px] text-faint mb-2">{t("projectAgentsFoundDesc")}</p>
                <div className="space-y-1.5">
                  {scannedAgents.map((sa) => {
                    const key = `scanned:${sa.file}`;
                    return (
                      <label key={key} className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-line-soft bg-sunken cursor-pointer hover:bg-fg/5 transition-colors">
                        <input
                          type="checkbox"
                          checked={selected.has(key)}
                          onChange={() => onToggle(key)}
                          className="accent-accent"
                        />
                        <div className="flex-1 min-w-0">
                          <span className="text-xs text-success font-mono">{sa.file}</span>
                          <span className="text-[10px] text-faint ml-1.5">({sa.lines}줄)</span>
                          <span className="text-xs text-faint mx-1.5">→</span>
                          <span className="text-xs text-muted font-medium">{sa.agentName}</span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Suggested agents */}
            {suggestedAgents.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
                    <path d="M12 2a10 10 0 110 20A10 10 0 0112 2z" strokeOpacity="0.3" />
                    <path d="M12 6v6l4 2" />
                  </svg>
                  <span className="text-xs font-semibold text-muted">
                    {t("missionBasedSuggest")}
                  </span>
                  {!aiSkipped && (
                    <button
                      onClick={onRedesign}
                      className="ml-auto text-[10px] px-1.5 py-0.5 rounded text-faint hover:text-accent hover:bg-accent/10 transition-colors"
                      title={t("redesignTeamHint")}
                    >
                      ↻ {t("redesignTeam")}
                    </button>
                  )}
                </div>
                {aiSkipped && (
                  <div className="flex items-start gap-1.5 mb-2 text-[11px] text-warning bg-warning-subtle border border-warning/15 rounded-lg px-2.5 py-1.5">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span>{t("aiSkippedProjectAgents")}</span>
                  </div>
                )}
                <div className="space-y-2">
                  {suggestedAgents.map((sg, i) => {
                    const key = sg.key ?? `suggested:${i}`;
                    const isKept = sg.action === "keep";
                    return (
                      <div key={key} className={`rounded-lg border px-3 py-2.5 ${sg.action === "conflict" ? "border-warning/35 bg-warning-subtle" : "border-line-soft bg-sunken"}`}>
                        <div className="flex items-start gap-2.5">
                          <input
                            type="checkbox"
                            aria-label={t("smartTeamSelectAgent", { name: sg.name })}
                            checked={selected.has(key)}
                            disabled={isKept}
                            onChange={() => onToggle(key)}
                            className="mt-0.5 accent-accent"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <input
                                aria-label={t("smartTeamAgentName", { name: sg.name })}
                                value={sg.name}
                                disabled={isKept}
                                onChange={(event) => onUpdate(i, { name: event.target.value })}
                                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-xs font-medium text-fg outline-none disabled:text-muted"
                              />
                              {sg.source === "ai" && <span className="rounded bg-accent/20 px-1 py-0.5 text-[9px] font-medium text-accent">{t("aiDesignedBadge")}</span>}
                              {sg.action && <span className="rounded bg-fg/10 px-1 py-0.5 text-[9px] text-muted">{t(`smartTeamAction_${sg.action}`)}</span>}
                            </div>
                            {sg.reason && <p className="mt-1 text-[10px] italic text-faint">{sg.reason}</p>}
                            {preview && (
                              <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                                <label className="text-[9px] text-faint">
                                  {t("smartTeamRole")}
                                  <select aria-label={t("smartTeamRoleFor", { name: sg.name })} value={sg.role} disabled={isKept} onChange={(event) => onUpdate(i, { role: event.target.value })} className="mt-0.5 w-full rounded border border-line bg-surface px-1.5 py-1 text-[10px] text-fg">
                                    {SMART_ROLE_OPTIONS.map((role) => <option key={role} value={role}>{role}</option>)}
                                  </select>
                                </label>
                                <label className="text-[9px] text-faint">
                                  {t("smartTeamProvider")}
                                  <select aria-label={t("smartTeamProviderFor", { name: sg.name })} value={sg.provider ?? ""} disabled={isKept} onChange={(event) => onUpdate(i, { provider: event.target.value === "" ? null : event.target.value as "claude" | "codex" })} className="mt-0.5 w-full rounded border border-line bg-surface px-1.5 py-1 text-[10px] text-fg">
                                    <option value="">{t("smartTeamInherit")}</option><option value="claude">Claude</option><option value="codex">Codex</option>
                                  </select>
                                </label>
                                <label className="text-[9px] text-faint">
                                  {t("smartTeamModel")}
                                  <select aria-label={t("smartTeamModelFor", { name: sg.name })} value={sg.model ?? ""} disabled={isKept} onChange={(event) => onUpdate(i, { model: event.target.value || null })} className="mt-0.5 w-full rounded border border-line bg-surface px-1.5 py-1 text-[10px] text-fg">
                                    <option value="">{t("smartTeamRoleDefault")}</option><option value="opus">opus</option><option value="sonnet">sonnet</option><option value="haiku">haiku</option>
                                  </select>
                                </label>
                              </div>
                            )}
                            {preview && (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-[9px] text-faint">{t("smartTeamRoleInstructions")}</summary>
                                <textarea aria-label={t("smartTeamPromptFor", { name: sg.name })} value={sg.systemPrompt ?? ""} disabled={isKept} onChange={(event) => onUpdate(i, { systemPrompt: event.target.value })} rows={4} className="mt-1.5 w-full resize-y rounded border border-line bg-surface px-2 py-1.5 text-[10px] leading-4 text-fg" />
                              </details>
                            )}
                            {sg.action === "conflict" && <p className="mt-1.5 text-[9px] text-warning">{t("smartTeamConflictHelp")}</p>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {error && <p role="alert" aria-live="assertive" className="text-xs text-danger">{error}</p>}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft px-5 py-3">
        <button onClick={onClose} className="text-xs text-faint hover:text-muted">
          {t("cancel")}
        </button>
        {hasAny && !loading && (
          <div className="flex flex-wrap justify-end gap-2">
            <button
              onClick={() => onCreate(false)}
              disabled={creating || selected.size === 0}
              className="text-xs px-3 py-1.5 border border-line text-muted rounded-lg hover:bg-fg/5 disabled:opacity-40 transition-colors"
            >
              {creating ? "..." : preview ? t("smartTeamApplySelected") : t("selectAndCreate")}
            </button>
            <button
              onClick={() => onCreate(true)}
              disabled={creating || (preview !== null && !hasRecommendedChanges)}
              className="text-xs px-4 py-1.5 bg-accent text-on-accent rounded-lg hover:bg-accent-hover disabled:opacity-50 transition-colors font-medium"
            >
              {creating ? "..." : preview ? t("smartTeamApplyRecommended") : t("createFullTeam")}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function TeamPresetsPanel({
  t, teamPresets, applyingPreset, onApply, onBack, onClose,
}: {
  t: any;
  teamPresets: TeamPreset[];
  applyingPreset: string | null;
  onApply: (presetId: string) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="px-5 py-4 border-b border-line-soft flex items-center gap-3">
        <button type="button" onClick={onBack} aria-label={t("back")} className="text-faint hover:text-muted">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div>
          <h3 id="add-agent-dialog-title" className="text-sm font-semibold text-fg">{t("teamPresets")}</h3>
          <p className="text-xs text-faint">{t("teamPresetsDesc")}</p>
        </div>
      </div>
      <div className="p-5 space-y-2">
        {teamPresets.length === 0 && (
          <p role="status" aria-live="polite" className="py-6 text-center text-xs text-faint">{t("loading")}</p>
        )}
        {teamPresets.map((tp) => (
          <button
            key={tp.id}
            onClick={() => onApply(tp.id)}
            disabled={applyingPreset !== null}
            className="w-full text-left px-4 py-3 rounded-lg border border-line hover:border-accent hover:bg-accent/10 transition-colors disabled:opacity-50"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-fg">{tp.name}</span>
              {applyingPreset === tp.id && (
                <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeOpacity="0.3" />
                  <path d="M21 12a9 9 0 00-9-9" />
                </svg>
              )}
            </div>
            <p className="text-xs text-faint mt-0.5">{tp.description}</p>
            {tp.agents && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {tp.agents.map((a) => (
                  <span key={a.role} className="text-[10px] px-1.5 py-0.5 bg-sunken text-muted rounded">
                    {a.name}
                  </span>
                ))}
              </div>
            )}
          </button>
        ))}
      </div>
      <div className="px-5 py-3 border-t border-line-soft flex justify-end">
        <button onClick={onClose} className="text-xs text-faint hover:text-muted">
          {t("cancel")}
        </button>
      </div>
    </>
  );
}

function IndividualSelectPanel({
  t, presets, customName, onCustomNameChange, onSelectPreset, onCustomNext, onBack, onClose,
}: {
  t: any;
  presets: Preset[];
  customName: string;
  onCustomNameChange: (v: string) => void;
  onSelectPreset: (p: Preset) => void;
  onCustomNext: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="px-5 py-4 border-b border-line-soft flex items-center gap-3">
        <button type="button" onClick={onBack} aria-label={t("back")} className="text-faint hover:text-muted">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div>
          <h3 id="add-agent-dialog-title" className="text-sm font-semibold text-fg">{t("addIndividual")}</h3>
          <p className="text-xs text-faint">{t("addAgentSubtitle")}</p>
        </div>
      </div>
      <div className="p-5 space-y-2">
        {presets.map((p) => (
          <button
            key={p.role}
            onClick={() => onSelectPreset(p)}
            className="w-full text-left px-4 py-3 rounded-lg border border-line hover:border-accent hover:bg-accent/10 transition-colors"
          >
            <div className="text-sm font-medium text-fg">
              {PRESET_I18N[p.role] ? t(PRESET_I18N[p.role].nameKey) : p.name}
            </div>
            <div className="text-xs text-faint mt-0.5">
              {PRESET_I18N[p.role] ? t(PRESET_I18N[p.role].descKey) : p.description}
            </div>
          </button>
        ))}

        <div className="pt-3 border-t border-line-soft space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={customName}
              onChange={(e) => onCustomNameChange(e.target.value)}
              placeholder={t("customAgentPlaceholder")}
              className="flex-1 px-3 py-2 text-sm border border-line rounded-lg bg-sunken text-fg focus:outline-none focus:border-accent"
              onKeyDown={(e) => e.key === "Enter" && onCustomNext()}
            />
            <button
              onClick={onCustomNext}
              disabled={!customName.trim()}
              className="px-4 py-2 text-sm bg-sunken text-muted rounded-lg hover:bg-fg/10 disabled:opacity-40"
            >
              {t("next")}
            </button>
          </div>
        </div>
      </div>
      <div className="px-5 py-3 border-t border-line-soft flex justify-end">
        <button onClick={onClose} className="text-xs text-faint hover:text-muted">
          {t("cancel")}
        </button>
      </div>
    </>
  );
}

function IndividualPreviewPanel({
  t, selectedName, selectedRole, editablePrompt, onPromptChange,
  existingAgents, selectedParentId, onParentChange,
  creating, error, onCreate, onBack, onClose,
}: {
  t: any;
  selectedName: string;
  selectedRole: string;
  editablePrompt: string;
  onPromptChange: (v: string) => void;
  existingAgents: Array<{ id: string; name: string; role: string }>;
  selectedParentId: string;
  onParentChange: (v: string) => void;
  creating: boolean;
  error: string | null;
  onCreate: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="px-5 py-4 border-b border-line-soft flex items-center gap-3">
        <button type="button" onClick={onBack} aria-label={t("back")} className="text-faint hover:text-muted">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div>
          <h3 id="add-agent-dialog-title" className="text-sm font-semibold text-fg">
            {selectedName} <span className="text-xs text-faint font-normal">({selectedRole})</span>
          </h3>
          <p className="text-xs text-faint">{t("previewPromptDesc")}</p>
        </div>
      </div>
      <div className="p-5">
        <label className="text-xs text-muted mb-1.5 block font-medium">
          {t("systemPrompt")}
        </label>
        <textarea
          value={editablePrompt}
          onChange={(e) => onPromptChange(e.target.value)}
          rows={8}
          className="w-full px-3 py-2 text-xs border border-line rounded-lg bg-sunken text-muted focus:outline-none focus:border-accent font-mono resize-y leading-relaxed"
        />
        <p className="text-[10px] text-faint mt-1.5 italic">{t("promptHint")}</p>
        {existingAgents.length > 0 && (
          <div className="mt-3">
            <label className="text-xs text-muted mb-1 block font-medium">
              {t("parentAgent")}
            </label>
            <select
              value={selectedParentId}
              onChange={(e) => onParentChange(e.target.value)}
              className="w-full text-xs text-muted bg-sunken border border-line rounded-lg px-3 py-1.5 focus:outline-none focus:border-accent"
            >
              <option value="">{t("noParent")}</option>
              {existingAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.role})</option>
              ))}
            </select>
          </div>
        )}
        {error && <p role="alert" aria-live="assertive" className="mt-2 text-xs text-danger">{error}</p>}
      </div>
      <div className="px-5 py-3 border-t border-line-soft flex justify-between">
        <button onClick={onClose} className="text-xs text-faint hover:text-muted">
          {t("cancel")}
        </button>
        <button
          onClick={onCreate}
          disabled={creating}
          className="text-xs px-4 py-1.5 bg-accent text-on-accent rounded hover:bg-accent-hover disabled:opacity-50"
        >
          {creating ? "..." : t("addAgentConfirm")}
        </button>
      </div>
    </>
  );
}

/* ─── Helpers ─── */

function inferRole(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("cto") || lower.includes("lead")) return "cto";
  if (lower.includes("backend") || lower.includes("server")) return "backend";
  if (lower.includes("frontend") || lower.includes("ui")) return "frontend";
  if (lower.includes("qa") || lower.includes("test")) return "qa";
  if (lower.includes("review")) return "reviewer";
  if (lower.includes("devops") || lower.includes("infra")) return "devops";
  if (lower.includes("design") || lower.includes("ux")) return "ux";
  if (lower.includes("market")) return "marketer";
  return "custom";
}
