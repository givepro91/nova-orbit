# Codex 백엔드 지원 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Crewdeck 에이전트 백엔드를 Claude 전용에서 Claude/Codex 선택 + 한도/오류 시 자동 failover 구조로 확장한다.

**Architecture:** 암묵적 `ClaudeCodeSession`을 provider-중립 `AgentBackend` 인터페이스로 추출하고, `codex exec --json` 어댑터 + Codex 전용 JSONL 파서를 추가한다. provider는 agent→project→전역 순으로 해석하고, 세션이 rate-limit/소진/env 오류로 실패하면 scheduler가 같은 태스크를 대체 백엔드로 즉시 재디스패치한다(대기 대신). 실행 중 healthy 세션은 절대 죽이지 않는다.

**Tech Stack:** TypeScript, Node 26, Express 5, better-sqlite3, vitest. 어댑터는 child_process `spawn`. Codex CLI 0.141.0 (`codex exec --json`).

**설계 스펙:** `docs/superpowers/specs/2026-07-09-codex-backend-design.md`

## Global Constraints

- **언어**: 코드/식별자/커밋 prefix는 원문, 주석/문서/사용자 노출은 한국어. UI 문자열은 `.claude/rules/ux-terminology.md` 준수 — "provider/backend" 노출 금지, **"실행 엔진"** 사용.
- **하위호환 필수**: 모든 신규 컬럼/config는 미설정 시 현행 claude 동작과 동일. 기존 vitest(현 281건) 그린 유지.
- **검증 명령**: server `npm run typecheck`, dashboard `cd dashboard && npx tsc -b`(`tsc --noEmit`은 no-op 금지), `npx vitest run`.
- **빌드**: `npm run build:server` 단독 금지. 전체 `npm run build`.
- **DB 마이그레이션**: 별도 파일 없음 — `server/db/schema.ts`의 `migrate()`에 인라인 `ALTER TABLE ... ADD COLUMN` (try/catch 멱등). API 경유 원칙 유지.
- **DRY, YAGNI, TDD, 잦은 커밋.** 커밋 prefix: `feat:`/`refactor:`/`test:`/`docs:`.
- **커밋은 명시 경로만 스테이징** (`git add .` 금지). 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

**신규:**
- `server/core/agent/adapters/backend.ts` — `AgentBackend`/`AgentSession` 인터페이스 + `getBackend(provider)` 팩토리
- `server/core/agent/adapters/codex.ts` — Codex `codex exec --json` 어댑터
- `server/core/agent/adapters/codex-stream-parser.ts` — Codex JSONL → `ParsedStreamOutput` 정규화
- `server/core/agent/provider.ts` — `resolveProvider()` + config 로드(defaultProvider/codexFailover/codexModelMap)
- `server/core/agent/failover.ts` — `decideFailover()` 순수 결정 로직
- `server/__tests__/codex-stream-parser.test.ts`
- `server/__tests__/provider-resolution.test.ts`
- `server/__tests__/failover-decision.test.ts`
- `server/__tests__/fixtures/codex-exec-basic.jsonl` — 실캡처 fixture

**수정:**
- `server/core/agent/adapters/claude-code.ts` — `AgentBackend` 구현 형태로 정리(동작 무변경) + provider 필드
- `server/core/agent/adapters/stream-parser.ts` — 변경 없음(claude 전용 유지)
- `server/core/agent/session.ts` — `getBackend(provider)` 사용, provider를 spawn/session에 전파, Codex는 시스템프롬프트 stdin prepend
- `server/core/agent/roles.ts` / `server/utils/constants.ts` — 필요 시 provider 기본값 상수
- `server/utils/errors.ts` — `classifyAgentFailure`에 Codex 신호 분기
- `server/core/orchestration/scheduler.ts` — 실패 처리에 failover 분기(쿨다운보다 우선)
- `server/core/orchestration/engine.ts` — 파서 호출을 provider-aware로, 세션 결과에 provider 기록
- `server/db/schema.ts` — `agents.provider`, `projects.default_provider`, `sessions.provider` 마이그레이션
- `server/api/routes/agents.ts`, `projects.ts` — provider 필드 read/write
- `dashboard/src/components/AgentDetail.tsx`, `ProjectSettings.tsx` — 실행 엔진 선택 UI
- `dashboard/src/i18n/en.ts`, `ko.ts` — 라벨

---

## Task 1: Codex JSONL 실캡처 fixture 확보

**Files:**
- Create: `server/__tests__/fixtures/codex-exec-basic.jsonl`

**Interfaces:**
- Produces: 파서 테스트가 읽을 실 Codex `--json` 이벤트 fixture (Task 2가 소비).

Codex `--json`(codex-cli 0.141.0) 실행 시 이벤트 스키마 (실측):
- `{"type":"thread.started","thread_id":"<uuid>"}` — 세션 id
- `{"type":"turn.started"}`
- `{"type":"item.completed","item":{"id":"item_N","type":"agent_message","text":"..."}}` — 텍스트 출력
- `{"type":"item.completed","item":{"id":"item_N","type":"error","message":"..."}}` — **비치명 경고**(exit 0에도 나옴)
- `{"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N,"reasoning_output_tokens":N}}` — usage(⚠ cost 없음)

- [ ] **Step 1: fixture 파일 작성**

`server/__tests__/fixtures/codex-exec-basic.jsonl` (한 줄당 하나의 JSON):

