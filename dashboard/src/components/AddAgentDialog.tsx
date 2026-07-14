import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";

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

interface SuggestedAgent {
  name: string;
  role: string;
  reason?: string;
  systemPrompt?: string;
  source?: string; // "ai" | "preset" | "tech-stack" | "project-agents"
  model?: string; // 설계자가 배정한 모델 (opus|sonnet|haiku) — 없으면 role 기본
}

interface AddAgentDialogProps {
  projectId: string;
  mission?: string;
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

type Mode = "pick" | "smart" | "presets" | "individual";
type IndividualStep = "select" | "preview";

export function AddAgentDialog({
  initialSmart,
  projectId,
  mission,
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

  // ESC to close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

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

    try {
      const [scanResult, suggestResult] = await Promise.allSettled([
        api.agents.scanProject(projectId),
        api.agents.suggest(mission ?? "", projectId, undefined, "ai", refresh),
      ]);

      const scanned: ScannedAgent[] =
        scanResult.status === "fulfilled" ? scanResult.value?.agents ?? [] : [];
      const suggested: SuggestedAgent[] =
        suggestResult.status === "fulfilled" ? (suggestResult.value as SuggestedAgent[]) : [];

      setScannedAgents(scanned);
      setSuggestedAgents(suggested);

      // Auto-select all by default
      const allKeys = new Set([
        ...scanned.map((a) => `scanned:${a.file}`),
        ...suggested.map((_, i) => `suggested:${i}`),
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

  // Create full team from smart selection
  const handleCreateSmartTeam = async (all: boolean) => {
    setCreatingTeam(true);
    setTeamError(null);

    try {
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
          toCreate.push({ name: sg.name, role: sg.role, fromProject: false, systemPrompt: sg.systemPrompt, model: sg.model });
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
      className="fixed inset-0 bg-black/20 dark:bg-black/50 flex items-center justify-center z-50"
      onClick={() => {
        // 설계 로딩 중 backdrop 오클릭으로 모달이 닫히는 사고 방지 — 명시적 취소/뒤로만 허용
        if (mode === "smart" && scanLoading) return;
        onClose();
      }}
    >
      <div
        className="bg-surface rounded-xl shadow-lg w-[540px] max-w-[calc(100vw-2rem)] max-h-[85vh] overflow-y-auto"
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
            onCreate={handleCreateSmartTeam}
            creating={creatingTeam}
            error={teamError}
            onBack={() => setMode("pick")}
            onClose={onClose}
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
        <h3 className="text-sm font-semibold text-fg">{t("addAgentTitle")}</h3>
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
  t, loading, scannedAgents, suggestedAgents, selected, onToggle, onCreate, creating, error, onBack, onClose, onRedesign,
}: {
  t: any;
  onRedesign: () => void;
  loading: boolean;
  scannedAgents: ScannedAgent[];
  suggestedAgents: SuggestedAgent[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  onCreate: (all: boolean) => void;
  creating: boolean;
  error: string | null;
  onBack: () => void;
  onClose: () => void;
}) {
  const hasAny = scannedAgents.length > 0 || suggestedAgents.length > 0;
  // AI 모드로 요청했지만 프로젝트 자체 역할 정의(.claude/agents/)가 있어 AI 설계가 생략된 경우 —
  // project-agents source가 곧 "AI 건너뜀" 신호다 (서버 agents.ts: hasProjectDefs 게이트)
  const aiSkipped = suggestedAgents.some((s) => s.source === "project-agents");

  return (
    <>
      <div className="px-5 py-4 border-b border-line-soft flex items-center gap-3">
        <button onClick={onBack} className="text-faint hover:text-muted">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <h3 className="text-sm font-semibold text-fg">{t("smartTeamSetup")}</h3>
      </div>

      <div className="p-5">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-faint py-8 justify-center">
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
                <div className="space-y-1.5">
                  {suggestedAgents.map((sg, i) => {
                    const key = `suggested:${i}`;
                    return (
                      <label key={key} className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-line-soft bg-sunken cursor-pointer hover:bg-fg/5 transition-colors">
                        <input
                          type="checkbox"
                          checked={selected.has(key)}
                          onChange={() => onToggle(key)}
                          className="accent-accent"
                        />
                        <div className="flex-1 min-w-0">
                          <span className="text-xs text-muted font-medium">{sg.name}</span>
                          {sg.source === "ai" && (
                            <span className="text-[9px] px-1 py-0.5 rounded bg-accent/20 text-accent ml-1.5 font-medium align-middle">{t("aiDesignedBadge")}</span>
                          )}
                          {sg.model && (
                            <span className="text-[9px] px-1 py-0.5 rounded bg-fg/10 text-muted ml-1 font-mono align-middle">{sg.model}</span>
                          )}
                          {sg.reason && (
                            <span className="text-[10px] text-faint ml-1.5 italic">{sg.reason}</span>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {error && <p className="text-xs text-danger">{error}</p>}
          </div>
        )}
      </div>

      <div className="px-5 py-3 border-t border-line-soft flex items-center justify-between">
        <button onClick={onClose} className="text-xs text-faint hover:text-muted">
          {t("cancel")}
        </button>
        {hasAny && !loading && (
          <div className="flex gap-2">
            <button
              onClick={() => onCreate(false)}
              disabled={creating || selected.size === 0}
              className="text-xs px-3 py-1.5 border border-line text-muted rounded-lg hover:bg-fg/5 disabled:opacity-40 transition-colors"
            >
              {creating ? "..." : t("selectAndCreate")}
            </button>
            <button
              onClick={() => onCreate(true)}
              disabled={creating}
              className="text-xs px-4 py-1.5 bg-accent text-on-accent rounded-lg hover:bg-accent-hover disabled:opacity-50 transition-colors font-medium"
            >
              {creating ? "..." : t("createFullTeam")}
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
        <button onClick={onBack} className="text-faint hover:text-muted">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div>
          <h3 className="text-sm font-semibold text-fg">{t("teamPresets")}</h3>
          <p className="text-xs text-faint">{t("teamPresetsDesc")}</p>
        </div>
      </div>
      <div className="p-5 space-y-2">
        {teamPresets.length === 0 && (
          <p className="text-xs text-faint text-center py-6">{t("loading")}</p>
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
        <button onClick={onBack} className="text-faint hover:text-muted">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div>
          <h3 className="text-sm font-semibold text-fg">{t("addIndividual")}</h3>
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
        <button onClick={onBack} className="text-faint hover:text-muted">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div>
          <h3 className="text-sm font-semibold text-fg">
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
        {error && <p className="text-xs text-danger mt-2">{error}</p>}
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
