import { existsSync, readdirSync, mkdirSync, copyFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { parseAgentOutput } from "../agent/adapters/stream-parser.js";
import type { SessionManager } from "../agent/session.js";

export interface ScreenshotRef { file: string; label: string; taskId?: string | null; }
/** 사용자가 실제로 다르게 경험하게 되는 지점 — 화면·엔드포인트·명령어 단위. */
export interface ImpactSurface { name: string; change: string; }
/** visible=false 는 "내부 변경이라 체감 차이 없음"을 **명시적으로** 선언한 것 (미생성과 구별된다). */
export interface UserImpact { visible: boolean; surfaces: ImpactSurface[]; }
export interface WorkReport {
  before: string | null;
  changed: string | null;
  after: string | null;
  notes: string | null;
  commitType: string | null; // conventional prefix (feat/fix/…) — squash 커밋명에 사용
  userImpact: UserImpact | null;
  outOfScope: string | null; // goal이 요청하지 않았는데 diff에 포함된 변경 (없으면 "")
  summaryStatus: "pending" | "ready" | "failed";
  screenshots: ScreenshotRef[];
}
export interface WorkNarrative {
  before: string; changed: string; after: string; notes: string; commitType: string;
  /** null = 생성/파싱 실패(블록 생략). {visible:false} = "체감 차이 없음"을 선언한 것 — 둘은 다르다. */
  userImpact: UserImpact | null;
  outOfScope: string;
}

/** AGENTS.md Git Convention 과 일치하는 허용 커밋 타입. */
export const COMMIT_TYPES = ["feat", "fix", "update", "docs", "refactor", "chore", "test"] as const;

const CAPTURE_DIRS = [".playwright-mcp", ".cc-shots"];
const IMAGE_EXT = /\.(png|jpe?g)$/i;
const MAX_SHOTS = 12;
const MAX_SHOT_BYTES = 5_000_000; // 5MB/장 상한
const MAX_TASK_SUMMARY = 300;
const MAX_FILES_IN_PROMPT = 40;
const MAX_SURFACES = 8;

/**
 * 프롬프트에 실을 diff 본문 예산. 사람이 보는 diff 뷰어의 500KB(`goals.ts` /diff)와 **별개**로
 * 훨씬 작게 잡는다 — 값싼 모델 1콜에 통째로 밀어넣을 필요가 없고, --stat 이 전체 형상을
 * 이미 전달하기 때문. 넘치면 본문만 자르고 truncated 로 알린다(§truncate 정직성).
 */
const MAX_DIFF_BODY = 60_000;
/**
 * 요약 판단에 기여하지 않으면서 예산만 잡아먹는 생성물. 여기서 걸러야 진짜 변경이 예산 안에 들어온다.
 * evaluator 의 TOOL_STATE_PATHS 와 겹치지만 목적이 달라(그쪽은 평가 방해 방지) 공유하지 않는다.
 */
const DIFF_NOISE = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock|Cargo\.lock|go\.sum|composer\.lock)$/,
  /(^|\/)(\.playwright-mcp|\.cc-shots|\.omc|\.crewdeck-worktrees|node_modules|dist|build|coverage|test-results)\//,
  /\.(min\.js|min\.css|map|snap)$/,
];

/** sqlite가 실제 연 DB 경로 기준 canonical dataDir → artifacts/goals/<id>. */
export function artifactsDirForGoal(db: Database.Database, goalId: string): string {
  const dataDir = dirname(db.name);
  return join(dataDir, "artifacts", "goals", goalId);
}

