import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// statSync 만 가로채 "쓰기 직전에 남이 파일을 건드린" 상황을 만든다.
const hoisted = vi.hoisted(() => ({ concurrentWrites: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  let bump = 0;
  return {
    ...actual,
    statSync: (path: string, ...rest: unknown[]) => {
      const stats = actual.statSync(path, ...(rest as []));
      if (!hoisted.concurrentWrites) return stats;
      // 매 호출마다 다른 mtime → 우리 코드가 항상 "남이 썼다"고 판단해야 한다.
      return { ...stats, mtimeMs: stats.mtimeMs + ++bump };
    },
  };
});

const { grantClaudeTrust } = await import("../core/agent/claude-trust.js");

const dirs: string[] = [];
let originalHome: string | undefined;
let home: string;

function configFile(): string {
  return join(home, ".claude.json");
}

beforeEach(() => {
  hoisted.concurrentWrites = false;
  originalHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "crewdeck-trust-"));
  dirs.push(home);
  process.env.HOME = home;
  delete process.env.CREWDECK_SKIP_CLAUDE_TRUST; // setup.ts 의 전역 보호를 이 파일에서만 해제
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  process.env.CREWDECK_SKIP_CLAUDE_TRUST = "1";
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("claude trust registration", () => {
  it("registers the worktree and leaves the rest of the config intact", () => {
    writeFileSync(configFile(), JSON.stringify({
      oauthAccount: { emailAddress: "someone@example.com" },
      projects: { "/existing": { hasTrustDialogAccepted: false } },
    }));

    expect(grantClaudeTrust("/tmp/proj/.crewdeck-worktrees/goal-a")).toBe(true);

    const config = JSON.parse(readFileSync(configFile(), "utf8"));
    expect(config.projects["/tmp/proj/.crewdeck-worktrees/goal-a"].hasTrustDialogAccepted).toBe(true);
    expect(config.oauthAccount).toEqual({ emailAddress: "someone@example.com" });
    expect(config.projects["/existing"]).toEqual({ hasTrustDialogAccepted: false });
  });

  it("is idempotent — an already trusted path is not rewritten", () => {
    writeFileSync(configFile(), JSON.stringify({ projects: {} }));
    expect(grantClaudeTrust("/tmp/proj/.crewdeck-worktrees/goal-a")).toBe(true);
    expect(grantClaudeTrust("/tmp/proj/.crewdeck-worktrees/goal-a")).toBe(false);
  });

  it("never overwrites a config that another process is writing concurrently", () => {
    // claude 는 자기 세션 중에도 ~/.claude.json 을 쓴다. 우리가 읽고-고쳐-쓰는 사이에
    // 그 쓰기가 끼어들면 통째로 덮여 사용자 데이터가 사라진다(lost update).
    const original = JSON.stringify({ projects: { "/existing": { hasTrustDialogAccepted: true } } });
    writeFileSync(configFile(), original);
    hoisted.concurrentWrites = true;

    expect(grantClaudeTrust("/tmp/proj/.crewdeck-worktrees/goal-a")).toBe(false);
    // 등록을 포기할지언정 남의 변경을 덮지 않는다 — 최악의 경우 사람이 다이얼로그를 한 번 누른다.
    expect(readFileSync(configFile(), "utf8")).toBe(original);
  });

  it("leaves a corrupted config untouched instead of replacing it", () => {
    writeFileSync(configFile(), "{ this is not json");
    expect(grantClaudeTrust("/tmp/proj/.crewdeck-worktrees/goal-a")).toBe(false);
    expect(readFileSync(configFile(), "utf8")).toBe("{ this is not json");
  });

  it("does nothing when the opt-out is set", () => {
    process.env.CREWDECK_SKIP_CLAUDE_TRUST = "1";
    writeFileSync(configFile(), JSON.stringify({ projects: {} }));
    expect(grantClaudeTrust("/tmp/proj/.crewdeck-worktrees/goal-a")).toBe(false);
    expect(JSON.parse(readFileSync(configFile(), "utf8")).projects).toEqual({});
  });

  it("does nothing when there is no claude config at all", () => {
    expect(grantClaudeTrust("/tmp/proj/.crewdeck-worktrees/goal-a")).toBe(false);
  });
});
