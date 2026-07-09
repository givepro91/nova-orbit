# Crewdeck Guide

AI Team Orchestration + Quality Gate for Solo Founders.
Claude Code sessions as agents, goal-based orchestration, Nova Quality Gate verification.

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Architecture Overview](#2-architecture-overview)
3. [Project Setup](#3-project-setup)
4. [Agent System](#4-agent-system)
5. [Goal Lifecycle](#5-goal-lifecycle)
6. [Task Execution Pipeline](#6-task-execution-pipeline)
7. [Quality Gate (Verification)](#7-quality-gate-verification)
8. [Retry & Recovery System](#8-retry--recovery-system)
9. [Autopilot Modes](#9-autopilot-modes)
10. [Git Workflow & Branching](#10-git-workflow--branching)
11. [Real-time Dashboard](#11-real-time-dashboard)
12. [Configuration Reference](#12-configuration-reference)
13. [Database Schema](#13-database-schema)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Quick Start

```bash
# Development
npm run dev:server          # tsx watch server (port 7200)
npm run dev:dashboard       # vite dev (port 5173, proxy -> 7200)

# Production build
npm run build               # server (tsup) + dashboard (vite)
node dist/bin/crewdeck.js # start built server

# Type check
npx tsc --noEmit                    # server
cd dashboard && npx tsc --noEmit    # dashboard
```

Open `http://localhost:5173` to access the dashboard.

---

## 2. Architecture Overview

```
User
  |
  v
Dashboard (React + TailwindCSS + Zustand)
  |  WebSocket + REST API
  v
Express Server (port 7200)
  |
  +-- Scheduler          : poll loop, task selection, retry logic
  +-- Orchestration Engine: task execution, verification, delegation
  +-- Quality Gate        : Generator-Evaluator separation, 5-dim scoring
  +-- Session Manager     : Claude Code CLI subprocess management
  +-- Git Workflow        : worktree isolation, commit, merge, PR
  |
  v
SQLite (better-sqlite3, zero config)
  |
  v
Claude Code CLI (--output-format stream-json, --print, --add-dir)
```

### Key Design Principles

- **SQLite** (not Postgres) -- zero config, single file, `npx`-friendly
- **Claude Code CLI subprocess** -- Paperclip pattern (stdin/stdout, `--add-dir`, session resume)
- **Generator-Evaluator separation** -- implementation and verification are ALWAYS different sessions
- **Sequential goal processing** -- one goal at a time, prevents token waste
- **Worktree isolation** -- each agent task in separate git branch

### Directory Structure

```
bin/crewdeck.ts           CLI entry point (npx crewdeck)
server/
  index.ts                  Express + WebSocket server
  db/schema.ts              SQLite schema (8 tables, better-sqlite3)
  api/routes/               REST API routes
    projects.ts             Project CRUD, autopilot toggle, rescue
    agents.ts               Agent CRUD, team suggestion
    goals.ts                Goal CRUD, spec generation trigger
    tasks.ts                Task CRUD, manual execution
    sessions.ts             Session list, kill, cleanup
    orchestration.ts        Queue control, decompose, spec generation
    verification.ts         Verification results
  core/
    agent/
      adapters/claude-code.ts   Claude Code CLI adapter
      session.ts                Session manager (spawn/kill/resume)
      suggest.ts                Smart team suggestion (2-layer priority)
      prompt-resolver.ts        System prompt resolution
      memory.ts                 Agent memory (cross-session context)
    orchestration/
      engine.ts                 Task execution pipeline
      scheduler.ts              Poll loop, retry, circuit breaker
      delegation.ts             Task delegation to subtasks
    quality-gate/
      evaluator.ts              5-dimension verification
    project/
      analyzer.ts               Tech stack detection
      worktree.ts               Git worktree isolation
      git-workflow.ts           Commit, merge, PR creation
    recovery.ts                 Startup recovery (orphan cleanup)
shared/types.ts             Shared TypeScript types
dashboard/                  React + TailwindCSS + Zustand
templates/agents/           YAML role presets (9 roles)
```

---

## 3. Project Setup

### 3.1 Project Import

When you import a local project, Crewdeck:

1. **Validates workdir** -- checks the directory exists and is accessible
2. **Analyzes tech stack** -- scans `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, etc.
   - Detects: languages, frameworks (React, Next.js, Django, FastAPI...), build tools, test frameworks
3. **Suggests agent team** -- based on detected stack (see [Agent System](#4-agent-system))
4. **Extracts mission** -- reads first paragraph from `CLAUDE.md` or `README.md`
5. **Detects project docs** -- scans `docs/plans/`, `docs/references/`, `docs/designs/` for `.md` files

**Relevant code**: `server/core/project/analyzer.ts`

### 3.2 GitHub Configuration (Optional)

Connect a GitHub repo for automated branch management and PR creation:

```json
{
  "repoUrl": "https://github.com/owner/repo",
  "branch": "main",
  "autoPush": false,
  "prMode": "draft"    // "draft" | "auto" | "manual"
}
```

**Relevant code**: `server/core/project/github.ts`

---

## 4. Agent System

### 4.1 Smart Team Suggestion (2-Layer Priority)

Crewdeck suggests an agent team based on your project:

**Layer 1: Project-Defined Agents** (highest priority)
- Place `.md` files in your project's `.claude/agents/` directory
- Each file = one agent definition
- Frontmatter: name, role, description
- Body: system prompt

```markdown
---
name: Backend Developer
role: backend
description: FastAPI + SQLAlchemy specialist
---

# Role
You are a backend developer specializing in FastAPI...
```

**Layer 2: Tech-Stack Defaults** (fallback)
- If no `.claude/agents/` directory exists
- Analyzed from `package.json`, build tools, etc.
- Full-stack project: CTO + Frontend + Backend + Reviewer + QA
- Backend-only: Backend Dev + Reviewer
- Frontend-only: Frontend Dev + Reviewer

**Relevant code**: `server/core/agent/suggest.ts`

### 4.2 Available Role Templates

Crewdeck includes 9 built-in role templates in `templates/agents/`:

| Role | Model | Purpose |
|------|-------|---------|
| CTO | Opus | Architecture, goal decomposition, delegation |
| PM | Opus | Product management, requirements |
| Backend | Sonnet | Server/API/DB implementation |
| Frontend | Sonnet | UI/components/state management |
| Reviewer | Sonnet | Adversarial code review, verification |
| QA | Sonnet | Testing, automation |
| DevOps | Sonnet | Infrastructure, deployment |
| UX | Sonnet | Design, user experience |
| Marketer | Sonnet | Marketing, growth |

### 4.3 System Prompt Resolution

When spawning an agent session, the system prompt is resolved in order:

1. Agent's custom `system_prompt` in DB (user override)
2. `.claude/agents/{agentId}.md` in project
3. `.claude/agents/{role}.md` in project
4. Built-in template from `templates/agents/{role}.yaml`
5. Fallback: minimal default prompt

Additional context injected into every session:
- Project's `CLAUDE.md` content (via `--add-dir`)
- Recent 3 completed task titles
- Tech stack summary
- Agent memory (max 3KB, persisted across sessions)

**Relevant code**: `server/core/agent/prompt-resolver.ts`

### 4.4 Model Selection

Each role has a default model:
- **Opus**: CTO, PM (planning/architecture roles)
- **Sonnet**: all implementation/review roles
- **Custom**: agents can override via DB `model` column

Override via environment: agents respect Claude Code CLI's model settings.

---

## 5. Goal Lifecycle

### 5.1 Goal Creation

Goals represent high-level objectives. Each goal goes through:

```
Created --> Spec Generation --> Decomposition --> Task Execution --> Completed
```

### 5.2 Spec Generation (PRD)

When a goal is created with autopilot enabled:

1. CTO agent analyzes goal title + description
2. Generates structured spec:
   - **PRD Summary**: objective, scope, constraints
   - **Feature Specs**: prioritized feature list
   - **User Flow**: step-by-step interaction flow
   - **Acceptance Criteria**: measurable pass/fail criteria
   - **Tech Considerations**: architecture notes, risks
3. Stored in `goal_specs` table

**Relevant code**: `server/api/routes/orchestration.ts` (`generateGoalSpec`)

### 5.3 Goal Decomposition

After spec generation, the CTO decomposes the goal into executable tasks:

1. Reads spec (features, acceptance criteria)
2. Assigns tasks to appropriate agents by role
3. Each task includes:
   - Title + description
   - **Target files**: exact files the agent should modify (scope constraint)
   - **Stack hint**: framework constraint (e.g., "Next.js App Router")
   - Priority and sort order
4. Tasks created with `pending_approval` status

**Guard clauses**:
- If goal already has tasks, decomposition is skipped (prevents duplicates)
- If decomposition is already in progress, it's rejected (lock guard)

**Special rules**:
- **Fullstack Contract**: If goal touches API + Frontend, first API task must define exact response shape
- **Bootstrap Rule**: If goal touches auth/migrations, a final "Bootstrap" task ensures the feature is reachable

**Relevant code**: `server/core/orchestration/engine.ts` (`decomposeGoal`)

### 5.4 Goal Progress Calculation

Progress = `done_tasks / (total_tasks - permanently_blocked_tasks) * 100`

- Permanently blocked tasks (retry + reassign exhausted) are excluded from the denominator
- A goal with 6 done + 2 permanently blocked = 100% (6/6)

---

## 6. Task Execution Pipeline

### 6.1 Scheduler Poll Loop

The scheduler runs a continuous poll loop when autopilot is enabled:

```
poll() -> pickNextTasks() -> executeOne() -> verify() -> next poll
```

**Task selection rules**:
1. **One goal at a time** -- tasks only picked from the highest-priority active goal
2. **One task per agent** -- each agent works on one task serially
3. **Max N agents in parallel** -- `DEFAULT_MAX_CONCURRENCY` (default: 3)
4. **Reviewer gate** -- QA/reviewer tasks wait until all sibling non-reviewer tasks are done

### 6.2 Execution Phases

Each task execution goes through these phases:

**Phase 0: Delegation Attempt**
- Root tasks may delegate to subtasks based on complexity
- If delegated, parent task returns immediately

**Phase 0.5: Architect Phase** (non-simple tasks)
- CTO agent reviews task requirements
- Produces architecture/design guidance
- Injected into coder's context (not for reviewer/QA tasks)

**Phase 1: Agent Execution**
- Spawn Claude Code CLI session in isolated worktree
- Agent receives: task prompt + architect context + project context
- Session tracks: PID, token usage, cost, status

**Phase 2: Git Commit**
- Stage changes (excluding `.nova-worktrees/`, `.claude/worktrees/`)
- Create commit with task title
- Merge back to main branch

**Phase 3: Quality Gate Verification**
- Independent evaluator reviews the task (see [Quality Gate](#7-quality-gate-verification))
- Verdict: pass -> done, fail -> blocked (retry/auto-fix)

**Relevant code**: `server/core/orchestration/engine.ts` (`executeTask`)

### 6.3 Worktree Isolation

Each task executes in an isolated git worktree:

```
Branch:    agent/{agentSlug}/{taskSlug}-{uid}
Directory: .nova-worktrees/{agentSlug}-{taskSlug}-{uid}/
```

This prevents agents from interfering with each other's work or the main branch.

**Relevant code**: `server/core/project/worktree.ts`

---

## 7. Quality Gate (Verification)

### 7.1 Generator-Evaluator Separation

**Core principle**: The agent that implements code NEVER verifies its own work.

- Generator: the agent that wrote the code
- Evaluator: a DIFFERENT agent (preferably with `reviewer` role)
- Each verification spawns a fresh session with no prior context

### 7.2 5-Dimension Scoring

Every task is evaluated across 5 dimensions (0-100 each):

| Dimension | What it checks |
|-----------|---------------|
| **Functionality** | Does the code do exactly what was requested? |
| **Data Flow** | Input -> Save -> Load -> Display complete? |
| **Design Alignment** | Matches existing architecture, patterns, naming? |
| **Craft** | Error handling, type safety, edge cases, no dead code? |
| **Edge Cases** | 0, negative, empty, null, max values handled? |

### 7.3 Issue Severity Classification

| Severity | Meaning | Action |
|----------|---------|--------|
| `auto-resolve` | Style, comments, minor | Logged as info |
| `soft-block` | Runtime risk possible | Auto-fix cycle triggered |
| `hard-block` | Data loss, security issue | Task blocked immediately |

### 7.4 Verification Verdicts

| Verdict | Condition | Result |
|---------|-----------|--------|
| `pass` | All dimensions >= 80, no hard-blocks | Task -> done |
| `conditional` | Mostly OK, soft-blocks only | Task -> done (with warning) |
| `fail` | Hard-blocks or low scores | Task -> blocked (retry) |

### 7.5 Auto-Fix Cycle

When verification fails with `autoFix=true`:

1. Spawn a NEW fix session (same agent, fresh context)
2. Pass evaluator's issues as fix instructions
3. Agent fixes only the reported issues
4. Re-verify with same scope
5. If still fails: task transitions to `blocked`

**Smart Resume**: Previous failure history is passed to the fix session to prevent repeating the same mistakes.

### 7.6 Verification Scopes

| Scope | Depth | When used |
|-------|-------|-----------|
| `lite` | Layer 1 only | Simple tasks, subtasks |
| `standard` | Layers 1-2 | Most tasks (default) |
| `full` | Complete protocol | Complex tasks, critical priority |

**Relevant code**: `server/core/quality-gate/evaluator.ts`

---

## 8. Retry & Recovery System

### 8.1 Task Retry Flow

When a task is blocked after verification failure:

```
blocked (retry=0)
  -- 10s cooldown -->  retry #1 (same agent)
  -- 20s cooldown -->  retry #2 (same agent)
  -- 40s cooldown -->  reassign to different agent, retry reset to 0
  -- 10s cooldown -->  retry #1 (new agent)
  -- 20s cooldown -->  retry #2 (new agent)
  --> permanently blocked --> auto-resolved (done, skipped)
```

**Total**: up to 6 execution attempts before auto-resolution.

### 8.2 Exponential Backoff

Cooldown between retries doubles with each attempt:

| Retry Level | Cooldown |
|-------------|----------|
| 0 (1st retry) | 10s |
| 1 (2nd retry) | 20s |
| Reassignment | 40s |

Base cooldown configurable via `NOVA_BLOCKED_RETRY_DELAY_MS` (default: 10000).

### 8.3 Circuit Breaker

If the same verification error repeats across 2 consecutive failures:
- Compare error signatures (severity + message, line numbers normalized)
- If identical: exhaust retry budget immediately
- Prevents burning tokens on unsolvable issues

### 8.4 Auto-Resolution of Permanently Blocked Tasks

When a task exhausts both retry and reassign budgets:
- Automatically marked as `done` with result: `[Auto-skipped]`
- Activity log records: "Auto-skipped: {title} -- retries exhausted"
- Goal progress recalculated (task excluded from denominator)
- Next goal can proceed without user intervention

### 8.5 Ghost Task Cleanup

On each scheduler poll, stale tasks are detected:
- Tasks in `in_progress`/`in_review` with no live agent process
- Idle longer than 3x task timeout (default: 30 minutes)
- Recovered to `todo` (if retries remain) or `blocked` (if exhausted)

### 8.6 Startup Recovery

On every server start:
1. Crashed `in_progress` tasks -> restored to `todo`
2. Orphan Claude processes -> killed (SIGTERM)
3. All `active` sessions -> marked `killed`
4. `working` agents -> reset to `idle`
5. Stuck `generating` specs -> marked `failed`
6. Stale worktrees -> cleaned up

**Relevant code**: `server/core/recovery.ts`

---

## 9. Autopilot Modes

### 9.1 Mode Comparison

| Feature | Off | Goal | Full |
|---------|-----|------|------|
| Spec generation | Manual | Auto | Auto |
| Task decomposition | Manual | Auto | Auto |
| Task approval | Manual | Auto | Auto |
| Task execution | Manual | Auto | Auto |
| Goal generation | Manual | Manual | Auto (CTO) |
| Queue management | Stopped | Running | Running |

### 9.2 Off Mode

- Scheduler queue is stopped
- User manually creates goals, approves tasks, triggers execution
- Best for: reviewing agent work step-by-step

### 9.3 Goal Mode

- Scheduler continuously processes tasks
- For each goal: auto-spec -> auto-decompose -> auto-approve -> execute
- **Sequential**: one goal at a time by priority
- User creates goals manually
- Best for: hands-on goal management with automated execution

### 9.4 Full Mode

- CTO agent generates goals from project mission
- Everything automated: goals -> specs -> tasks -> execution -> verification
- Downgrades to Goal mode after all generated goals complete
- Best for: overnight/unattended execution

### 9.5 Mode Switching

**Off -> Goal/Full**:
1. `rescuePendingGoals()` resumes any stuck goals
2. Sequential guard: only rescues FIRST pending goal if no active goal exists
3. Starts queue for existing `todo` tasks

**Goal/Full -> Off**:
1. Queue stopped
2. Active agent sessions killed
3. In-progress tasks reset to `todo`

**Relevant code**: `server/api/routes/projects.ts` (lines 93-230)

### 9.6 Sequential Goal Processing

Goals are processed one at a time:

1. Active goal identified (has in-progress/todo tasks)
2. All tasks in active goal must complete (or be permanently blocked)
3. Then: next goal by priority is picked
4. Spec generation -> decomposition -> execution for next goal
5. Repeat

This prevents token waste from parallel spec generation across multiple goals.

---

## 10. Git Workflow & Branching

### 10.1 Branch Naming

```
agent/{agentSlug}/{taskSlug}-{8-char-uid}
```

Examples:
- `agent/backend-dev/user-auth-signup-a2f4c1e9`
- `agent/frontend-dev/dashboard-layout-7b3e2d1f`

### 10.2 Commit Flow

1. Agent works in isolated worktree
2. Changes staged (excluding `.nova-worktrees/`, `.claude/worktrees/`)
3. Commit created with task title + agent name
4. Merge to main branch (fast-forward preferred)

### 10.3 Git Error Classification

| Error | Class | Action |
|-------|-------|--------|
| Nothing to commit | Benign | Task marked done |
| index.lock | Recoverable | Wait + retry |
| Merge conflict | Permanent | Task blocked |
| Auth failed | Permanent | Task blocked |

### 10.4 GitHub PR Integration

When GitHub is configured:
- Agent branch pushed to remote
- PR created: title = task title, body = description + verification result
- Mode: draft (manual review) or auto (auto-merge)

**Relevant code**: `server/core/project/git-workflow.ts`

---

## 11. Real-time Dashboard

### 11.1 WebSocket Events

The dashboard receives real-time updates via WebSocket:

| Event | Data | Trigger |
|-------|------|---------|
| `project:updated` | Project state | Goal/task status change |
| `task:updated` | Task status, verdict | Task completion/failure |
| `agent:status` | Agent status, activity | Agent starts/stops working |
| `agent:output` | Raw stdout | Agent session output |
| `verification:result` | Dimensions, issues | Verification complete |
| `queue:paused` | Reason | Rate limit or stuck |
| `queue:resumed` | - | Queue resumes |
| `autopilot:full-status` | Phase, progress | Full autopilot phases |
| `system:rate-limit` | Wait time, message | API rate limit hit |
| `system:error` | Error details | Agent failure |

### 11.2 Authentication

- API key stored in `.crewdeck/api-key`
- Dashboard fetches key from `GET /api/auth/key?init=true` (localhost only)
- All API requests require `Authorization: Bearer {key}`
- WebSocket authenticated via `token` query param

---

## 12. Configuration Reference

### 12.1 Environment Variables

All configurable via environment variables in `server/utils/constants.ts`:

#### Scheduler

| Variable | Default | Description |
|----------|---------|-------------|
| `NOVA_POLL_INTERVAL_MS` | `1000` | Poll interval when idle (ms) |
| `NOVA_MAX_CONCURRENCY` | `3` | Max parallel agents |
| `NOVA_BACKOFF_BASE_MS` | `60000` | Rate limit backoff base (ms) |
| `NOVA_BACKOFF_MAX_MS` | `300000` | Max backoff (5 min) |
| `NOVA_MAX_RATE_LIMITS` | `3` | Consecutive rate limits before long cooldown |
| `NOVA_RATE_LIMIT_COOLDOWN_MS` | `900000` | Long cooldown (15 min) |

#### Execution

| Variable | Default | Description |
|----------|---------|-------------|
| `NOVA_TASK_TIMEOUT_MS` | `600000` | Task timeout (10 min) |
| `NOVA_RATE_LIMIT_WAIT_MS` | `60000` | Wait on rate limit (60s) |

#### Retry

| Variable | Default | Description |
|----------|---------|-------------|
| `NOVA_MAX_TASK_RETRIES` | `2` | Max retries with same agent |
| `NOVA_MAX_REASSIGNS` | `1` | Max agent reassignments |
| `NOVA_BLOCKED_RETRY_DELAY_MS` | `10000` | Base retry cooldown (10s) |

#### Development

| Variable | Default | Description |
|----------|---------|-------------|
| `NOVA_NO_AUTO_QUEUE` | - | Set to disable auto-queue on server start |

### 12.2 Text Limits

| Constant | Value |
|----------|-------|
| `MAX_TITLE_LEN` | 200 |
| `MAX_DESC_LEN` | 2000 |
| `MAX_PROMPT_LEN` | 50,000 |
| `MAX_SUMMARY_LEN` | 500 |
| `MAX_TASKS_PER_GOAL` | 10 |

---

## 13. Database Schema

SQLite database at `.crewdeck/crewdeck.db`.

### Core Tables

**projects** -- Project configuration and state
```
id, name, mission, source, workdir, github_config (JSON),
tech_stack (JSON), status, autopilot, dev_port, created_at, updated_at
```

**agents** -- Agent definitions and runtime state
```
id, project_id, name, role, status, system_prompt, prompt_source,
model, current_task_id, current_activity, parent_id, needs_worktree,
created_at
```

**goals** -- High-level objectives
```
id, project_id, title, description, priority, progress (0-100),
references (JSON), sort_order, created_at
```

**goal_specs** -- AI-generated specifications
```
goal_id, prd_summary (JSON), feature_specs (JSON), user_flow (JSON),
acceptance_criteria (JSON), tech_considerations (JSON), generated_by,
created_at, updated_at
```

**tasks** -- Executable work items
```
id, goal_id, project_id, title, description, assignee_id,
parent_task_id, status, priority, sort_order, target_files (JSON),
stack_hint, verification_id, retry_count, reassign_count,
result_summary, started_at, updated_at
```

**verifications** -- Quality gate results
```
id, task_id, verdict, scope, dimensions (JSON), issues (JSON),
severity, evaluator_session_id, created_at
```

**sessions** -- Claude Code CLI process tracking
```
id, agent_id, pid, started_at, ended_at, status,
token_usage, cost_usd, last_output
```

**activities** -- Audit trail / activity feed
```
id, project_id, agent_id, type, message, metadata (JSON), created_at
```

---

## 14. Troubleshooting

### Tasks stuck in "blocked"

**Cause**: Verification keeps failing with same error
**Solution**: Now auto-resolved. After retry + reassign budget exhausted, tasks are auto-skipped with `[Auto-skipped]` tag. Check activity log for details.

### Spec generation stuck at "generating"

**Cause**: CTO session crashed or was killed mid-generation
**Solution**: Server restart auto-recovers (marks as "failed"). Re-trigger by toggling autopilot off -> on.

### Multiple goals starting simultaneously

**Cause**: `rescuePendingGoals` was processing all pending goals at once
**Solution**: Fixed. Only the first pending goal (by priority) is rescued. Sequential processing enforced.

### Agent sessions not stopping after autopilot off

**Cause**: Active sessions weren't being killed on mode switch
**Solution**: Autopilot off now kills all active sessions + stops queue + resets in-progress tasks.

### Ghost "working" agents on dashboard

**Cause**: Server crashed without graceful shutdown
**Solution**: Startup recovery resets all `working` agents to `idle` and kills orphan processes.

### Rate limit errors flooding

**Cause**: Multiple agents hitting API concurrency limits
**Solution**: Exponential backoff + max consecutive rate limit handling. After 3 consecutive limits, enters 15-minute cooldown then auto-resumes.

### Worktree cleanup failures

**Cause**: Leftover `.nova-worktrees/` directories after server crash
**Solution**: Startup recovery cleans stale worktrees. Manual: `rm -rf .nova-worktrees/` in project dir.