/**
 * goal 완료 → base 반영 커밋(= pr 모드 PR 본문) 메시지. 이미 DB에 쌓인 근거
 * (work_report 서사·verifications 최종 verdict·스크린샷 수)를 What/Why/검증 구조로 렌더한다.
 * squash로 개별 커밋이 사라져도 이 본문은 base 커밋·PR 본문에 남아 "무엇을 왜 했는지"를
 * GitHub만 봐도 추적·감사할 수 있게 하고, trailer(Refs/Assisted-by)는 squash 후에도
 * `git log --grep` 으로 질의 가능한 기계 파싱 키다. 서사가 없거나 미완이면(요약 pending/failed)
 * 제목+검증+작업항목으로 안전 폴백한다 — 근거가 있을 때만 섹션을 싣는다(환각 방지).
 *
 * engine.ts(squash_ready 프리뷰)와 goals.ts(squash-preview/approve)가 공유해 드리프트를 없앤다.
 * squash_ready 시점엔 서사가 pending이라 폴백 형태로 나오고, 서사가 채워진 뒤(reload/approve)
 * 같은 함수가 What/Why까지 렌더한다 — 실제 커밋되는 본문은 approve 시점에 fresh 생성된다.
 */
export function buildGoalCommitMessage(
  db: Database.Database,
  goal: { id: string; title?: string | null; description?: string | null; work_report?: string | null },
): string {
  const doneTasks = db.prepare(
    "SELECT title FROM tasks WHERE goal_id = ? AND status = 'done' AND parent_task_id IS NULL ORDER BY sort_order ASC",
  ).all(goal.id) as { title: string }[];
  const taskBullets = doneTasks.map((t) => `- ${t.title}`).join("\n");

  const wr = (() => { try { return goal.work_report ? JSON.parse(goal.work_report) : null; } catch { return null; } })();
  const commitPrefix = typeof wr?.commitType === "string" && (COMMIT_TYPES as readonly string[]).includes(wr.commitType) ? `${wr.commitType}: ` : "";
  const title = `${commitPrefix}${goal.title || goal.description}`;

  const sections: string[] = [];
  // What / Why / 참고 — 서사가 실제로 준비된 경우에만(요약이 실패/미완이면 생략).
  if (wr && wr.summaryStatus === "ready") {
    if (typeof wr.changed === "string" && wr.changed.trim()) sections.push(`## 무엇을\n${wr.changed.trim()}`);
    if (typeof wr.before === "string" && wr.before.trim()) sections.push(`## 왜\n${wr.before.trim()}`);
    if (typeof wr.notes === "string" && wr.notes.trim()) sections.push(`## 참고\n${wr.notes.trim()}`);
  }

  // 검증 — 에이전트 요약이 아니라 verifications 테이블의 실제 verdict를 집계한 사실 근거.
  // 태스크별 "최종" verdict만 센다(과거 fix 라운드의 fail을 누적하면 완료된 goal에도 실패가
  // 찍혀 오도된다). 통과→조건부→실패 순 고정 정렬.
  const verdicts = db.prepare(
    `SELECT verdict, COUNT(*) AS n FROM (
       SELECT v.verdict AS verdict,
              ROW_NUMBER() OVER (PARTITION BY v.task_id ORDER BY v.created_at DESC, v.rowid DESC) AS rn
       FROM verifications v JOIN tasks t ON t.id = v.task_id
       WHERE t.goal_id = ?
     ) WHERE rn = 1 GROUP BY verdict`,
  ).all(goal.id) as { verdict: string; n: number }[];
  const verifyLines: string[] = [];
  if (verdicts.length) {
    const label: Record<string, string> = { pass: "통과", conditional: "조건부", fail: "실패" };
    const byV = Object.fromEntries(verdicts.map((v) => [v.verdict, v.n]));
    const parts = ["pass", "conditional", "fail"].filter((k) => byV[k]).map((k) => `${label[k]} ${byV[k]}`);
    if (parts.length) verifyLines.push(`- Quality Gate: ${parts.join(" · ")}`);
  }
  const shotCount = Array.isArray(wr?.screenshots) ? wr.screenshots.length : 0;
  if (shotCount > 0) verifyLines.push(`- 스크린샷 ${shotCount}장 (대시보드 goal 실행 리포트)`);
  if (verifyLines.length) sections.push(`## 검증\n${verifyLines.join("\n")}`);

  if (taskBullets) sections.push(`작업 항목:\n${taskBullets}`);

  const trailers = [`Refs: goal-${goal.id}`, "Assisted-by: Crewdeck"];
  return [title, sections.join("\n\n"), trailers.join("\n")].filter(Boolean).join("\n\n");
}