```
{"type":"thread.started","thread_id":"019f45ac-d922-7b23-a938-a7df3b4f54d6"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Under-development features enabled: remote_plugin."}}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"작업을 완료했습니다."}}
{"type":"turn.completed","usage":{"input_tokens":18041,"cached_input_tokens":4992,"output_tokens":22,"reasoning_output_tokens":15}}
```

- [ ] **Step 2: 커밋**

```bash
git add server/__tests__/fixtures/codex-exec-basic.jsonl
git commit -m "test: Codex exec --json 실캡처 fixture 추가"
```

---

## Task 2: Codex JSONL 파서 (`codex-stream-parser.ts`)

**Files:**
- Create: `server/core/agent/adapters/codex-stream-parser.ts`
- Test: `server/__tests__/codex-stream-parser.test.ts`

**Interfaces:**
- Consumes: `ParsedStreamOutput` 타입 (`adapters/stream-parser.ts`에서 export — `{ text, usage, tools, rateLimit, sessionId, errors }`; 실제 필드는 stream-parser.ts:33-48 확인).
- Produces: `parseCodexJson(rawOutput: string): ParsedStreamOutput` — codex JSONL을 claude 파서와 **동일한** 반환 타입으로 정규화.

- [ ] **Step 1: 반환 타입 확인**

Read `server/core/agent/adapters/stream-parser.ts:11-48` — `UsageInfo`, `RateLimitInfo`, `ParsedStreamOutput` 필드명을 그대로 재사용한다(claude와 동일 shape). `ParsedStreamOutput`을 `stream-parser.ts`에서 import.

- [ ] **Step 2: 실패 테스트 작성**

`server/__tests__/codex-stream-parser.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCodexJson } from "../core/agent/adapters/codex-stream-parser.js";

const fixture = readFileSync(join(__dirname, "fixtures/codex-exec-basic.jsonl"), "utf-8");

describe("parseCodexJson", () => {
  it("agent_message item.text를 최종 텍스트로 추출", () => {
    const r = parseCodexJson(fixture);
    expect(r.text).toBe("작업을 완료했습니다.");
  });
  it("thread.started.thread_id를 sessionId로 추출", () => {
    expect(parseCodexJson(fixture).sessionId).toBe("019f45ac-d922-7b23-a938-a7df3b4f54d6");
  });
  it("turn.completed.usage에서 토큰 집계 (Codex는 cost 미보고 → 0)", () => {
    const u = parseCodexJson(fixture).usage!;
    expect(u.inputTokens).toBe(18041);
    expect(u.outputTokens).toBe(22);
    expect(u.cacheReadTokens).toBe(4992);
    expect(u.totalCostUsd).toBe(0);
  });
  it("item.type=='error'는 치명 실패로 보지 않는다(비치명 경고)", () => {
    expect(parseCodexJson(fixture).errors).toHaveLength(0);
  });
  it("빈/비JSONL 입력에 방어적", () => {
    expect(parseCodexJson("").text).toBe("");
    expect(parseCodexJson("not json\n{bad").text).toBe("");
  });
});
```

> 확정된 타입 (stream-parser.ts:11-48): `UsageInfo = { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalCostUsd, durationMs, numTurns }` (전부 number), `ParsedStreamOutput = { text, sessionId, lineCount, toolUses, errors, usage, rateLimit }`. Codex parser는 이 shape을 정확히 채운다.

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx vitest run server/__tests__/codex-stream-parser.test.ts`
Expected: FAIL — `parseCodexJson is not a function` (모듈 없음).

- [ ] **Step 4: 파서 구현**

`server/core/agent/adapters/codex-stream-parser.ts`:

```ts
import type { ParsedStreamOutput } from "./stream-parser.js";

/** Codex `codex exec --json` JSONL을 claude 파서와 동일한 ParsedStreamOutput으로 정규화. */
export function parseCodexJson(rawOutput: string): ParsedStreamOutput {
  const result: ParsedStreamOutput = {
    text: "", sessionId: null, lineCount: 0, toolUses: [], errors: [], usage: null, rateLimit: null,
  };
  const lines = rawOutput.split("\n").map((l) => l.trim()).filter(Boolean);
  result.lineCount = lines.length;
  let lastMessage = "";
  for (const line of lines) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    switch (ev?.type) {
      case "thread.started":
        if (ev.thread_id) result.sessionId = ev.thread_id;
        break;
      case "item.completed": {
        const item = ev.item ?? {};
        if (item.type === "agent_message" && typeof item.text === "string") {
          lastMessage = item.text; // 최종 메시지 = 마지막 agent_message
        } else if (item.type === "command_execution" || item.type === "tool_call") {
          result.toolUses.push({ name: item.type, input: item });
        }
        // item.type === "error" 는 비치명 경고(dev features/skill budget) — errors에 넣지 않음
        break;
      }
      case "turn.completed": {
        const u = ev.usage ?? {};
        result.usage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cached_input_tokens ?? 0,
          cacheCreationTokens: 0,
          totalCostUsd: 0,        // Codex는 cost 미보고
          durationMs: 0,
          numTurns: 1,
        };
        break;
      }
    }
  }
  result.text = lastMessage;
  if (lines.length === 0) result.errors.push("Empty stdout from Codex CLI");
  return result;
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx vitest run server/__tests__/codex-stream-parser.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: 커밋**

```bash
git add server/core/agent/adapters/codex-stream-parser.ts server/__tests__/codex-stream-parser.test.ts
git commit -m "feat: Codex JSONL 파서 — ParsedStreamOutput 정규화"
```

---

## Task 3: `AgentBackend` 인터페이스 추출 + claude 어댑터 정리

