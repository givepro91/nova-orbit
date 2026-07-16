import { Router } from "express";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AppContext } from "../../index.js";
import { getAgentPresets } from "../../core/agent/roles.js";
import { suggestAgentsFromMission, suggestFromProject, getTeamPresets } from "../../core/agent/suggest.js";
import { designTeamCached, getDesignStatus, markDesignConsumed } from "../../core/agent/team-designer.js";
import { buildSmartTeamPreview, normalizedAgentName } from "../../core/agent/smart-team.js";
import { resolvePrompt } from "../../core/agent/prompt-resolver.js";
import { agentActivityLog } from "../../core/agent/activity-log.js";
import { getPreset } from "../../core/agent/roles.js";
import { VALID_ROLES } from "../../utils/constants.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("agents-route");

const VALID_MODELS = ["opus", "sonnet", "haiku"] as const;
const VALID_PROVIDERS = ["claude", "codex"] as const;

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function createAgentRoutes(ctx: AppContext): Router {
  const router = Router();
  const { db, broadcast } = ctx;

  const loadGoalContext = (projectId: string, goalId: string) => {
    const goal = db.prepare(
      "SELECT id, project_id, title, description, execution_spec_version_id FROM goals WHERE id = ?",
    ).get(goalId) as any;
    if (!goal || goal.project_id !== projectId) return null;

    const spec = db.prepare(`
      SELECT scope, out_of_scope, acceptance_criteria, expected_tasks, verification_methods, status
      FROM goal_spec_versions
      WHERE id = COALESCE(?, (
        SELECT id FROM goal_spec_versions WHERE goal_id = ? ORDER BY version DESC LIMIT 1
      ))
    `).get(goal.execution_spec_version_id ?? null, goalId) as any;
    const legacy = spec ? null : db.prepare(
      "SELECT prd_summary, feature_specs, acceptance_criteria, tech_considerations FROM goal_specs WHERE goal_id = ?",
    ).get(goalId) as any;
    const tasks = db.prepare(`
      SELECT title, description, status
      FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL
      ORDER BY sort_order, created_at LIMIT 30
    `).all(goalId) as Array<{ title: string; description: string; status: string }>;

    let plan: string | null = null;
    if (spec) {
      const parts = [
        spec.scope ? `Scope: ${String(spec.scope).slice(0, 1600)}` : "",
        spec.out_of_scope ? `Out of scope: ${String(spec.out_of_scope).slice(0, 800)}` : "",
        ...parseJsonArray(spec.acceptance_criteria).slice(0, 8).map((item) => `Acceptance: ${item.slice(0, 300)}`),
        ...parseJsonArray(spec.expected_tasks).slice(0, 8).map((item) => `Expected task: ${item.slice(0, 300)}`),
      ].filter(Boolean);
      plan = parts.join("\n").slice(0, 5000) || null;
    } else if (legacy) {
      plan = [legacy.prd_summary, legacy.feature_specs, legacy.acceptance_criteria, legacy.tech_considerations]
        .filter((value) => typeof value === "string" && value.trim())
        .join("\n")
        .slice(0, 5000) || null;
    }

    return {
      id: goal.id as string,
      title: String(goal.title || goal.description || "").slice(0, 300),
      description: String(goal.description || "").slice(0, 3000),
      plan,
      tasks: tasks.map((task) => ({
        title: String(task.title).slice(0, 300),
        description: String(task.description || "").slice(0, 800),
        status: task.status,
      })),
    };
  };

  // List agents (optionally filter by project)
  router.get("/", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const agents = projectId
      ? db.prepare("SELECT * FROM agents WHERE project_id = ? ORDER BY created_at").all(projectId)
      : db.prepare("SELECT * FROM agents ORDER BY created_at").all();
    res.json(agents);
  });

  // List available agent role presets loaded from templates/agents/*.yaml
  router.get("/presets", (_req, res) => {
    res.json(getAgentPresets());
  });

  // List team presets (org structures)
  router.get("/team-presets", (_req, res) => {
    res.json(getTeamPresets());
  });

  // Create a team from a preset
  router.post("/create-team", (req, res) => {
    const { project_id, preset_id } = req.body;
    if (!project_id || !preset_id) {
      return res.status(400).json({ error: "project_id and preset_id are required" });
    }

    const presets = getTeamPresets();
    const preset = presets.find((p) => p.id === preset_id);
    if (!preset) return res.status(400).json({ error: `Unknown preset: ${preset_id}` });

    try {
      const created: any[] = [];
      const idMap = new Map<string, string>(); // role → agent id

      // First pass: create all agents with preset systemPrompt
      for (const a of preset.agents) {
        const rolePreset = getPreset(a.role);
        const systemPrompt = rolePreset?.systemPrompt ?? "";
        const promptSource = systemPrompt ? "preset" : "auto";
        const result = db.prepare(
          "INSERT INTO agents (project_id, name, role, system_prompt, prompt_source) VALUES (?, ?, ?, ?, ?)",
        ).run(project_id, a.name, a.role, systemPrompt, promptSource);
        const row = db.prepare("SELECT * FROM agents WHERE rowid = ?").get(result.lastInsertRowid) as any;
        created.push(row);
        idMap.set(a.role, row.id);
      }

      // Second pass: set parent_id for hierarchy
      for (const a of preset.agents) {
        if (a.parentRole) {
          const parentId = idMap.get(a.parentRole);
          const childId = idMap.get(a.role);
          if (parentId && childId) {
            db.prepare("UPDATE agents SET parent_id = ? WHERE id = ?").run(parentId, childId);
          }
        }
      }

      broadcast("project:updated", { projectId: project_id });
      res.status(201).json({ preset: preset.name, created, count: created.length });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Suggest domain-specialized agents based on project analysis + mission
  router.post("/suggest", async (req, res) => {
    // AI 설계 경로(mode:"ai")는 Claude 세션 1개가 돌아 수 분 걸릴 수 있다
    req.setTimeout(300000);
    res.setTimeout(300000);
    const { mission, techStack, project_id, mode, refresh, language } = req.body;
    if (!mission && !project_id) return res.status(400).json({ error: "mission or project_id is required" });

    // If project_id provided, use smart analysis (reads actual project files)
    if (project_id) {
      const project = db.prepare(
        "SELECT name, workdir, mission, tech_stack FROM projects WHERE id = ?",
      ).get(project_id) as any;
      if (project?.workdir) {
        const suggestions = suggestFromProject(project.workdir, mission ?? undefined);
        const hasProjectDefs = suggestions.some((s) => s.source === "project-agents");

        // AI 팀 설계 (opt-in) — .claude/agents/ 사용자 정의가 있으면 그쪽이 우선
        if (mode === "ai" && !hasProjectDefs) {
          // 클라이언트 이탈 감지 — 전송 전에 연결이 닫히면(새로고침·모달 이탈) 미소비로 남긴다.
          // 주의: req.destroyed는 Node가 body를 다 읽은 정상 요청에서도 true라 판정에 못 쓴다.
          let clientAborted = false;
          res.once("close", () => { if (!res.writableEnded) clientAborted = true; });
          try {
            // 진행 상태 broadcast — 새로고침/모달 이탈 후에도 UI가 진행 중임을 표시할 수 있게
            broadcast("team_design:status", { projectId: project_id, state: "running" });
            const designed = await designTeamCached(project_id, {
              projectName: project.name ?? project_id,
              mission: mission ?? project.mission,
              workdir: project.workdir,
              techStack: project.tech_stack ? JSON.parse(project.tech_stack) : techStack ?? null,
              language,
            }, { refresh: refresh === true });
            broadcast("team_design:status", { projectId: project_id, state: "ready" });
            // 이 응답이 실제로 클라이언트에 도달하는 경우에만 소비 처리 —
            // 이탈한 요청은 미소비로 남아 "결과 보기" 칩의 근거가 된다
            if (!clientAborted) markDesignConsumed(project_id);
            return res.json(designed);
          } catch (err: any) {
            broadcast("team_design:status", { projectId: project_id, state: "failed" });
            log.warn(`AI team design failed — falling back to rule-based: ${err?.message ?? err}`);
          }
        }
        return res.json(suggestions);
      }
    }

    // Fallback: keyword-only suggestion
    const suggestions = suggestAgentsFromMission(mission ?? "", techStack);
    res.json(suggestions);
  });

  // AI 팀 설계 진행 상태 — 새로고침 후 UI 복원용 (running: 설계 중, ready: 미확인 결과 있음)
  router.get("/design-status", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
    if (!projectId) return res.status(400).json({ error: "projectId query param required" });
    res.json(getDesignStatus(projectId));
  });

  // Goal-aware team preview. This endpoint is read-only: applying changes is an
  // explicit second request so opening the dialog can never mutate the team.
  router.post("/team-preview", async (req, res) => {
    req.setTimeout(300000);
    res.setTimeout(300000);
    const { project_id, goal_id, mode = "ai", refresh, language } = req.body ?? {};
    if (typeof project_id !== "string" || typeof goal_id !== "string") {
      return res.status(400).json({ error: "project_id and goal_id are required" });
    }
    if (!["ai", "quick"].includes(mode)) {
      return res.status(400).json({ error: "mode must be ai or quick" });
    }

    const project = db.prepare(
      "SELECT id, name, workdir, mission, tech_stack FROM projects WHERE id = ?",
    ).get(project_id) as any;
    if (!project) return res.status(404).json({ error: "Project not found" });
    const goal = loadGoalContext(project_id, goal_id);
    if (!goal) return res.status(404).json({ error: "Goal not found in project" });
    if (!project.workdir) return res.status(400).json({ error: "Project folder is required for team design" });

    let techStack: any = null;
    try {
      techStack = project.tech_stack ? JSON.parse(project.tech_stack) : null;
    } catch {
      techStack = null;
    }

    let suggestions = suggestFromProject(project.workdir, project.mission ?? undefined);
    const hasProjectDefs = suggestions.some((suggestion) => suggestion.source === "project-agents");
    const contextFingerprint = createHash("sha256").update(JSON.stringify(goal)).digest("hex").slice(0, 16);
    const designKey = `${project_id}:goal:${goal_id}:${contextFingerprint}`;
    if (mode === "ai" && !hasProjectDefs) {
      try {
        broadcast("team_design:status", { projectId: project_id, goalId: goal_id, state: "running" });
        suggestions = await designTeamCached(designKey, {
          projectName: project.name ?? project_id,
          mission: project.mission,
          workdir: project.workdir,
          techStack,
          focusGoal: goal,
          language,
        }, { refresh: refresh === true });
        markDesignConsumed(designKey);
        broadcast("team_design:status", { projectId: project_id, goalId: goal_id, state: "ready" });
      } catch (err: any) {
        broadcast("team_design:status", { projectId: project_id, goalId: goal_id, state: "failed" });
        log.warn(`Goal-aware team design failed — falling back to rule-based: ${err?.message ?? err}`);
      }
    }

    const existingAgents = db.prepare(`
      SELECT id, name, role, status, current_task_id, system_prompt, model, provider
      FROM agents WHERE project_id = ? ORDER BY created_at
    `).all(project_id) as any[];
    const preview = buildSmartTeamPreview(suggestions, existingAgents);
    res.json({
      projectId: project_id,
      goal: {
        id: goal.id,
        title: goal.title,
        description: goal.description,
        hasPlan: Boolean(goal.plan),
        taskCount: goal.tasks.length,
      },
      existingAgents,
      ...preview,
    });
  });

  // Explicitly apply selected preview candidates. Existing rows are never
  // deleted; an existing agent is updated only when its id is sent back by the
  // preview and it is not currently working.
  router.post("/team-apply", (req, res) => {
    const { project_id, goal_id, candidates } = req.body ?? {};
    if (typeof project_id !== "string" || typeof goal_id !== "string") {
      return res.status(400).json({ error: "project_id and goal_id are required" });
    }
    if (!loadGoalContext(project_id, goal_id)) {
      return res.status(404).json({ error: "Goal not found in project" });
    }
    if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 12) {
      return res.status(400).json({ error: "candidates must contain between 1 and 12 agents" });
    }

    const parsed: Array<{
      matchedAgentId: string | null;
      name: string;
      role: string;
      systemPrompt: string;
      source: string;
      model: string | null;
      provider: "claude" | "codex" | null;
    }> = [];
    const requestNames = new Set<string>();
    for (const item of candidates) {
      const name = typeof item?.name === "string" ? item.name.trim().slice(0, 100) : "";
      const role = typeof item?.role === "string" ? item.role : "";
      const systemPrompt = typeof item?.systemPrompt === "string" ? item.systemPrompt.trim().slice(0, 50_000) : "";
      const model = item?.model == null || item.model === "" ? null : String(item.model);
      const provider = item?.provider == null || item.provider === "" ? null : String(item.provider);
      const matchedAgentId = typeof item?.matchedAgentId === "string" ? item.matchedAgentId : null;
      if (!name || !(VALID_ROLES as readonly string[]).includes(role)) {
        return res.status(400).json({ error: "Each candidate needs a name and valid role" });
      }
      if (model !== null && !(VALID_MODELS as readonly string[]).includes(model)) {
        return res.status(400).json({ error: "Invalid model. Must be one of: opus, sonnet, haiku (or null)" });
      }
      if (provider !== null && !(VALID_PROVIDERS as readonly string[]).includes(provider)) {
        return res.status(400).json({ error: "Invalid provider. Must be one of: claude, codex (or null)" });
      }
      const normalizedName = normalizedAgentName(name);
      if (requestNames.has(normalizedName)) {
        return res.status(409).json({ error: `Duplicate candidate name: ${name}` });
      }
      requestNames.add(normalizedName);
      parsed.push({
        matchedAgentId,
        name,
        role,
        systemPrompt,
        source: typeof item?.source === "string" ? item.source : "preset",
        model,
        provider: provider as "claude" | "codex" | null,
      });
    }

    const existingAgents = db.prepare("SELECT * FROM agents WHERE project_id = ? ORDER BY created_at")
      .all(project_id) as any[];
    for (const candidate of parsed) {
      const matched = candidate.matchedAgentId
        ? existingAgents.find((agent) => agent.id === candidate.matchedAgentId)
        : null;
      if (candidate.matchedAgentId && !matched) {
        return res.status(409).json({ error: `Preview agent no longer exists: ${candidate.name}` });
      }
      if (matched && (matched.status === "working" || matched.current_task_id)) {
        return res.status(409).json({ error: `Active agent cannot be changed: ${matched.name}` });
      }
      const nameConflict = existingAgents.find((agent) =>
        agent.id !== matched?.id && normalizedAgentName(agent.name) === normalizedAgentName(candidate.name));
      const isExactReplay = nameConflict
        && nameConflict.role === candidate.role
        && (nameConflict.provider ?? null) === candidate.provider;
      if (nameConflict && !isExactReplay) {
        return res.status(409).json({ error: `Agent name already exists with another configuration: ${candidate.name}` });
      }
    }

    const created: any[] = [];
    const updated: any[] = [];
    const skipped: any[] = [];
    try {
      const tx = db.transaction(() => {
        let rootId = existingAgents.find((agent) => agent.role === "cto" || agent.role === "pm")?.id ?? null;
        const ordered = [...parsed].sort((a, b) => {
          const aRoot = a.role === "cto" || a.role === "pm" ? 0 : 1;
          const bRoot = b.role === "cto" || b.role === "pm" ? 0 : 1;
          return aRoot - bRoot;
        });

        for (const candidate of ordered) {
          const promptSource = candidate.source === "project-agents"
            ? "project"
            : candidate.systemPrompt ? (candidate.source === "ai" ? "custom" : "preset") : "auto";
          if (candidate.matchedAgentId) {
            db.prepare(`
              UPDATE agents SET name = ?, role = ?, system_prompt = ?, prompt_source = ?, model = ?, provider = ?
              WHERE id = ? AND project_id = ?
            `).run(
              candidate.name, candidate.role, candidate.systemPrompt, promptSource,
              candidate.model, candidate.provider, candidate.matchedAgentId, project_id,
            );
            const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(candidate.matchedAgentId);
            updated.push(row);
            if (!rootId && (candidate.role === "cto" || candidate.role === "pm")) rootId = candidate.matchedAgentId;
            continue;
          }

          const exact = existingAgents.find((agent) =>
            normalizedAgentName(agent.name) === normalizedAgentName(candidate.name)
            && agent.role === candidate.role
            && (agent.provider ?? null) === candidate.provider);
          if (exact) {
            skipped.push(exact);
            continue;
          }
          const parentId = rootId && candidate.role !== "cto" && candidate.role !== "pm" ? rootId : null;
          const result = db.prepare(`
            INSERT INTO agents (project_id, name, role, system_prompt, prompt_source, parent_id, model, provider)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            project_id, candidate.name, candidate.role, candidate.systemPrompt,
            promptSource, parentId, candidate.model, candidate.provider,
          );
          const row = db.prepare("SELECT * FROM agents WHERE rowid = ?").get(result.lastInsertRowid) as any;
          created.push(row);
          existingAgents.push(row);
          if (!rootId && (candidate.role === "cto" || candidate.role === "pm")) rootId = row.id;
        }
      });
      tx();
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }

    for (const agent of [...created, ...updated]) broadcast("agent:status", agent);
    broadcast("project:updated", { projectId: project_id });
    res.status(201).json({
      goalId: goal_id,
      preserved: existingAgents.length - created.length,
      created,
      updated,
      skipped,
    });
  });

  // Auto-create suggested agents for a project (with project analysis)
  router.post("/suggest-and-create", async (req, res) => {
    req.setTimeout(300000);
    res.setTimeout(300000);
    const { project_id, mission, techStack, mode } = req.body;
    if (!project_id) {
      return res.status(400).json({ error: "project_id is required" });
    }

    // Try smart analysis first, fallback to keyword-only
    let suggestions: ReturnType<typeof suggestFromProject>;
    const project = db.prepare(
      "SELECT name, workdir, mission, tech_stack FROM projects WHERE id = ?",
    ).get(project_id) as any;
    if (project?.workdir) {
      suggestions = suggestFromProject(project.workdir, mission ?? undefined);
      const hasProjectDefs = suggestions.some((s) => s.source === "project-agents");
      if (mode === "ai" && !hasProjectDefs) {
        try {
          suggestions = await designTeamCached(project_id, {
            projectName: project.name ?? project_id,
            mission: mission ?? project.mission,
            workdir: project.workdir,
            techStack: project.tech_stack ? JSON.parse(project.tech_stack) : techStack ?? null,
          });
        } catch (err: any) {
          log.warn(`AI team design failed — falling back to rule-based: ${err?.message ?? err}`);
        }
      }
    } else {
      suggestions = suggestAgentsFromMission(mission ?? "", techStack);
    }

    // 조정자(cto/pm)를 루트로 조직 트리 자동 구성 — 사용자가 수동 배치하지 않게
    const rootIdx = suggestions.findIndex((a) => a.role === "cto" || a.role === "pm");
    const ordered = rootIdx === -1
      ? suggestions
      : [suggestions[rootIdx], ...suggestions.filter((_, i) => i !== rootIdx)];

    const created: any[] = [];
    let rootId: string | null = null;
    for (const [i, agent] of ordered.entries()) {
      // AI 설계 프롬프트는 'custom'으로 저장해야 resolvePrompt 1순위로 주입된다
      const promptSource = agent.source === "ai" && agent.systemPrompt.trim()
        ? "custom"
        : agent.systemPrompt.trim() ? "preset" : "auto";
      const parentId = rootIdx !== -1 && i > 0 ? rootId : null;
      const result = db.prepare(`
        INSERT INTO agents (project_id, name, role, system_prompt, prompt_source, parent_id, model)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(project_id, agent.name, agent.role, agent.systemPrompt, promptSource, parentId, agent.model ?? null);

      const row = db.prepare("SELECT * FROM agents WHERE rowid = ?").get(result.lastInsertRowid) as any;
      if (i === 0 && rootIdx !== -1) rootId = row.id;
      created.push(row);
    }

    broadcast("project:updated", { projectId: project_id });
    res.status(201).json({ suggestions, created, count: created.length });
  });

  // Scan project .claude/agents/ directory for agent definition files
  router.post("/scan-project", (req, res) => {
    const { project_id } = req.body;
    if (!project_id) return res.status(400).json({ error: "project_id is required" });

    const project = db.prepare("SELECT workdir FROM projects WHERE id = ?").get(project_id) as any;
    if (!project) return res.status(404).json({ error: "Project not found" });

    const agentsDir = join(project.workdir, ".claude", "agents");

    if (!existsSync(agentsDir)) {
      return res.json({ found: [], matched: [], unmatched: [] });
    }

    // role → 후보 파일명 역방향 매핑 (파일명 → role)
    const FILE_TO_ROLE: Record<string, string> = {
      "backend.md": "backend", "server.md": "backend",
      "frontend.md": "frontend", "client.md": "frontend",
      "ux.md": "ux", "designer.md": "ux", "design.md": "ux",
      "qa.md": "qa", "tester.md": "qa",
      "reviewer.md": "reviewer", "review.md": "reviewer",
      "cto.md": "cto", "lead.md": "cto", "architect.md": "cto",
      "devops.md": "devops", "infra.md": "devops", "ops.md": "devops",
      "marketer.md": "marketer", "marketing.md": "marketer",
    };

    let files: string[];
    try {
      files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
    } catch {
      return res.json({ found: [], matched: [], unmatched: [] });
    }

    // 프로젝트의 기존 에이전트 목록
    const existingAgents = db.prepare(
      "SELECT id, role, name, prompt_source FROM agents WHERE project_id = ?",
    ).all(project_id) as { id: string; role: string; name: string; prompt_source: string }[];

    const found: any[] = [];
    const matched: any[] = [];
    const matchedAgentIds = new Set<string>();
    const unmatched: any[] = [];

    for (const filename of files) {
      const filePath = join(agentsDir, filename);
      let content = "";
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      if (content.trim().length === 0) continue;

      const lines = content.split("\n").length;
      const preview = content.slice(0, 200).replace(/\n/g, " ").trim();
      const role = FILE_TO_ROLE[filename] ?? "custom";

      found.push({ role, file: filename, lines, preview });

      // 이미 매칭된 에이전트 확인 (중복 방지)
      const matchedAgent = existingAgents.find((a) => a.role === role);
      if (matchedAgent && !matchedAgentIds.has(matchedAgent.id)) {
        matchedAgentIds.add(matchedAgent.id);
        matched.push({
          agentId: matchedAgent.id,
          role,
          currentSource: matchedAgent.prompt_source,
          projectFile: filename,
        });
      } else if (!matchedAgent) {
        unmatched.push({ file: filename, suggestedRole: role });
      }
    }

    res.json({ found, matched, unmatched });
  });

  // Get agent stats: taskCount, totalTokens, totalCostUsd
  router.get("/:id/stats", (req, res) => {
    const agent = db.prepare("SELECT id FROM agents WHERE id = ?").get(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const taskRow = db
      .prepare("SELECT COUNT(*) as taskCount FROM tasks WHERE assignee_id = ? AND status = 'done'")
      .get(req.params.id) as { taskCount: number };

    const sessionRow = db
      .prepare(
        "SELECT COALESCE(SUM(token_usage), 0) as totalTokens, COALESCE(SUM(cost_usd), 0) as totalCostUsd FROM sessions WHERE agent_id = ?",
      )
      .get(req.params.id) as { totalTokens: number; totalCostUsd: number };

    res.json({
      taskCount: taskRow.taskCount,
      totalTokens: sessionRow.totalTokens,
      totalCostUsd: sessionRow.totalCostUsd,
    });
  });

  // Get agent live activity log (in-memory ring buffer — recent 50 events)
  router.get("/:id/activity-log", (req, res) => {
    const agent = db.prepare("SELECT id FROM agents WHERE id = ?").get(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.json(agentActivityLog.snapshot(req.params.id));
  });

  // Get single agent — resolved_prompt_source 포함
  router.get("/:id", (req, res) => {
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.id) as any;
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    // 프로젝트 workdir 조회 후 resolvePrompt 실행
    const project = db.prepare("SELECT workdir FROM projects WHERE id = ?").get(agent.project_id) as any;
    const workdir = project?.workdir ?? "";
    const resolution = resolvePrompt(agent, workdir);

    res.json({
      ...agent,
      resolved_prompt_source: resolution.source,
      resolved_prompt_file: resolution.filePath ?? null,
    });
  });

  // Create agent
  router.post("/", (req, res) => {
    const { project_id, name, role, system_prompt = "", session_behavior = "resume-or-new", parent_id, model, provider } = req.body;

    if (!project_id || !name || !role) {
      return res.status(400).json({ error: "project_id, name, and role are required" });
    }

    if (!(VALID_ROLES as readonly string[]).includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` });
    }

    if (model != null && !["opus", "sonnet", "haiku"].includes(model)) {
      return res.status(400).json({ error: "Invalid model. Must be one of: opus, sonnet, haiku" });
    }

    if (provider != null && !["claude", "codex"].includes(provider)) {
      return res.status(400).json({ error: "Invalid provider. Must be one of: claude, codex (or null to inherit)" });
    }

    try {
      const effectivePromptSource = system_prompt.trim() ? "custom" : "auto";
      const result = db.prepare(`
        INSERT INTO agents (project_id, name, role, system_prompt, session_behavior, parent_id, prompt_source, model, provider)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(project_id, name, role, system_prompt, session_behavior, parent_id ?? null, effectivePromptSource, model ?? null, provider ?? null);

      const agent = db.prepare("SELECT * FROM agents WHERE rowid = ?").get(result.lastInsertRowid);
      broadcast("agent:status", agent);
      res.status(201).json(agent);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 팀 복제 — 현재 조직도의 동일 포지션 에이전트를 통째로 한 벌 더 만든다 (병렬 확장용).
  // role별 agent가 늘면 decompose의 least-loaded 할당이 자동으로 goal을 더 병렬로
  // 흘려보낸다(단, 실효 병렬은 CREWDECK_MAX_CONCURRENCY + provider quota가 상한).
  // 팀 라벨은 name suffix("· N팀")로만 표기 — 스키마 변경 없음. cto(조정자)는 단일
  // 유지가 안전해 기본 제외한다. clone은 source의 parent_id(=cto)를 그대로 물려받아
  // cto 조직 안으로 들어간다 — 이게 없으면 (a) 조직도에서 cto 밖 root로 뜨고
  // (b) decompose 후보(ctoChildren)에서 빠져 클론이 영영 할당을 못 받는다.
  router.post("/duplicate-team", (req, res) => {
    const { project_id, source_agent_ids, label } = req.body;
    if (!project_id) return res.status(400).json({ error: "project_id required" });

    // 소스 = 명시 선택 > "활동 로스터"(태스크가 배정된 non-cto) > non-cto 전체.
    // 유휴 중복 잔재를 피하려고 로스터를 기본으로 한다.
    let sources: any[];
    if (Array.isArray(source_agent_ids) && source_agent_ids.length > 0) {
      const ph = source_agent_ids.map(() => "?").join(",");
      sources = db.prepare(`SELECT * FROM agents WHERE project_id = ? AND id IN (${ph})`).all(project_id, ...source_agent_ids) as any[];
    } else {
      sources = db.prepare(
        "SELECT a.* FROM agents a WHERE a.project_id = ? AND a.role != 'cto' AND EXISTS (SELECT 1 FROM tasks t WHERE t.assignee_id = a.id)",
      ).all(project_id) as any[];
      if (sources.length === 0) {
        sources = db.prepare("SELECT * FROM agents WHERE project_id = ? AND role != 'cto'").all(project_id) as any[];
      }
    }
    if (sources.length === 0) return res.status(400).json({ error: "복제할 에이전트가 없습니다" });

    // 다음 팀 번호 = 기존 이름의 "· N팀" 최대치 + 1 (기본 팀=1, 첫 복제=2팀)
    const names = (db.prepare("SELECT name FROM agents WHERE project_id = ?").all(project_id) as { name: string }[]).map((r) => r.name);
    let maxTeam = 1;
    for (const n of names) {
      const m = /· (\d+)팀$/.exec(n);
      if (m) maxTeam = Math.max(maxTeam, parseInt(m[1], 10));
    }
    const teamLabel = typeof label === "string" && label.trim() ? label.trim() : `${maxTeam + 1}팀`;

    const insert = db.prepare(`
      INSERT INTO agents (project_id, name, role, system_prompt, session_behavior, parent_id, prompt_source, model, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const created: any[] = [];
    try {
      const tx = db.transaction(() => {
        for (const s of sources) {
          const baseName = String(s.name ?? "agent").replace(/ · [^·]+팀$/, ""); // 중첩 라벨 방지
          const newName = `${baseName} · ${teamLabel}`.slice(0, 100);
          const r = insert.run(
            project_id, newName, s.role, s.system_prompt ?? "",
            s.session_behavior ?? "resume-or-new", s.parent_id ?? null, s.prompt_source ?? "custom",
            s.model ?? null, s.provider ?? null,
          );
          created.push(db.prepare("SELECT * FROM agents WHERE rowid = ?").get(r.lastInsertRowid));
        }
      });
      tx();
      for (const a of created) broadcast("agent:status", a);
      broadcast("project:updated", { projectId: project_id });
      res.status(201).json({ team: teamLabel, count: created.length, agents: created });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Update agent
  router.patch("/:id", (req, res) => {
    const { status, current_task_id, system_prompt, name, role, parent_id, prompt_source, needs_worktree, model, provider } = req.body;
    const existing = db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: "Agent not found" });

    // Circular reference guard: reject if new parent_id is self or a descendant
    if (parent_id !== undefined && parent_id !== null) {
      if (parent_id === req.params.id) {
        return res.status(400).json({ error: "Circular reference detected: agent cannot be its own parent" });
      }
      let current: string | null = parent_id;
      while (current) {
        if (current === req.params.id) {
          return res.status(400).json({ error: "Circular reference detected: target is a descendant of this agent" });
        }
        const row = db.prepare("SELECT parent_id FROM agents WHERE id = ?").get(current) as any;
        current = row?.parent_id ?? null;
      }
    }

    if (role) {
      if (!(VALID_ROLES as readonly string[]).includes(role)) {
        return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` });
      }
    }

    if (prompt_source != null) {
      const VALID_SOURCES = ["auto", "custom", "project", "preset"];
      if (!VALID_SOURCES.includes(prompt_source)) {
        return res.status(400).json({ error: `Invalid prompt_source. Must be one of: ${VALID_SOURCES.join(", ")}` });
      }
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (status != null) { updates.push("status = ?"); params.push(status); }
    if (current_task_id !== undefined) { updates.push("current_task_id = ?"); params.push(current_task_id); }
    if (system_prompt != null) {
      updates.push("system_prompt = ?");
      params.push(system_prompt);
      // prompt_source 자동 전환 (명시적 prompt_source 지정이 없을 때만)
      if (prompt_source == null) {
        updates.push("prompt_source = ?");
        params.push(system_prompt.trim() !== "" ? "custom" : "auto");
      }
    }
    if (name != null) { updates.push("name = ?"); params.push(name); }
    if (role != null) { updates.push("role = ?"); params.push(role); }
    if (parent_id !== undefined) { updates.push("parent_id = ?"); params.push(parent_id); }
    if (needs_worktree != null) { updates.push("needs_worktree = ?"); params.push(needs_worktree ? 1 : 0); }
    if (model !== undefined) {
      if (model !== null && !["opus", "sonnet", "haiku"].includes(model)) {
        return res.status(400).json({ error: "Invalid model. Must be one of: opus, sonnet, haiku (or null for role default)" });
      }
      updates.push("model = ?"); params.push(model);
    }
    if (provider !== undefined) {
      if (provider !== null && !["claude", "codex"].includes(provider)) {
        return res.status(400).json({ error: "Invalid provider. Must be one of: claude, codex (or null to inherit)" });
      }
      updates.push("provider = ?"); params.push(provider);
    }
    // 명시적 prompt_source 변경 (동기화 복원: 'auto'로 전환 등)
    if (prompt_source != null) { updates.push("prompt_source = ?"); params.push(prompt_source); }

    if (updates.length > 0) {
      params.push(req.params.id);
      db.prepare(`UPDATE agents SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    }

    const updated = db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.id);
    broadcast("agent:status", updated);
    res.json(updated);
  });

  // Clone agent — duplicate with a new name
  router.post("/:id/clone", (req, res) => {
    const source = db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.id) as any;
    if (!source) return res.status(404).json({ error: "Agent not found" });

    // Generate unique name: append (2), (3), etc.
    const baseName = req.body.name?.trim() || source.name;
    let cloneName = baseName;
    const existing = db.prepare(
      "SELECT name FROM agents WHERE project_id = ?",
    ).all(source.project_id) as { name: string }[];
    const names = new Set(existing.map((a) => a.name));
    if (names.has(cloneName)) {
      for (let i = 2; i <= 99; i++) {
        cloneName = `${baseName} (${i})`;
        if (!names.has(cloneName)) break;
      }
    }

    try {
      const result = db.prepare(`
        INSERT INTO agents (project_id, name, role, system_prompt, prompt_source, session_behavior, parent_id, needs_worktree, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        source.project_id, cloneName, source.role,
        source.system_prompt ?? "", source.prompt_source ?? "auto",
        source.session_behavior ?? "resume-or-new",
        source.parent_id ?? null,
        source.needs_worktree ?? 1,
        source.model ?? null,
      );
      const cloned = db.prepare("SELECT * FROM agents WHERE rowid = ?").get(result.lastInsertRowid);
      broadcast("project:updated", { projectId: source.project_id });
      res.status(201).json(cloned);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Bulk delete all agents in a project (MUST be before /:id to avoid route conflict)
  router.delete("/bulk/:projectId", (req, res) => {
    const { projectId } = req.params;
    const agents = db.prepare("SELECT id FROM agents WHERE project_id = ?").all(projectId) as { id: string }[];
    for (const a of agents) {
      ctx.sessionManager?.killSession?.(a.id);
    }
    // Clear assignee for all non-done tasks (not just in_progress)
    const agentIds = agents.map(a => a.id);
    if (agentIds.length > 0) {
      const placeholders = agentIds.map(() => "?").join(",");
      db.prepare(`
        UPDATE tasks SET assignee_id = NULL,
          status = CASE WHEN status = 'in_progress' THEN 'todo' ELSE status END
        WHERE assignee_id IN (${placeholders}) AND status != 'done'
      `).run(...agentIds);
    }
    const result = db.prepare("DELETE FROM agents WHERE project_id = ?").run(projectId);
    broadcast("project:updated", { projectId });
    res.json({ success: true, deleted: result.changes });
  });

  // Delete agent — kill running session, reset in-progress tasks before DB delete
  router.delete("/:id", (req, res) => {
    const agentId = req.params.id;
    const agent = db.prepare("SELECT project_id, parent_id FROM agents WHERE id = ?").get(agentId) as any;
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    // Kill any running session for this agent (prevents orphaned processes)
    ctx.sessionManager?.killSession?.(agentId);
    // Clear assignee for all non-done tasks (not just in_progress)
    db.prepare(`
      UPDATE tasks SET assignee_id = NULL,
        status = CASE WHEN status = 'in_progress' THEN 'todo' ELSE status END
      WHERE assignee_id = ? AND status != 'done'
    `).run(agentId);
    // Reassign children to this agent's parent (prevents orphaned subtree)
    db.prepare("UPDATE agents SET parent_id = ? WHERE parent_id = ?").run(agent.parent_id ?? null, agentId);
    const result = db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    if (result.changes === 0) return res.status(404).json({ error: "Agent not found" });
    broadcast("project:updated", { projectId: agent.project_id });
    res.json({ success: true });
  });

  return router;
}