/** 서빙/파일명 안전화: 영숫자·._- 만 허용. */
export function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

function walkImages(dir: string): string[] {
  const out: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) out.push(...walkImages(p));
      else if (IMAGE_EXT.test(name)) out.push(p);
    }
  } catch { /* ignore */ }
  return out;
}

/** worktree의 알려진 캡쳐 디렉토리에서 이미지를 모아 destDir로 복사. best-effort, throw 안 함. */
export function collectScreenshots(worktreePath: string, destDir: string): ScreenshotRef[] {
  const refs: ScreenshotRef[] = [];
  const used = new Set<string>();
  try {
    for (const dir of CAPTURE_DIRS) {
      const abs = join(worktreePath, dir);
      if (!existsSync(abs)) continue;
      for (const src of walkImages(abs)) {
        if (refs.length >= MAX_SHOTS) break;
        try {
          if (statSync(src).size > MAX_SHOT_BYTES) continue;
          // 서브경로를 파일명에 반영 + 충돌 시 인덱스 suffix — 중첩 동일 basename 덮어쓰기/중복 key 방지
          const rel = relative(abs, src).replace(/[/\\]/g, "-");
          let safe = sanitizeName(`${dir.replace(/^\./, "")}-${rel}`);
          if (used.has(safe)) {
            const dot = safe.lastIndexOf(".");
            const stem = dot > 0 ? safe.slice(0, dot) : safe;
            const ext = dot > 0 ? safe.slice(dot) : "";
            safe = `${stem}-${refs.length}${ext}`;
          }
          used.add(safe);
          mkdirSync(destDir, { recursive: true });
          copyFileSync(src, join(destDir, safe));
          refs.push({ file: safe, label: basename(src), taskId: null });
        } catch { /* skip one file */ }
      }
    }
  } catch { /* best effort */ }
  return refs;
}

/** ③ 화면 증거 존재 여부 — 캡처 디렉토리(.cc-shots/.playwright-mcp)에 이미지가 하나라도 있는가. */
export function hasScreenshotEvidence(worktreePath: string): boolean {
  try {
    for (const dir of CAPTURE_DIRS) {
      const abs = join(worktreePath, dir);
      if (existsSync(abs) && walkImages(abs).length > 0) return true;
    }
  } catch { /* best effort */ }
  return false;
}

/** ④ artifacts 수명 — goal 삭제 시 수확된 산출물 디렉토리 제거. */
export function removeGoalArtifacts(db: Database.Database, goalId: string): void {
  try {
    rmSync(artifactsDirForGoal(db, goalId), { recursive: true, force: true });
  } catch { /* best effort — 파일 정리 실패가 goal 삭제를 막으면 안 된다 */ }
}

/**
 * ④ artifacts 수명 — 시작 시 스윕. 두 부류만 지운다:
 * (a) 고아 — goal row 가 이미 삭제된 디렉토리 (과거 삭제 경로에 정리 코드가 없던 잔재)
 * (b) 노화 — 디렉토리 mtime 이 maxAgeDays 를 넘긴 것 (마지막 증거 수확 시점 기준.
 *     스키마 의존 없음 — goal 이 되살아나면 다음 검증에서 증거가 재수확된다)
 * 반환값 = 삭제한 디렉토리 수.
 */
export function sweepExpiredGoalArtifacts(db: Database.Database, maxAgeDays = 30): number {
  const root = join(dirname(db.name), "artifacts", "goals");
  if (!existsSync(root)) return 0;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const goalExists = db.prepare("SELECT 1 FROM goals WHERE id = ?").get(entry);
      const expired = !goalExists || statSync(dir).mtimeMs < cutoff;
      if (expired) {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch { /* skip one */ }
  }
  return removed;
}

