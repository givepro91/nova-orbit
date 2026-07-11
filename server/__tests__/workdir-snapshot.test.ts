import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { snapshotWorkdir, restoreWorkdirSnapshot } from "../core/project/worktree.js";

/**
 * 웹 세션 워크스페이스 체크포인트(Phase 4b) — 비파괴 스냅샷/복원 검증.
 *
 * 핵심 안전 계약(사용자 요구 = 실제 레포에서 미커밋 작업을 덮지 않을 것):
 * 1. snapshotWorkdir는 작업 트리를 전혀 건드리지 않는다(캡처 후에도 dirty 상태 그대로).
 * 2. restoreWorkdirSnapshot은 편집을 되돌리되 신규 파일은 삭제하지 않는다(파일을 지우지 않음).
 * 3. 스냅샷 시점의 미커밋(untracked 포함) 작업도 복원 대상에 포함된다.
 */
function git(repo: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf-8", stdio: "pipe" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

describe("snapshotWorkdir / restoreWorkdirSnapshot (Phase 4b 체크포인트)", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "crewdeck-snap-test-"));
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "app.ts"), "export const v = 1;\n");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("스냅샷은 비파괴 — 캡처 후에도 작업 트리가 그대로다(미커밋 편집·untracked 보존)", () => {
    // 사용자의 미커밋 작업(기존 파일 편집 + untracked 신규 파일)
    writeFileSync(join(repo, "app.ts"), "export const v = 2; // user edit\n");
    writeFileSync(join(repo, "user-note.txt"), "user work in progress\n");

    const snap = snapshotWorkdir(repo);
    expect(snap).not.toBeNull();
    expect(snap!.commit).toMatch(/^[0-9a-f]{40}$/);

    // 캡처 후에도 작업 트리는 손대지 않았어야 한다 — dirty 그대로.
    expect(readFileSync(join(repo, "app.ts"), "utf-8")).toBe("export const v = 2; // user edit\n");
    expect(existsSync(join(repo, "user-note.txt"))).toBe(true);
    // stash 스택도 비어 있어야 한다(git stash 를 쓰지 않으므로).
    expect(git(repo, "stash", "list")).toBe("");
  });

  it("복원은 편집을 되돌리되 신규 파일은 삭제하지 않는다(안전 우선)", () => {
    // 스냅샷 시점: app.ts는 원본, 세션 미개입.
    const snap = snapshotWorkdir(repo);
    expect(snap).not.toBeNull();

    // 에이전트가 턴 중 기존 파일을 망치고 새 파일을 만든다.
    writeFileSync(join(repo, "app.ts"), "export const v = 999; // broken by agent\n");
    writeFileSync(join(repo, "agent-new.ts"), "// created by agent\n");

    const ok = restoreWorkdirSnapshot(repo, snap!.commit);
    expect(ok).toBe(true);

    // 편집은 스냅샷 시점으로 되돌아온다.
    expect(readFileSync(join(repo, "app.ts"), "utf-8")).toBe("export const v = 1;\n");
    // 신규 파일은 지우지 않는다 — 안전(삭제는 사용자 몫).
    expect(existsSync(join(repo, "agent-new.ts"))).toBe(true);
  });

  it("스냅샷 시점의 untracked 미커밋 작업도 복원한다", () => {
    // 스냅샷 시점에 이미 존재하던 untracked 파일.
    writeFileSync(join(repo, "wip.txt"), "snapshot-time content\n");
    const snap = snapshotWorkdir(repo);
    expect(snap).not.toBeNull();

    // 이후 그 파일이 변경됨(에이전트가 덮어씀).
    writeFileSync(join(repo, "wip.txt"), "clobbered by agent\n");

    restoreWorkdirSnapshot(repo, snap!.commit);
    // 스냅샷 시점 내용으로 복원.
    expect(readFileSync(join(repo, "wip.txt"), "utf-8")).toBe("snapshot-time content\n");
  });

  it("git repo가 아니면 null / false 로 안전 폴백", () => {
    const plain = mkdtempSync(join(tmpdir(), "crewdeck-plain-"));
    try {
      expect(snapshotWorkdir(plain)).toBeNull();
      expect(restoreWorkdirSnapshot(plain, "deadbeef")).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