**Files:**
- Create: `server/core/agent/adapters/backend.ts`
- Modify: `server/core/agent/adapters/claude-code.ts` (타입 export 정리, 동작 무변경)

**Interfaces:**
- Consumes: 기존 `ClaudeCodeConfig`, `ClaudeCodeSession`, `RunResult` (`claude-code.ts:22-50`).
- Produces:
  - `type AgentProvider = "claude" | "codex"`
  - `interface AgentSession extends EventEmitter { id: string; process: ChildProcess | null; status: string; lastSessionId: string | null; send(msg: string): void; kill(): void; cleanup(): void; }`
  - `interface AgentBackendConfig` (= 현 `ClaudeCodeConfig`와 동일 필드 + `provider?: AgentProvider`)
  - `interface AgentBackend { readonly provider: AgentProvider; spawn(config: AgentBackendConfig): AgentSession; isAvailable(): Promise<boolean>; }`
  - `getBackend(provider: AgentProvider): AgentBackend`

- [ ] **Step 1: `backend.ts` 작성 (인터페이스 + 팩토리 스텁)**

```ts
import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import { createClaudeCodeAdapter, type ClaudeCodeConfig } from "./claude-code.js";

export type AgentProvider = "claude" | "codex";

export interface AgentSession extends EventEmitter {
  id: string;
  process: ChildProcess | null;
  status: string;
  lastSessionId: string | null;
  send(message: string): void;
  kill(): void;
  cleanup(): void;
}

export type AgentBackendConfig = ClaudeCodeConfig & { provider?: AgentProvider };

export interface AgentBackend {
  readonly provider: AgentProvider;
  spawn(config: AgentBackendConfig): AgentSession;
  isAvailable(): Promise<boolean>;
}

export function getBackend(provider: AgentProvider): AgentBackend {
  if (provider === "codex") {
    // Task 4에서 교체
    throw new Error("codex backend not yet wired");
  }
  const claude = createClaudeCodeAdapter();
  return {
    provider: "claude",
    spawn: (config) => claude.spawn(config) as unknown as AgentSession,
    isAvailable: async () => true, // claude는 런타임 전제
  };
}
```

- [ ] **Step 2: 기존 회귀 그린 확인 (동작 무변경)**

Run: `npm run typecheck && npx vitest run`
Expected: PASS — 기존 전 테스트 그린 (인터페이스만 추가, 소비자 미변경).

- [ ] **Step 3: 커밋**

```bash
git add server/core/agent/adapters/backend.ts
git commit -m "refactor: AgentBackend provider-중립 인터페이스 추출"
```

---

## Task 4: Codex 어댑터 (`codex.ts`)

**Files:**
- Create: `server/core/agent/adapters/codex.ts`
- Modify: `server/core/agent/adapters/backend.ts:getBackend` (codex 분기 연결)

**Interfaces:**
- Consumes: `AgentBackend`, `AgentSession`, `AgentBackendConfig` (Task 3), `parseCodexJson` (Task 2).
- Produces: `createCodexAdapter(): AgentBackend`.

Codex CLI 매핑 (실측):
- 커맨드: `codex exec --json --skip-git-repo-check -C <workdir> [--add-dir <tempDir>] [-m <model>] <sandboxFlag> -`
- 프롬프트: stdin (`-`). **시스템프롬프트 + enriched 컨텍스트를 stdin 본문 앞에 prepend** (Task 5의 session.ts에서 합쳐 전달).
- sandboxFlag: 기본 `-s workspace-write` (에이전트가 워크트리에 써야 함). `~/.crewdeck/config.json`의 `allowDangerousPermissions === true`면 `--dangerously-bypass-approvals-and-sandbox`.
- resume: 1차 미사용(fresh). `config.resumeSessionId` 있으면 `codex exec resume <uuid> --json ...`. (미지원 시 fresh fallback)
- 이벤트 계약: claude 어댑터와 동일하게 `status`/`pid`/`output`/`stderr`/`rate-limit`/`crewdeck:error` emit.

- [ ] **Step 1: claude 어댑터 spawn 구조 참고**

Read `server/core/agent/adapters/claude-code.ts:68-376` (spawn·이벤트 emit·stdin write·cleanup) 와 `384-444`(buildArgs). Codex 어댑터는 **동일한 이벤트·라이프사이클**을 유지하되 커맨드/인자/파서만 교체.

- [ ] **Step 2: `codex.ts` 구현**

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../../../utils/logger.js";
import type { AgentBackend, AgentBackendConfig, AgentSession } from "./backend.js";
import { parseCodexJson } from "./codex-stream-parser.js";

const log = createLogger("codex-adapter");

function buildCodexArgs(config: AgentBackendConfig, tempDir: string): string[] {
  const args = ["exec", "--json", "--skip-git-repo-check", "-C", config.workdir];
  if (tempDir) args.push("--add-dir", tempDir);
  if (config.model) args.push("-m", config.model);
  let dangerous = false;
  try {
    const cfgPath = join(homedir(), ".crewdeck", "config.json");
    if (existsSync(cfgPath)) dangerous = JSON.parse(readFileSync(cfgPath, "utf-8")).allowDangerousPermissions === true;
  } catch { /* 기본 안전 */ }
  args.push(dangerous ? "--dangerously-bypass-approvals-and-sandbox" : "-s", dangerous ? "" : "workspace-write");
  return args.filter(Boolean).concat("-"); // 프롬프트는 stdin
}