/** 에이전트 최종 텍스트의 마무리 꼬리를 문단 경계로 잘라 담는다 (LLM 콜 없음). */
export function extractWrapUp(text: string, maxLen: number): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  if (t.length <= maxLen) return t;
  const tail = t.slice(-maxLen);
  const nl = tail.indexOf("\n");
  return (nl > 0 && nl < maxLen / 2 ? tail.slice(nl + 1) : tail).trim();
}

export function initialWorkReport(screenshots: ScreenshotRef[]): WorkReport {
  return {
    before: null, changed: null, after: null, notes: null, commitType: null,
    userImpact: null, outOfScope: null, summaryStatus: "pending", screenshots,
  };
}

/**
 * git diff 원문을 프롬프트용으로 가공한다 — 순수 함수(git 호출은 호출자 몫이라 테스트 가능).
 * 생성물 블록을 버려 진짜 변경이 예산 안에 들어오게 하고, 본문이 잘렸으면 truncated 로 알린다.
 * 이 플래그가 프롬프트까지 전달돼야 요약이 "전부 봤다"고 착각한 채 "범위 밖 변경 없음"을
 * 단언하지 않는다 — 없다고 말해서 안심시키는 것이 이 기능의 최악 실패 모드다.
 */
export interface DiffDigest { stat: string; body: string; truncated: boolean; dropped: number }

export function buildDiffDigest(statText: string, bodyText: string): DiffDigest {
  const stat = (statText ?? "").trim();
  // 첫 조각은 최초 "diff --git" 이전 부분(보통 빈 문자열)이라 버린다.
  const parts = (bodyText ?? "").split(/^diff --git /m).slice(1);
  let body = "";
  let truncated = false;
  let dropped = 0;
  for (const part of parts) {
    const path = part.match(/^a\/(\S+)/)?.[1] ?? "";
    if (path && DIFF_NOISE.some((re) => re.test(path))) { dropped++; continue; }
    const block = `diff --git ${part}`;
    if (body.length + block.length > MAX_DIFF_BODY) { truncated = true; break; }
    body += block;
  }
  return { stat, body: body.trim(), truncated, dropped };
}

/**
 * 확장 필드(userImpact/outOfScope)는 **관대하게** 파싱한다 — 모양이 틀려도 해당 블록만
 * 비우고 기존 서사는 살린다. 스키마 확장이 이미 동작하던 요약을 깨뜨리면 안 된다.
 */
function parseUserImpact(v: unknown): UserImpact | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { visible?: unknown; surfaces?: unknown };
  const surfaces: ImpactSurface[] = Array.isArray(o.surfaces)
    ? o.surfaces
        .filter((s): s is { name: unknown; change: unknown } => !!s && typeof s === "object")
        .map((s) => ({ name: String(s.name ?? "").trim(), change: String(s.change ?? "").trim() }))
        .filter((s) => s.name || s.change)
        .slice(0, MAX_SURFACES)
    : [];
  // visible 이 boolean 이 아니면 surfaces 유무로 추론한다(형식 흔들림 흡수).
  const visible = typeof o.visible === "boolean" ? o.visible : surfaces.length > 0;
  // "보인다"는데 근거가 하나도 없으면 선언으로 인정하지 않는다.
  if (visible && surfaces.length === 0) return null;
  return { visible, surfaces };
}

/** LLM 응답 텍스트에서 {before,changed,after,notes,…} JSON을 파싱. 실패 시 null. */
export function parseNarrativeJson(text: string): WorkNarrative | null {
  if (!text) return null;
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (typeof o.before !== "string" || typeof o.changed !== "string" || typeof o.after !== "string") return null;
    const commitType = typeof o.commitType === "string" && (COMMIT_TYPES as readonly string[]).includes(o.commitType)
      ? o.commitType : "feat"; // 못 뽑거나 유효하지 않으면 기본 feat
    return {
      before: o.before,
      changed: o.changed,
      after: o.after,
      notes: typeof o.notes === "string" ? o.notes : "",
      commitType,
      userImpact: parseUserImpact(o.userImpact),
      outOfScope: typeof o.outOfScope === "string" ? o.outOfScope.trim() : "",
    };
  } catch { return null; }
}

