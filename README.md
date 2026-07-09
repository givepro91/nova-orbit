# Crewdeck

> AI Team Orchestration + Quality Gate for Solo Founders

"Build like a team, even when you're alone." — Orchestrate Claude Code sessions as AI agents, decompose goals into tasks, and verify every output with Crewdeck Quality Gate.

> **Status (2026-07)**: 개인 운영 도구로 유지·관리된다 (대외 배포/npm publish 계획 없음).
> 방향 결정의 배경과 현재 상태는 `docs/design/r3-product-direction.md` · `docs/ROADMAP.md` 참고.

## Screenshots

### Dark Mode (Korean)
![Dark Mode Overview](docs/screenshots/dark-overview.png)

### Light Mode (English)
![Light Mode Overview](docs/screenshots/light-overview.png)

### Kanban Board
![Kanban Board](docs/screenshots/dark-kanban.png)

### Verification Log (5-Dimension Score)
![Verification Log](docs/screenshots/verification-log.png)

## Quick Start

```bash
npx crewdeck
```

Opens `http://127.0.0.1:7200` with a dashboard to manage your AI team.

## What is Crewdeck?

Crewdeck turns your Claude Code CLI sessions into a team of specialized AI agents.
9 role presets ship out of the box (see `templates/agents/`):

| Agent | Role |
|-------|------|
| **CTO** | Goal → task decomposition, architecture decisions |
| **PM** | Planning, prioritization, spec writing |
| **Backend / Frontend** | Implements features, writes production-ready code |
| **UX** | UI/UX design, wireframes, terminology |
| **QA Engineer** | Test strategy, edge cases, regression runs |
| **Reviewer** | Adversarial review, runs Quality Gate |
| **DevOps** | Build, CI, release plumbing |
| **Marketer** | Landing pages, blog posts, SEO content |

Custom agents defined in your project's `.claude/agents/*.md` take priority over presets.

### Core Differentiator: Quality Gate

Every output is independently verified using Crewdeck's Generator-Evaluator separation:

1. **Generator** (Coder) implements the task
2. **Evaluator** (Reviewer) verifies independently — no shared context
3. **5-Dimension Verification**: Functionality, Data Flow, Design Alignment, Craft, Edge Cases
4. Results: PASS / CONDITIONAL / FAIL with severity classification

### Key Features

- `npx` one-line install — SQLite embedded, zero config
- **Kanban board** with drag-and-drop task management
- **Project import** — analyze local directories, auto-detect tech stack, suggest agents
- **GitHub connect** — clone repos, auto-analyze, branch strategy
- **Goal decomposition** — describe what you want, AI breaks it into tasks
- **Real-time** WebSocket streaming of agent output
- **Dark/Light mode** with system detection
- **Korean/English** i18n support
- **Command palette** (Cmd+K) for quick actions
- Built on Claude Code CLI — uses your existing Claude Pro/Team subscription ($0 extra)

### vs Paperclip

| | Paperclip | Crewdeck |
|---|-----------|------------|
| Quality Gate | None | Generator-Evaluator, 5-dimension |
| Setup | Postgres + onboarding | `npx` one-line (SQLite) |
| Agent Runtime | Any (Claude, Codex, HTTP) | Claude Code native |
| UX | Functional dashboard | Notion-style, Kanban, dark mode |
| Target | "Autonomous company" (20+) | Solo founders (3-7 agents) |
| Cost | API keys | Claude Pro subscription ($0 extra) |

## Development

```bash
# Install dependencies
npm install
cd dashboard && npm install && cd ..

# Run dev servers (server + dashboard)
npm run dev

# Type check
npm run typecheck

# Build for production
npm run build

# Start production server
node dist/bin/crewdeck.js
```

## Architecture

```
crewdeck/
├── bin/              # CLI entry point (npx crewdeck)
├── server/           # Node.js backend
│   ├── api/          # REST routes + WebSocket
│   ├── core/
│   │   ├── agent/    # Claude Code CLI adapter + session management
│   │   ├── orchestration/  # Goal → Task decomposition + execution
│   │   ├── project/  # Import, GitHub connect, tech stack analyzer
│   │   └── quality-gate/   # Crewdeck 5-dimension verification engine
│   └── db/           # SQLite schema (7 tables)
├── dashboard/        # React + TailwindCSS + Zustand
│   └── src/
│       ├── components/  # 40+ React components
│       └── i18n/        # Korean + English translations
├── shared/           # TypeScript type definitions
└── templates/        # Agent role presets (YAML)
```

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | React, TailwindCSS v4, Zustand, @dnd-kit |
| Backend | Node.js, Express, TypeScript |
| Database | SQLite (better-sqlite3) |
| Real-time | WebSocket (ws) |
| AI Runtime | Claude Code CLI (subprocess, Paperclip pattern) |
| i18n | react-i18next (ko/en) |
| Build | tsup + Vite |

## License

MIT

## Attribution

Inspired by [Paperclip](https://github.com/paperclipai/paperclip) (MIT License).
Quality Gate 방법론은 Crewdeck 프로젝트에서 출발했으며, 현재는 독립적으로 유지된다.