export function createCodexAdapter(): AgentBackend {
  return {
    provider: "codex",
    async isAvailable() {
      return await new Promise<boolean>((resolve) => {
        const p = spawn("codex", ["--version"], { stdio: "ignore" });
        p.on("error", () => resolve(false));
        p.on("exit", (code) => resolve(code === 0));
      });
    },
    spawn(config) {
      const session = new EventEmitter() as AgentSession;
      session.id = `codex-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      session.status = "spawning";
      session.lastSessionId = config.resumeSessionId ?? null;
      const tempDir = /* claude 어댑터와 동일하게 skills/memory temp dir 준비 */ config.skillsDir ?? "";
      const args = buildCodexArgs(config, tempDir);
      const proc: ChildProcess = spawn("codex", args, { cwd: config.workdir, stdio: ["pipe", "pipe", "pipe"] });
      session.process = proc;
      session.emit("pid", proc.pid);
      session.emit("status", "running");
      let stdout = "", stderr = "";
      proc.stdout?.on("data", (d) => { const s = d.toString(); stdout += s; session.emit("output", s); });
      proc.stderr?.on("data", (d) => { const s = d.toString(); stderr += s; session.emit("stderr", s); });
      // stdin: 시스템프롬프트+컨텍스트가 이미 config.systemPrompt+프롬프트로 합쳐져 send()로 들어옴
      session.send = (message: string) => { proc.stdin?.write(message); proc.stdin?.end(); };
      session.kill = () => { try { proc.kill("SIGTERM"); } catch { /* noop */ } };
      session.cleanup = () => { session.kill(); session.removeAllListeners(); };
      proc.on("exit", (code) => {
        const parsed = parseCodexJson(stdout);
        if (parsed.sessionId) session.lastSessionId = parsed.sessionId;
        session.status = code === 0 ? "completed" : "failed";
        session.emit("status", session.status);
        session.emit("exit", { exitCode: code, stdout, stderr, sessionId: parsed.sessionId });
      });
      proc.on("error", (err) => { session.emit("crewdeck:error", { code: "SPAWN_FAILED", message: String(err) }); });
      return session;
    },
  };
}
```

> ⚠ Step 1에서 확인한 claude 어댑터의 **temp dir 준비(skills/memory/시스템프롬프트 파일)·send 타이밍(spawn 후 emit)·이벤트 이름**을 정확히 맞출 것. 특히 `session.process`가 null인 상태 emit 금지(CLAUDE.md Known Mistakes) — spawn 직후 pid/status emit.

- [ ] **Step 3: `getBackend` codex 분기 연결**

`backend.ts`의 `getBackend`에서:

```ts
import { createCodexAdapter } from "./codex.js";
// ...
if (provider === "codex") return createCodexAdapter();
```

- [ ] **Step 4: 어댑터 가용성 유닛 테스트 + typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: PASS (기존 그린 유지, 새 모듈 컴파일).

- [ ] **Step 5: 실 Codex 세션 스모크 (수동, 1회)**

임시 git repo에서 `getBackend("codex").spawn({...})`로 사소한 프롬프트를 돌려 `output`/`exit` 이벤트와 `parseCodexJson(stdout).text`가 채워지는지 확인(스크립트 or 노드 REPL). 결과를 커밋 메시지에 요약.

- [ ] **Step 6: 커밋**

```bash
git add server/core/agent/adapters/codex.ts server/core/agent/adapters/backend.ts
git commit -m "feat: Codex exec --json 어댑터 + getBackend 연결"
```

---

## Task 5: provider 해석 + DB/config + session.ts 배선

**Files:**
- Create: `server/core/agent/provider.ts`
- Modify: `server/db/schema.ts` (마이그레이션), `server/core/agent/session.ts` (getBackend 사용·provider 전파·Codex stdin prepend), `server/api/routes/agents.ts`·`projects.ts` (provider read/write)
- Test: `server/__tests__/provider-resolution.test.ts`

**Interfaces:**
- Produces:
  - `resolveProvider(agent: {provider?: string|null}, project: {default_provider?: string|null}, config: {defaultProvider?: string}): AgentProvider`
  - `loadProviderConfig(): { defaultProvider: AgentProvider; codexFailover: boolean; codexModelMap: Record<string,string> }`
- Consumes: `AgentProvider` (Task 3), `getBackend` (Task 4).

- [ ] **Step 1: 마이그레이션 추가**

`server/db/schema.ts`의 `migrate()`에 (기존 `ALTER TABLE agents ADD COLUMN model` 패턴 옆, 멱등 try/catch):

```ts
try { db.exec("ALTER TABLE agents ADD COLUMN provider TEXT"); } catch { /* exists */ }
try { db.exec("ALTER TABLE projects ADD COLUMN default_provider TEXT"); } catch { /* exists */ }
try { db.exec("ALTER TABLE sessions ADD COLUMN provider TEXT"); } catch { /* exists */ }
```

- [ ] **Step 2: `resolveProvider` 실패 테스트**

`server/__tests__/provider-resolution.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveProvider } from "../core/agent/provider.js";

describe("resolveProvider", () => {
  const cfg = { defaultProvider: "claude" as const, codexFailover: true, codexModelMap: {} };
  it("agent.provider가 최우선", () => {
    expect(resolveProvider({ provider: "codex" }, { default_provider: "claude" }, cfg)).toBe("codex");
  });
  it("agent null이면 project 기본", () => {
    expect(resolveProvider({ provider: null }, { default_provider: "codex" }, cfg)).toBe("codex");
  });
  it("둘 다 null이면 전역 기본", () => {
    expect(resolveProvider({ provider: null }, { default_provider: null }, cfg)).toBe("claude");
  });
  it("잘못된 값은 전역 기본으로 폴백", () => {
    expect(resolveProvider({ provider: "gpt" as any }, { default_provider: null }, cfg)).toBe("claude");
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx vitest run server/__tests__/provider-resolution.test.ts` → FAIL (모듈 없음).

- [ ] **Step 4: `provider.ts` 구현**

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentProvider } from "./adapters/backend.js";

const VALID: AgentProvider[] = ["claude", "codex"];
function coerce(v: unknown, fallback: AgentProvider): AgentProvider {
  return VALID.includes(v as AgentProvider) ? (v as AgentProvider) : fallback;
}

export function resolveProvider(
  agent: { provider?: string | null },
  project: { default_provider?: string | null },
  config: { defaultProvider?: string },
): AgentProvider {
  const globalDefault = coerce(config.defaultProvider, "claude");
  if (agent?.provider) return coerce(agent.provider, globalDefault);
  if (project?.default_provider) return coerce(project.default_provider, globalDefault);
  return globalDefault;
}

export function loadProviderConfig() {
  let raw: any = {};
  try {
    const p = join(homedir(), ".crewdeck", "config.json");
    if (existsSync(p)) raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch { /* 기본값 */ }
  return {
    defaultProvider: coerce(raw.defaultProvider, "claude"),
    codexFailover: raw.codexFailover !== false, // 기본 true
    codexModelMap: (raw.codexModelMap ?? {}) as Record<string, string>,
  };
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx vitest run server/__tests__/provider-resolution.test.ts` → PASS (4 tests).

- [ ] **Step 6: `session.ts` 배선**

`server/core/agent/session.ts` 수정:
- `import { createClaudeCodeAdapter }` (session.ts:4) 제거, `import { getBackend } from "./adapters/backend.js"` + `import { resolveProvider, loadProviderConfig } from "./provider.js"` 추가.
- `const adapter = createClaudeCodeAdapter();` (session.ts:30) 제거.
- `spawnAgent` 내부: agent row·project row로 `const cfg = loadProviderConfig(); const provider = resolveProvider(agent, project, cfg);` (spawn 직전, 단 Task 8의 failover override 맵이 이 taskId에 있으면 그 값 최우선) → `const adapter = getBackend(provider);`.
- **모델 매핑 (§4.4)**: `const resolvedModel = agent.model || ROLE_DEFAULT_MODEL[agent.role] || undefined;` 는 Claude 별칭(opus/sonnet)이다. Codex엔 그대로 넘기면 안 됨 →
  ```ts
  const modelForBackend = provider === "codex"
    ? (resolvedModel ? cfg.codexModelMap[resolvedModel] : undefined)   // 매핑 없으면 undefined → codex 기본 모델(-m 생략)
    : resolvedModel;
  const session = adapter.spawn({ ...config, model: modelForBackend, provider });
  ```
- **Codex stdin prepend**: 현재 claude는 `systemPrompt`를 `--append-system-prompt-file`로 넣지만, Codex는 파일 플래그가 없다. `provider === "codex"`면 `enrichedPrompt`(시스템+컨텍스트)를 **유저 프롬프트 앞에 붙여** `send()`로 전달(어댑터가 stdin write). claude 경로는 현행 유지.
- 세션 저장 시 `sessions.provider = provider` 기록 (INSERT/UPDATE 지점).

- [ ] **Step 7: API provider read/write**

`agents.ts`: 에이전트 생성/수정 body에 `provider?: "claude"|"codex"|null` 수용·저장, 응답에 포함. `projects.ts`: 프로젝트 설정에 `default_provider` 동일. (검증: `VALID` 외 값 거부 또는 null 처리)

- [ ] **Step 8: 전체 회귀 + typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: PASS — 기존 claude 경로 무변경(provider 미설정 시 claude), 신규 유닛 그린.

- [ ] **Step 9: 커밋**

```bash
git add server/core/agent/provider.ts server/__tests__/provider-resolution.test.ts server/db/schema.ts server/core/agent/session.ts server/api/routes/agents.ts server/api/routes/projects.ts
git commit -m "feat: provider 해석 + agents/projects/sessions provider 컬럼 + session 배선"
```

---

## Task 6: provider-aware 파서 라우팅

**Files:**
- Modify: `server/core/orchestration/engine.ts`, `delegation.ts`, `evaluator.ts`, `team-designer.ts`, `work-report.ts`, `api/routes/*.ts` (parseStreamJson 직접 호출부)
- Create: `server/core/agent/adapters/parse.ts` — `parseAgentOutput(output, provider)`

**Interfaces:**
- Produces: `parseAgentOutput(rawOutput: string, provider: AgentProvider): ParsedStreamOutput` — provider에 따라 `parseStreamJson`(claude) 또는 `parseCodexJson`(codex).
- Consumes: `parseStreamJson`(claude), `parseCodexJson`(Task 2).

- [ ] **Step 1: 라우터 작성**

`server/core/agent/adapters/parse.ts`:

```ts
import type { AgentProvider } from "./backend.js";
import { parseStreamJson, type ParsedStreamOutput } from "./stream-parser.js";
import { parseCodexJson } from "./codex-stream-parser.js";

export function parseAgentOutput(rawOutput: string, provider: AgentProvider): ParsedStreamOutput {
  return provider === "codex" ? parseCodexJson(rawOutput) : parseStreamJson(rawOutput);
}
```

- [ ] **Step 2: 호출부 교체**

`parseStreamJson(result.stdout)` 직접 호출 15+ 지점(engine.ts:465,765,955,1374,1751; delegation.ts:207; evaluator.ts:140,150; team-designer.ts:247; work-report.ts:159; projects.ts:551,691; goals.ts:487; orchestration.ts:323,472,865,1027)을 `parseAgentOutput(result.stdout, sessionProvider)`로 교체. `sessionProvider`는 해당 세션이 실제 돈 provider(세션 결과/DB `sessions.provider` 또는 spawn 시 알던 값)를 전달. **모르면 "claude"** (하위호환).

> ⚠ 각 호출부에서 provider를 어디서 얻는지 명확히: 대부분 방금 spawn한 세션의 provider를 이미 알고 있다(Task 5에서 resolveProvider 결과). 그 값을 파싱까지 전달.

- [ ] **Step 3: 전체 회귀 + typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: PASS — claude 경로는 `parseAgentOutput(x,"claude") === parseStreamJson(x)`로 동일.

- [ ] **Step 4: 커밋**

```bash
git add server/core/agent/adapters/parse.ts server/core/orchestration/ server/core/quality-gate/ server/core/agent/ server/api/routes/
git commit -m "refactor: parseAgentOutput provider-aware 파서 라우팅"
```

---

## Task 7: failover 결정 로직 (`failover.ts`)

**Files:**
- Create: `server/core/agent/failover.ts`
- Test: `server/__tests__/failover-decision.test.ts`

**Interfaces:**
- Produces:
  - `type FailureClass = "rate_limit" | "session_exhausted" | "env_error" | "task_error"` (errors.ts와 일치)
  - `decideFailover(input: { failure: FailureClass; currentProvider: AgentProvider; triedProviders: AgentProvider[]; codexAvailable: boolean; claudeAvailable: boolean; failoverEnabled: boolean; }): { action: "failover"; toProvider: AgentProvider } | { action: "cooldown" }`
- Consumes: `AgentProvider` (Task 3).

로직: 트리거 클래스(rate_limit/session_exhausted/env_error)이고, failover 켜져 있고, 대체 provider가 가용하고 아직 안 써봤으면 → 대체로 failover. 아니면 cooldown. `task_error`는 항상 cooldown(= failover 안 함, 기존 blocked 경로).

- [ ] **Step 1: 실패 테스트**

`server/__tests__/failover-decision.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decideFailover } from "../core/agent/failover.js";

const base = { triedProviders: ["claude"] as const, codexAvailable: true, claudeAvailable: true, failoverEnabled: true };

describe("decideFailover", () => {
  it("claude rate_limit → codex failover", () => {
    expect(decideFailover({ ...base, failure: "rate_limit", currentProvider: "claude" }))
      .toEqual({ action: "failover", toProvider: "codex" });
  });
  it("session_exhausted·env_error도 failover", () => {
    for (const f of ["session_exhausted", "env_error"] as const)
      expect(decideFailover({ ...base, failure: f, currentProvider: "claude" }).action).toBe("failover");
  });
  it("task_error는 cooldown(코드 버그는 failover 안 함)", () => {
    expect(decideFailover({ ...base, failure: "task_error", currentProvider: "claude" }))
      .toEqual({ action: "cooldown" });
  });
  it("이미 codex 시도했으면 루프 가드 → cooldown", () => {
    expect(decideFailover({ ...base, triedProviders: ["claude", "codex"], failure: "rate_limit", currentProvider: "codex" }))
      .toEqual({ action: "cooldown" });
  });
  it("codex 미가용이면 cooldown", () => {
    expect(decideFailover({ ...base, codexAvailable: false, failure: "rate_limit", currentProvider: "claude" }))
      .toEqual({ action: "cooldown" });
  });
  it("failover 꺼져 있으면 cooldown", () => {
    expect(decideFailover({ ...base, failoverEnabled: false, failure: "rate_limit", currentProvider: "claude" }))
      .toEqual({ action: "cooldown" });
  });
  it("codex가 소진돼도 claude 미시도면 claude로 failover", () => {
    expect(decideFailover({ ...base, triedProviders: ["codex"], failure: "rate_limit", currentProvider: "codex" }))
      .toEqual({ action: "failover", toProvider: "claude" });
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run server/__tests__/failover-decision.test.ts` → FAIL.

- [ ] **Step 3: 구현**

`server/core/agent/failover.ts`:

```ts
import type { AgentProvider } from "./adapters/backend.js";

export type FailureClass = "rate_limit" | "session_exhausted" | "env_error" | "task_error";
const TRIGGERS: FailureClass[] = ["rate_limit", "session_exhausted", "env_error"];

export function decideFailover(input: {
  failure: FailureClass;
  currentProvider: AgentProvider;
  triedProviders: AgentProvider[];
  codexAvailable: boolean;
  claudeAvailable: boolean;
  failoverEnabled: boolean;
}): { action: "failover"; toProvider: AgentProvider } | { action: "cooldown" } {
  if (!input.failoverEnabled || !TRIGGERS.includes(input.failure)) return { action: "cooldown" };
  const alt: AgentProvider = input.currentProvider === "claude" ? "codex" : "claude";
  const altAvailable = alt === "codex" ? input.codexAvailable : input.claudeAvailable;
  if (!altAvailable || input.triedProviders.includes(alt)) return { action: "cooldown" };
  return { action: "failover", toProvider: alt };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run server/__tests__/failover-decision.test.ts` → PASS (7 tests).

- [ ] **Step 5: 커밋**

```bash
git add server/core/agent/failover.ts server/__tests__/failover-decision.test.ts
git commit -m "feat: decideFailover 순수 결정 로직 + 루프 가드"
```

---

## Task 8: scheduler failover 배선 + 어댑터 대기 surface

**Files:**
- Modify: `server/core/orchestration/scheduler.ts` (실패 처리 분기), `server/core/orchestration/engine.ts` (시도 provider 추적), `server/core/agent/adapters/claude-code.ts` (rate-limit 내부 대기를 failover 시 실패로 surface)

**Interfaces:**
- Consumes: `decideFailover` (Task 7), `classifyAgentFailure` (`errors.ts:95`), `loadProviderConfig`·`getBackend().isAvailable()`, `resolveProvider`.

- [ ] **Step 1: 현 실패 처리 경로 확인**

Read `scheduler.ts:1250-1262`(`classifyAgentFailure` → `handleRateLimit`/`handleEnvError`) 와 `engine.ts:1134` 주변. 태스크 시도별 "이미 쓴 provider"를 어디에 저장할지 결정: 인메모리 시도맵(taskId→Set<provider>) 또는 `tasks` 임시 컬럼. **인메모리 맵 권장**(시도 단위 휘발, 재시작 시 리셋 허용).

- [ ] **Step 2: failover 분기 삽입**

`handleRateLimit`/env 처리 진입 지점에서, 쿨다운을 걸기 **전에**:

```ts
const cfg = loadProviderConfig();
const codexAvailable = await getBackend("codex").isAvailable();
const decision = decideFailover({
  failure: failureClass,               // classifyAgentFailure 결과
  currentProvider: sessionProvider,     // 방금 실패한 세션의 provider
  triedProviders: [...triedMap.get(taskId) ?? []],
  codexAvailable, claudeAvailable: true,
  failoverEnabled: cfg.codexFailover,
});
if (decision.action === "failover") {
  triedMap.set(taskId, new Set([...(triedMap.get(taskId) ?? []), sessionProvider, decision.toProvider]));
  // 태스크를 todo로 되돌리되, 다음 spawn이 decision.toProvider를 쓰도록 override 전달
  await redispatchTaskOnProvider(taskId, decision.toProvider);  // 즉시 재큐(쿨다운 없이)
  log.info(`Failover ${sessionProvider}→${decision.toProvider} for task ${taskId}`);
  return;
}
// else: 기존 쿨다운 경로 그대로
```

`redispatchTaskOnProvider`: 태스크 status를 todo로 전이(`transitionTask`)하고, 다음 `spawnAgent`가 provider override를 받도록 인메모리 override 맵(taskId→provider)에 저장. `session.ts`의 provider 해석은 이 override가 있으면 최우선 사용(단, agent.provider pin보다 override 우선 — failover는 일시적 강제).

- [ ] **Step 3: 어댑터 rate-limit 대기 surface**

`claude-code.ts:328-350`의 rate-limit 감지 시 내부 `--rate-limit` 대기/재시도 로직: failover가 켜진 경우(config.codexFailover && codex 가용) **수동 대기 대신 세션을 rate-limit 실패로 종료·emit**해 scheduler가 failover하게 한다. failover 불가 시에만 기존 대기 유지. (config는 `loadProviderConfig()`로 판단)

- [ ] **Step 4: 시도맵·override 배선 테스트 (유닛 가능 범위)**

`redispatchTaskOnProvider` 후 다음 provider 해석이 override를 반환하는지 유닛(인메모리 맵 함수 분리해 테스트). 실 스케줄러 통합은 Step 6 스모크.

- [ ] **Step 5: 전체 회귀 + typecheck**

Run: `npm run typecheck && npx vitest run` → PASS.

- [ ] **Step 6: 커밋**

```bash
git add server/core/orchestration/scheduler.ts server/core/orchestration/engine.ts server/core/agent/adapters/claude-code.ts server/core/agent/session.ts
git commit -m "feat: scheduler failover 배선 — 한도/소진/env 오류 시 대체 백엔드 즉시 재디스패치"
```

---

## Task 9: Codex 에러/한도 분류

**Files:**
- Modify: `server/utils/errors.ts` (`classifyAgentFailure` provider 인지), `server/core/agent/adapters/codex.ts` (rate-limit/실패 신호 감지)
- Test: `server/__tests__/detect-agent-failure.test.ts` (Codex 케이스 추가)

**Interfaces:**
- Consumes: `classifyAgentFailure` (`errors.ts:95`), `AgentError`.

- [ ] **Step 1: Codex 신호 조사(구현 시 실측)**

Codex 한도/소진 신호는 미확정 → 어댑터에서 stderr + JSONL `item.type==="error"`의 message를 검사. rate-limit 후보 문자열(`rate limit`, `429`, `quota`, `usage limit`, `too many requests`)을 감지하면 `rate-limit` 이벤트 emit. **exit≠0 + 위 신호 없음**이면 `task_error`. (비치명 error item은 무시 — Task 2에서 이미 errors에 안 넣음)

- [ ] **Step 2: 테스트 추가**

`detect-agent-failure.test.ts`에 Codex 케이스:

```ts
it("Codex rate-limit stderr → rate_limit 분류", () => {
  const err = new AgentError({ code: "RATE_LIMIT", message: "429 too many requests" });
  expect(classifyAgentFailure(err, { provider: "codex" })).toBe("rate_limit");
});
it("Codex exit≠0 + 신호 없음 → task_error", () => {
  const err = new AgentError({ code: "CLI_EXIT_NONZERO", message: "" });
  expect(classifyAgentFailure(err, { provider: "codex" })).toBe("task_error");
});
```

> ⚠ claude의 `session_exhausted` 휴리스틱(`CLI_EXIT_NONZERO` + 빈 stderr → 세션 소진, `errors.ts:114-118`)은 **claude 전용**. `classifyAgentFailure`에 `provider` 인자를 추가해 codex는 이 휴리스틱을 적용하지 않도록 분기(codex는 빈 stderr exit≠0을 task_error로).

- [ ] **Step 3: 구현 + 테스트 통과**

`classifyAgentFailure(err, opts?: { provider?: AgentProvider })` 시그니처 확장(기본 claude, 하위호환). Run: `npx vitest run server/__tests__/detect-agent-failure.test.ts` → PASS.

- [ ] **Step 4: 커밋**

```bash
git add server/utils/errors.ts server/core/agent/adapters/codex.ts server/__tests__/detect-agent-failure.test.ts
git commit -m "feat: Codex 에러/한도 분류 분기 (claude 세션소진 휴리스틱 격리)"
```

---

## Task 10: 실행 엔진 선택 UI + 전역 토글

**Files:**
- Modify: `dashboard/src/components/AgentDetail.tsx`, `dashboard/src/components/ProjectSettings.tsx`, `dashboard/src/i18n/en.ts`, `dashboard/src/i18n/ko.ts`
- (전역 토글은 config 파일 기반 — UI 노출은 프로젝트 설정에 "Codex failover 사용" 체크박스로)

**Interfaces:**
- Consumes: Task 5의 agents/projects provider API 필드.

- [ ] **Step 1: i18n 라벨 추가**

`ko.ts`/`en.ts`에 (dev 용어 금지, ux-terminology 준수):
```ts
// ko
executionEngine: "실행 엔진", engineAuto: "자동", engineClaude: "Claude", engineCodex: "Codex",
codexFailover: "Codex failover 사용", executionEngineHint: "한도·오류 시 자동 전환",
// en
executionEngine: "Execution engine", engineAuto: "Auto", ...
```

- [ ] **Step 2: AgentDetail 실행 엔진 셀렉트**

에이전트 상세에 `실행 엔진: [자동|Claude|Codex]` 셀렉트. 값 = `agent.provider ?? "auto"`("auto"→null 저장). 변경 시 기존 에이전트 수정 API 사용(provider 필드). `window.confirm/alert/prompt` 금지 — 기존 컴포넌트 패턴 준수(`.claude/rules/dashboard-ui.md`).

- [ ] **Step 3: ProjectSettings 프로젝트 기본 + failover 토글**

프로젝트 설정에 프로젝트 기본 실행 엔진(`default_provider`) 셀렉트 + "Codex failover 사용" 체크박스(config 반영 API 필요 시 `projects.ts` 또는 별도 settings endpoint 사용 — 기존 설정 저장 패턴 따를 것).

- [ ] **Step 4: dashboard typecheck**

Run: `cd dashboard && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add dashboard/src/components/AgentDetail.tsx dashboard/src/components/ProjectSettings.tsx dashboard/src/i18n/en.ts dashboard/src/i18n/ko.ts
git commit -m "feat: 실행 엔진 선택 UI + Codex failover 토글"
```

---

## Task 11: 통합 검증 + 배포

**Files:** (검증 전용, 코드 변경 최소)

- [ ] **Step 1: 전체 검증**

Run:
```bash
npm run typecheck
cd dashboard && npx tsc -b && cd ..
npx vitest run
```
Expected: 전부 PASS (기존 281 + 신규 유닛).

- [ ] **Step 2: 실 failover 관통 (드레인-세이프)**

1. 큐 정지 → `activeTasks=0` drain → `npm run build`(전체) → `scripts/service-macos.sh restart` → 큐 재가동.
2. 한 프로젝트를 `default_provider="codex"`로 두고 사소한 goal 1개 실행 → Codex 세션이 실제로 태스크를 수행하고 `sessions.provider="codex"`로 기록되는지 확인.
3. failover 실측: claude 한도를 유도하기 어려우면, 임시로 claude 어댑터가 rate-limit을 던지도록 강제 트리거(테스트 플래그/env)해 → 같은 태스크가 Codex로 재디스패치되고 완주하는지 확인. 확인 후 트리거 제거.

- [ ] **Step 3: 문서 갱신**

`docs/ROADMAP.md` 현재 상태/Known Gaps에 Codex 백엔드 지원 반영. `CLAUDE.md` 아키텍처 라우팅에 `adapters/backend.ts`·`codex.ts`·provider 개념 한 줄 추가.

- [ ] **Step 4: 커밋**

```bash
git add docs/ROADMAP.md CLAUDE.md
git commit -m "docs: Codex 백엔드 지원 반영 (ROADMAP·아키텍처)"
```

---

## 리스크 / 미확정 (구현 중 확인)

- **Codex rate-limit/소진 신호 포맷** — Task 9 Step 1에서 실측 확정. 한도를 실제로 유발하기 전엔 후보 문자열 매칭으로 best-effort.
- **Codex 샌드박스 쓰기** — 기본 `-s workspace-write`가 goal worktree 쓰기를 허용하는지 Task 4 Step 5 스모크에서 확인. 막히면 config 게이트로 `--dangerously-bypass-approvals-and-sandbox`.
- **비용 귀속** — Codex는 `usage`에 cost 미보고 → `sessions.cost_usd`는 codex 세션에서 null/0, token만 집계.
- **Codex resume** — 1차는 fresh 세션(Claude resume 컨텍스트 미승계). 태스크 프롬프트의 Smart Resume 실패이력으로 보완. Codex→Codex resume(`thread_id`)은 후속.