export function buildNarrativePrompt(
  goal: { title?: string | null; description?: string | null },
  tasks: { title: string; result_summary: string | null }[],
  filesChanged: string[],
  diff?: DiffDigest | null,
): string {
  const taskLines = tasks.map((t) => `- ${t.title}: ${(t.result_summary ?? "").slice(0, MAX_TASK_SUMMARY)}`).join("\n");
  const files = filesChanged.slice(0, MAX_FILES_IN_PROMPT).join("\n");

  // diff 절 — 있을 때만. 태스크 요약은 "에이전트의 주장"이고 이쪽이 "실제 산출물"이라,
  // 둘이 어긋날 때 무엇을 믿어야 하는지 프롬프트가 명시해야 한다.
  const diffSection = diff && (diff.stat || diff.body)
    ? `
## 실제 코드 변경 (git diff — 사실의 근거)
아래는 이 작업이 실제로 만든 변경입니다. 위 "완료된 작업"은 에이전트의 자기 보고라
과장·누락이 있을 수 있습니다. **둘이 어긋나면 이 diff를 믿으세요.**

### 변경 규모
${diff.stat || "(없음)"}
${diff.body ? `\n### 변경 내용\n\`\`\`diff\n${diff.body}\n\`\`\`` : ""}
${diff.dropped > 0 ? `\n(lock 파일·빌드 산출물 등 생성물 ${diff.dropped}개 블록은 제외했습니다.)` : ""}
${diff.truncated ? `\n⚠ **본문이 길어 일부만 실렸습니다.** 위 "변경 규모"에는 전체가 나오지만 내용을 다 보지는 못했습니다.
따라서 \`outOfScope\`를 **단정하지 마세요** — 확인한 범위에서 발견한 것만 적고, 확인하지 못한 부분이
있음을 함께 밝히세요. 못 본 것을 "없음"이라고 답하는 것이 가장 나쁜 답입니다.` : ""}
`
    : "";

  return `당신은 방금 완료된 작업 묶음을 **비개발자도 5초에 이해**하도록 요약합니다.
아래 정보를 바탕으로 **오직 \`\`\`json 블록 하나만** 출력하세요. 코드 라인 나열 금지, 기능·화면·동작 단위로.

## 목표 (이 작업이 요청받은 범위)
${goal.title ?? ""}
${goal.description ?? ""}

## 완료된 작업 (에이전트 자기 보고)
${taskLines || "(요약 없음)"}

## 변경된 파일
${files || "(없음)"}
${diffSection}
작성 지침:
- \`userImpact\` — 이 변경으로 **누가 무엇을 다르게 경험하는지**. 화면이 바뀌면 화면 이름, API·CLI가
  바뀌면 엔드포인트·명령어 이름을 \`name\`에 씁니다. 내부 리팩터·테스트·문서처럼 사용자 체감이
  없으면 \`{"visible":false,"surfaces":[]}\`로 **없음을 분명히 선언**하세요(빈칸으로 두지 마세요).
- \`outOfScope\` — 위 "## 목표"가 요청하지 않았는데 diff에 들어온 변경. 자동 생성물 재생성, 관련
  없는 파일 수정, 곁다리 리팩터 등입니다. 있으면 **관련 파일 경로를 문장 안에 포함해** 서술하세요.
  정말 없으면 빈 문자열로 두세요. 억지로 만들어내지 마세요.

형식:
\`\`\`json
{"commitType":"이 작업 묶음의 성격 한 단어 — feat(새 기능)·fix(버그 수정)·update(기능 개선)·docs(문서)·refactor(리팩터)·chore(설정/기타)·test(테스트) 중 하나","before":"작업 전 상황/문제 (1-2문장)","changed":"무엇을 했는지 (2-4문장)","after":"지금 어떻게 달라졌는지 (1문장)","userImpact":{"visible":true,"surfaces":[{"name":"화면·엔드포인트·명령어 이름","change":"무엇이 어떻게 달라지나 (1-2문장)"}]},"outOfScope":"요청 범위 밖 변경 (없으면 빈 문자열)","notes":"주의점·미해결 (없으면 빈 문자열)"}
\`\`\``;
}

