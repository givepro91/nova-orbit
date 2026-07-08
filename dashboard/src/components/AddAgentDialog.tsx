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
}

interface AddAgentDialogProps {
  projectId: string;
  mission?: string;
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

  // Enter smart mode: scan + suggest
  const enterSmartMode = async () => {
    setMode("smart");
    setScanLoading(true);
    setScannedAgents([]);
    setSuggestedAgents([]);
    setSelectedSmartAgents(new Set());
    setTeamError(null);

    try {
      const [scanResult, suggestResult] = await Promise.allSettled([
        api.agents.scanProject(projectId),
        api.agents.suggest(mission ?? "", projectId, undefined, "ai"),
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
        ...suggested.map((a) => `suggested:${a.role}`),
      ]);
      setSelectedSmartAgents(allKeys);
    } finally {
      setScanLoading(false);
    }
  };

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
      const toCreate: Array<{ name: string; role: string; fromProject: boolean; systemPrompt?: string }> = [];

      for (const sa of scannedAgents) {
        const key = `scanned:${sa.file}`;
        if (all || selectedSmartAgents.has(key)) {
          toCreate.push({ name: sa.agentName, role: inferRole(sa.agentName), fromProject: true });
        }
      }
      for (const sg of suggestedAgents) {
        const key = `suggested:${sg.role}`;
        if (all || selectedSmartAgents.has(key)) {
          toCreate.push({ name: sg.name, role: sg.role, fromProject: false, systemPrompt: sg.systemPrompt });
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
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-[#25253d] rounded-xl shadow-lg w-[540px] max-w-[calc(100vw-2rem)] max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mode picker */}
        {mode === "pick" && <ModePicker t={t} onSelect={(m) => { if (m === "smart") enterSmartMode(); else setMode(m); }} onClose={onClose} />}

        {/* Smart team */}
        {mode === "smart" && (
          <SmartTeamPanel
            t={t}
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
      <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{t("addAgentTitle")}</h3>
      </div>
      <div className="p-5 space-y-3">
        {/* Smart */}
        <button
          onClick={() => onSelect("smart")}
          className="w-full text-left px-4 py-3.5 rounded-xl border-2 border-blue-200 dark:border-blue-700 bg-blue-50/40 dark:bg-blue-900/10 hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-50/70 dark:hover:bg-blue-900/20 transition-colors"
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold text-blue-700 dark:text-blue-300">{t("smartTeamSetup")}</span>
            <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 dark:bg-blue-800 text-blue-600 dark:text-blue-300 rounded font-medium">추천</span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("smartTeamDesc")}</p>
        </button>

        {/* Presets */}
        <button
          onClick={() => onSelect("presets")}
          className="w-full text-left px-4 py-3.5 rounded-xl border border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500 hover:bg-gray-50/50 dark:hover:bg-gray-800/30 transition-colors"
        >
          <p className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-0.5">{t("teamPresets")}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("teamPresetsDesc")}</p>
        </button>

        {/* Individual */}
        <button
          onClick={() => onSelect("individual")}
          className="w-full text-left px-4 py-3.5 rounded-xl border border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500 hover:bg-gray-50/50 dark:hover:bg-gray-800/30 transition-colors"
        >
          <p className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-0.5">{t("addIndividual")}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("addIndividualDesc")}</p>
        </button>
      </div>
      <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700 flex justify-end">
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          {t("cancel")}
        </button>
      </div>
    </>
  );
}

function SmartTeamPanel({
  t, loading, scannedAgents, suggestedAgents, selected, onToggle, onCreate, creating, error, onBack, onClose,
}: {
  t: any;
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

  return (
    <>
      <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center gap-3">
        <button onClick={onBack} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{t("smartTeamSetup")}</h3>
      </div>

      <div className="p-5">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500 py-8 justify-center">
            <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeOpacity="0.3" />
              <path d="M21 12a9 9 0 00-9-9" />
            </svg>
            {t("aiDesigningTeam")}
          </div>
        )}

        {!loading && !hasAny && (
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-6">
            분석 결과가 없습니다. 팀 프리셋을 사용해보세요.
          </p>
        )}

        {!loading && hasAny && (
          <div className="space-y-4">
            {/* Scanned agents */}
            {scannedAgents.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-500">
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                  </svg>
                  <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                    {t("projectAgentsFound")} ({scannedAgents.length})
                  </span>
                </div>
                <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-2">{t("projectAgentsFoundDesc")}</p>
                <div className="space-y-1.5">
                  {scannedAgents.map((sa) => {
                    const key = `scanned:${sa.file}`;
                    return (
                      <label key={key} className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/20 cursor-pointer hover:bg-gray-100/50 dark:hover:bg-gray-700/20 transition-colors">
                        <input
                          type="checkbox"
                          checked={selected.has(key)}
                          onChange={() => onToggle(key)}
                          className="accent-blue-500"
                        />
                        <div className="flex-1 min-w-0">
                          <span className="text-xs text-green-600 dark:text-green-400 font-mono">{sa.file}</span>
                          <span className="text-[10px] text-gray-400 ml-1.5">({sa.lines}줄)</span>
                          <span className="text-xs text-gray-400 dark:text-gray-500 mx-1.5">→</span>
                          <span className="text-xs text-gray-700 dark:text-gray-300 font-medium">{sa.agentName}</span>
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
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-purple-500">
                    <path d="M12 2a10 10 0 110 20A10 10 0 0112 2z" strokeOpacity="0.3" />
                    <path d="M12 6v6l4 2" />
                  </svg>
                  <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                    {t("missionBasedSuggest")}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {suggestedAgents.map((sg) => {
                    const key = `suggested:${sg.role}`;
                    return (
                      <label key={key} className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/20 cursor-pointer hover:bg-gray-100/50 dark:hover:bg-gray-700/20 transition-colors">
                        <input
                          type="checkbox"
                          checked={selected.has(key)}
                          onChange={() => onToggle(key)}
                          className="accent-purple-500"
                        />
                        <div className="flex-1 min-w-0">
                          <span className="text-xs text-gray-700 dark:text-gray-300 font-medium">{sg.name}</span>
                          {sg.source === "ai" && (
                            <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/15 text-purple-500 dark:text-purple-400 ml-1.5 font-medium align-middle">{t("aiDesignedBadge")}</span>
                          )}
                          {sg.reason && (
                            <span className="text-[10px] text-gray-400 dark:text-gray-500 ml-1.5 italic">{sg.reason}</span>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {error && <p className="text-xs text-red-500">{error}</p>}
          </div>
        )}
      </div>

      <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700 flex items-center justify-between">
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          {t("cancel")}
        </button>
        {hasAny && !loading && (
          <div className="flex gap-2">
            <button
              onClick={() => onCreate(false)}
              disabled={creating || selected.size === 0}
              className="text-xs px-3 py-1.5 border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 transition-colors"
            >
              {creating ? "..." : t("selectAndCreate")}
            </button>
            <button
              onClick={() => onCreate(true)}
              disabled={creating}
              className="text-xs px-4 py-1.5 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 transition-colors font-medium"
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
      <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center gap-3">
        <button onClick={onBack} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div>
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{t("teamPresets")}</h3>
          <p className="text-xs text-gray-400 dark:text-gray-500">{t("teamPresetsDesc")}</p>
        </div>
      </div>
      <div className="p-5 space-y-2">
        {teamPresets.length === 0 && (
          <p className="text-xs text-gray-400 text-center py-6">{t("loading")}</p>
        )}
        {teamPresets.map((tp) => (
          <button
            key={tp.id}
            onClick={() => onApply(tp.id)}
            disabled={applyingPreset !== null}
            className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-600 hover:border-blue-300 dark:hover:border-blue-500 hover:bg-blue-50/30 dark:hover:bg-blue-900/20 transition-colors disabled:opacity-50"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{tp.name}</span>
              {applyingPreset === tp.id && (
                <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeOpacity="0.3" />
                  <path d="M21 12a9 9 0 00-9-9" />
                </svg>
              )}
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{tp.description}</p>
            {tp.agents && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {tp.agents.map((a) => (
                  <span key={a.role} className="text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded">
                    {a.name}
                  </span>
                ))}
              </div>
            )}
          </button>
        ))}
      </div>
      <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700 flex justify-end">
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
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
      <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center gap-3">
        <button onClick={onBack} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div>
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{t("addIndividual")}</h3>
          <p className="text-xs text-gray-400 dark:text-gray-500">{t("addAgentSubtitle")}</p>
        </div>
      </div>
      <div className="p-5 space-y-2">
        {presets.map((p) => (
          <button
            key={p.role}
            onClick={() => onSelectPreset(p)}
            className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-600 hover:border-blue-300 dark:hover:border-blue-500 hover:bg-blue-50/30 dark:hover:bg-blue-900/20 transition-colors"
          >
            <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
              {PRESET_I18N[p.role] ? t(PRESET_I18N[p.role].nameKey) : p.name}
            </div>
            <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
              {PRESET_I18N[p.role] ? t(PRESET_I18N[p.role].descKey) : p.description}
            </div>
          </button>
        ))}

        <div className="pt-3 border-t border-gray-100 dark:border-gray-700 space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={customName}
              onChange={(e) => onCustomNameChange(e.target.value)}
              placeholder={t("customAgentPlaceholder")}
              className="flex-1 px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-[#1a1a2e] text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-400"
              onKeyDown={(e) => e.key === "Enter" && onCustomNext()}
            />
            <button
              onClick={onCustomNext}
              disabled={!customName.trim()}
              className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40"
            >
              {t("next")}
            </button>
          </div>
        </div>
      </div>
      <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700 flex justify-end">
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
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
      <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center gap-3">
        <button onClick={onBack} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div>
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {selectedName} <span className="text-xs text-gray-400 font-normal">({selectedRole})</span>
          </h3>
          <p className="text-xs text-gray-400 dark:text-gray-500">{t("previewPromptDesc")}</p>
        </div>
      </div>
      <div className="p-5">
        <label className="text-xs text-gray-500 dark:text-gray-400 mb-1.5 block font-medium">
          {t("systemPrompt")}
        </label>
        <textarea
          value={editablePrompt}
          onChange={(e) => onPromptChange(e.target.value)}
          rows={8}
          className="w-full px-3 py-2 text-xs border border-gray-200 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-[#1a1a2e] text-gray-700 dark:text-gray-300 focus:outline-none focus:border-blue-400 font-mono resize-y leading-relaxed"
        />
        <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1.5 italic">{t("promptHint")}</p>
        {existingAgents.length > 0 && (
          <div className="mt-3">
            <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block font-medium">
              {t("parentAgent")}
            </label>
            <select
              value={selectedParentId}
              onChange={(e) => onParentChange(e.target.value)}
              className="w-full text-xs text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-[#1a1a2e] border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400"
            >
              <option value="">{t("noParent")}</option>
              {existingAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.role})</option>
              ))}
            </select>
          </div>
        )}
        {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
      </div>
      <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700 flex justify-between">
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          {t("cancel")}
        </button>
        <button
          onClick={onCreate}
          disabled={creating}
          className="text-xs px-4 py-1.5 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
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
