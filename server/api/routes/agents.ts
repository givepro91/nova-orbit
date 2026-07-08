import { Router } from "express";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../../index.js";
import { getAgentPresets } from "../../core/agent/roles.js";
import { suggestAgentsFromMission, suggestFromProject, getTeamPresets } from "../../core/agent/suggest.js";
import { designTeam } from "../../core/agent/team-designer.js";
import { resolvePrompt } from "../../core/agent/prompt-resolver.js";
import { getPreset } from "../../core/agent/roles.js";
import { VALID_ROLES } from "../../utils/constants.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("agents-route");

export function createAgentRoutes(ctx: AppContext): Router {
  const router = Router();
  const { db, broadcast } = ctx;

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
    const { mission, techStack, project_id, mode } = req.body;
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
          try {
            const designed = await designTeam({
              projectName: project.name ?? project_id,
              mission: mission ?? project.mission,
              workdir: project.workdir,
              techStack: project.tech_stack ? JSON.parse(project.tech_stack) : techStack ?? null,
            });
            return res.json(designed);
          } catch (err: any) {
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
          suggestions = await designTeam({
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

    const created = [];
    for (const agent of suggestions) {
      // AI 설계 프롬프트는 'custom'으로 저장해야 resolvePrompt 1순위로 주입된다
      const promptSource = agent.source === "ai" && agent.systemPrompt.trim()
        ? "custom"
        : agent.systemPrompt.trim() ? "preset" : "auto";
      const result = db.prepare(`
        INSERT INTO agents (project_id, name, role, system_prompt, prompt_source)
        VALUES (?, ?, ?, ?, ?)
      `).run(project_id, agent.name, agent.role, agent.systemPrompt, promptSource);

      const row = db.prepare("SELECT * FROM agents WHERE rowid = ?").get(result.lastInsertRowid);
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
    const { project_id, name, role, system_prompt = "", session_behavior = "resume-or-new", parent_id, model } = req.body;

    if (!project_id || !name || !role) {
      return res.status(400).json({ error: "project_id, name, and role are required" });
    }

    if (!(VALID_ROLES as readonly string[]).includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` });
    }

    if (model != null && !["opus", "sonnet", "haiku"].includes(model)) {
      return res.status(400).json({ error: "Invalid model. Must be one of: opus, sonnet, haiku" });
    }

    try {
      const effectivePromptSource = system_prompt.trim() ? "custom" : "auto";
      const result = db.prepare(`
        INSERT INTO agents (project_id, name, role, system_prompt, session_behavior, parent_id, prompt_source, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(project_id, name, role, system_prompt, session_behavior, parent_id ?? null, effectivePromptSource, model ?? null);

      const agent = db.prepare("SELECT * FROM agents WHERE rowid = ?").get(result.lastInsertRowid);
      broadcast("agent:status", agent);
      res.status(201).json(agent);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Update agent
  router.patch("/:id", (req, res) => {
    const { status, current_task_id, system_prompt, name, role, parent_id, prompt_source, needs_worktree, model } = req.body;
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
