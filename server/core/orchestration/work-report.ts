import { existsSync, readdirSync, mkdirSync, copyFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { parseAgentOutput } from "../agent/adapters/stream-parser.js";
import type { SessionManager } from "../agent/session.js";

export interface ScreenshotRef { file: string; label: string; taskId?: string | null; }
export interface WorkReport {
  before: string | null;
  changed: string | null;
  after: string | null;
  notes: string | null;
  summaryStatus: "pending" | "ready" | "failed";
  screenshots: ScreenshotRef[];
}
export interface WorkNarrative { before: string; changed: string; after: string; notes: string; }

const CAPTURE_DIRS = [".playwright-mcp", ".cc-shots"];
const IMAGE_EXT = /\.(png|jpe?g)$/i;
const MAX_SHOTS = 12;
const MAX_SHOT_BYTES = 5_000_000; // 5MB/장 상한
const MAX_TASK_SUMMARY = 300;
const MAX_FILES_IN_PROMPT = 40;

/** sqlite가 실제 연 DB 경로 기준 canonical dataDir → artifacts/goals/<id>. */
export function artifactsDirForGoal(db: Database.Database, goalId: string): string {
  const dataDir = dirname(db.name);
  return join(dataDir, "artifacts", "goals", goalId);
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
  return { before: null, changed: null, after: null, notes: null, summaryStatus: "pending", screenshots };
}

/** LLM 응답 텍스트에서 {before,changed,after,notes} JSON을 파싱. 실패 시 null. */
export function parseNarrativeJson(text: string): WorkNarrative | null {
  if (!text) return null;
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (typeof o.before !== "string" || typeof o.changed !== "string" || typeof o.after !== "string") return null;
    return { before: o.before, changed: o.changed, after: o.after, notes: typeof o.notes === "string" ? o.notes : "" };
  } catch { return null; }
}

function buildNarrativePrompt(
  goal: { title?: string | null; description?: string | null },
  tasks: { title: string; result_summary: string | null }[],
  filesChanged: string[],
): string {
  const taskLines = tasks.map((t) => `- ${t.title}: ${(t.result_summary ?? "").slice(0, MAX_TASK_SUMMARY)}`).join("\n");
  const files = filesChanged.slice(0, MAX_FILES_IN_PROMPT).join("\n");
  return `당신은 방금 완료된 작업 묶음을 **비개발자도 5초에 이해**하도록 요약합니다.
아래 정보를 바탕으로 **오직 \`\`\`json 블록 하나만** 출력하세요. 코드 라인·파일 경로 나열 금지, 기능·화면·동작 단위로.

## 목표
${goal.title ?? ""}
${goal.description ?? ""}

## 완료된 작업
${taskLines || "(요약 없음)"}

## 변경된 파일
${files || "(없음)"}

형식:
\`\`\`json
{"before":"작업 전 상황/문제 (1-2문장)","changed":"무엇을 했는지 (2-4문장)","after":"지금 어떻게 달라졌는지·사용자가 보게 될 차이 (1-2문장)","notes":"주의점·미해결 (없으면 빈 문자열)"}
\`\`\``;
}

/** 요약 전용 시스템 에이전트를 재사용/생성하고 세션에서 1콜. 실패 시 null. */
export async function synthesizeNarrative(
  db: Database.Database,
  sessionManager: SessionManager,
  goal: { id: string; project_id: string; title?: string | null; description?: string | null },
  tasks: { title: string; result_summary: string | null }[],
  filesChanged: string[],
): Promise<WorkNarrative | null> {
  db.prepare(
    "INSERT OR IGNORE INTO agents (project_id, name, role, system_prompt) VALUES (?, '[Crewdeck] Summarizer', 'reviewer', ?)",
  ).run(goal.project_id, "You write concise, human-friendly before/after work summaries in Korean. Output only the requested JSON.");
  const agent = db.prepare(
    "SELECT id FROM agents WHERE project_id = ? AND name = '[Crewdeck] Summarizer' LIMIT 1",
  ).get(goal.project_id) as { id: string } | undefined;
  if (!agent) return null;

  // 프롬프트에 필요한 맥락이 모두 담겨 있으므로 goal worktree가 아닌 격리 temp dir에서 스폰한다.
  // (승인 시 worktree가 --force 제거/merge되는 창과, 도구 사용 가능한 서브프로세스가 겹치는 위험을 제거)
  const sessionKey = `summary-${goal.id}`;
  const cwd = mkdtempSync(join(tmpdir(), "crewdeck-summary-"));
  try {
    const session = sessionManager.spawnAgent(agent.id, cwd, sessionKey);
    const result = await session.send(buildNarrativePrompt(goal, tasks, filesChanged));
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
): Promise<void> {
  let narrative: WorkNarrative | null = null;
  try {
    narrative = await synthesizeNarrative(db, sessionManager, goal, tasks, filesChanged);
  } catch { narrative = null; }

  const report: WorkReport = narrative
    ? { ...narrative, summaryStatus: "ready", screenshots }
    : { before: null, changed: null, after: null, notes: null, summaryStatus: "failed", screenshots };

  try {
    db.prepare("UPDATE goals SET work_report = ? WHERE id = ?").run(JSON.stringify(report), goal.id);
  } catch { /* best effort */ }
  broadcast("goal:work_report", { goalId: goal.id, workReport: report });
}
