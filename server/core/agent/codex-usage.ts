/**
 * Codex(GPT) 구독 사용량 한도 리더.
 *
 * `codex exec --json` stdout 은 rate_limits 를 주지 않지만, Codex CLI 는 모든 세션의
 * rollout 파일(`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)에 `token_count` 이벤트로
 * ChatGPT 사용량 한도를 기록한다 (crewdeck 가 띄운 exec 세션 포함, 실측). 구조:
 *
 *   {"type":"event_msg","payload":{"type":"token_count","rate_limits":{
 *      "primary":  {"used_percent":0.0, "window_minutes":300,  "resets_at":<unix>},   // 5h 롤링
 *      "secondary":{"used_percent":23.0,"window_minutes":10080,"resets_at":<unix>},   // 7d 주간
 *      "plan_type":"pro" }}}
 *
 * 최신 rollout 파일의 마지막 rate_limits 를 읽어 Claude 5h/7d 와 대칭인 형태로 정규화한다.
 * 값은 Codex 세션이 돌 때만 갱신되므로(그 사이엔 stale), 소비자는 updatedAt 으로 신선도를 판단한다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export interface CodexRateLimits {
  primaryPercent: number | null; // 5h 롤링 창 사용률(%)
  secondaryPercent: number | null; // 7d 주간 창 사용률(%)
  primaryResetsAt: number | null; // unix seconds
  secondaryResetsAt: number | null;
  primaryWindowMinutes: number | null;
  secondaryWindowMinutes: number | null;
  planType: string | null;
  updatedAt: string | null; // 값 출처 파일의 mtime (ISO)
}

const SESSIONS_DIR = resolve(homedir(), ".codex", "sessions");

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** 하위 디렉토리명을 최신순(내림차순)으로. 날짜 폴더는 zero-pad 라 lexical=chronological. */
function sortedDirsDesc(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** 최근 rollout 파일 경로를 최신순으로 limit 개까지. */
function recentRolloutFiles(limit: number): string[] {
  const out: string[] = [];
  for (const y of sortedDirsDesc(SESSIONS_DIR)) {
    for (const m of sortedDirsDesc(resolve(SESSIONS_DIR, y))) {
      for (const d of sortedDirsDesc(resolve(SESSIONS_DIR, y, m))) {
        const dayDir = resolve(SESSIONS_DIR, y, m, d);
        let names: string[];
        try {
          names = readdirSync(dayDir)
            .filter((n) => n.endsWith(".jsonl"))
            .sort()
            .reverse();
        } catch {
          continue;
        }
        for (const n of names) {
          out.push(resolve(dayDir, n));
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

/** 파일에서 마지막 rate_limits 이벤트를 뒤에서부터 스캔. 없으면 null. */
function lastRateLimitsInFile(path: string): any | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits":{')) continue;
    try {
      const ev = JSON.parse(line);
      const rl = ev?.payload?.rate_limits;
      if (rl && (rl.primary || rl.secondary)) return rl;
    } catch {
      // 잘린/비JSON 줄은 무시하고 계속
    }
  }
  return null;
}

// 최신 파일(path+mtime)이 안 바뀌면 재파싱 생략. 폴링(10s)마다 디스크 재읽기 방지.
let cache: { key: string; value: CodexRateLimits | null } | null = null;

/** 가장 최근 Codex 세션의 사용량 한도. 데이터가 없으면 null. */
export function readLatestCodexRateLimits(): CodexRateLimits | null {
  const files = recentRolloutFiles(15);
  if (files.length === 0) return null;

  let newestMtime = 0;
  try {
    newestMtime = statSync(files[0]).mtimeMs;
  } catch {
    /* ignore */
  }
  const key = `${files[0]}:${newestMtime}`;
  if (cache && cache.key === key) return cache.value;

  let value: CodexRateLimits | null = null;
  for (const path of files) {
    const rl = lastRateLimitsInFile(path);
    if (!rl) continue; // rate_limits 없는 세션은 건너뛰고 더 과거로
    let mtime = newestMtime;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      /* ignore */
    }
    value = {
      primaryPercent: num(rl.primary?.used_percent),
      secondaryPercent: num(rl.secondary?.used_percent),
      primaryResetsAt: num(rl.primary?.resets_at),
      secondaryResetsAt: num(rl.secondary?.resets_at),
      primaryWindowMinutes: num(rl.primary?.window_minutes),
      secondaryWindowMinutes: num(rl.secondary?.window_minutes),
      planType: typeof rl.plan_type === "string" ? rl.plan_type : null,
      updatedAt: new Date(mtime).toISOString(),
    };
    break;
  }

  cache = { key, value };
  return value;
}