/** 요약 전용 시스템 에이전트를 재사용/생성하고 세션에서 1콜. 실패 시 null. */
export async function synthesizeNarrative(
  db: Database.Database,
  sessionManager: SessionManager,
  goal: { id: string; project_id: string; title?: string | null; description?: string | null },
  tasks: { title: string; result_summary: string | null }[],
  filesChanged: string[],
  diff?: DiffDigest | null,
): Promise<WorkNarrative | null> {
  db.prepare(
    "INSERT OR IGNORE INTO agents (project_id, name, role, system_prompt) VALUES (?, '[Crewdeck] Summarizer', 'reviewer', ?)",
  ).run(goal.project_id, "You write concise, human-friendly before/after work summaries in Korean. Output only the requested JSON.");
  const agent = db.prepare(
    "SELECT id FROM agents WHERE project_id = ? AND name = '[Crewdeck] Summarizer' LIMIT 1",
  ).get(goal.project_id) as { id: string } | undefined;
  if (!agent) return null;

  // 프롬프트에 필요한 맥락(diff 포함)이 모두 담겨 있으므로 goal worktree가 아닌 격리 temp dir에서
  // 스폰한다. (승인 시 worktree가 --force 제거/merge되는 창과, 도구 사용 가능한 서브프로세스가
  // 겹치는 위험을 제거) — diff는 호출자가 미리 읽어 넘기므로 이 세션은 파일시스템을 보지 않는다.
  const sessionKey = `summary-${goal.id}`;
  const cwd = mkdtempSync(join(tmpdir(), "crewdeck-summary-"));
  try {
    const session = sessionManager.spawnAgent(agent.id, cwd, sessionKey);
    const result = await session.send(buildNarrativePrompt(goal, tasks, filesChanged, diff));
    const parsed = parseAgentOutput(result.stdout, result.provider);
    return parseNarrativeJson(parsed.text ?? "");
  } catch {
    return null;
  } finally {
    try { sessionManager.killSession(sessionKey); } catch { /* ignore */ }
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 비동기 요약 파이프라인: 서사 생성 → work_report 병합·persist → goal:work_report broadcast. throw 안 함. */
export async function generateGoalWorkReport(
  db: Database.Database,
  broadcast: (event: string, data: unknown) => void,
  sessionManager: SessionManager,
  goal: { id: string; project_id: string; title?: string | null; description?: string | null },
  tasks: { title: string; result_summary: string | null }[],
  filesChanged: string[],
  screenshots: ScreenshotRef[],
  diff?: DiffDigest | null,
): Promise<void> {
  let narrative: WorkNarrative | null = null;
  try {
    narrative = await synthesizeNarrative(db, sessionManager, goal, tasks, filesChanged, diff);
  } catch { narrative = null; }

  const report: WorkReport = narrative
    ? { ...narrative, summaryStatus: "ready", screenshots }
    : {
        before: null, changed: null, after: null, notes: null, commitType: null,
        userImpact: null, outOfScope: null, summaryStatus: "failed", screenshots,
      };

  try {
    db.prepare("UPDATE goals SET work_report = ? WHERE id = ?").run(JSON.stringify(report), goal.id);
  } catch { /* best effort */ }
  broadcast("goal:work_report", { goalId: goal.id, workReport: report });
}
