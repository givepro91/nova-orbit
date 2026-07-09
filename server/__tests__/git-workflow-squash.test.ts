import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  squashMergeGoal,
  detectDivergence,
  predictMergeConflict,
  mergeBaseIntoWorktree,
  verifyWorktreeSynced,
} from '../core/project/git-workflow.js';

/**
 * squashMergeGoal — 사용자 잔여 보존 가드 회귀 테스트.
 *
 * 2026-07-08 인시던트: base 브랜치(main) 작업 트리에 커밋 안 된 .gitignore
 * 변경이 있는 상태에서 goal squash를 실행하면 ① merge가 거부되고 ② 복구
 * 로직(reset --hard)이 그 로컬 변경을 조용히 파괴했다. 가드는 merge 전
 * tracked 변경을 stash로 보존하고, 어떤 경로로 끝나든 복원(불가 시 stash
 * 보관 + warning)해야 한다.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' });

const repos: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crewdeck-squash-'));
  repos.push(dir);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@crewdeck.local');
  git(dir, 'config', 'user.name', 'Crewdeck Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  writeFileSync(join(dir, 'app.ts'), 'export const v = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'base');
  return dir;
}

/** goal 브랜치: .gitignore에 라인 추가 + 신규 파일 커밋 후 main 복귀 */
function makeGoalBranch(dir: string, branch = 'goal/test-goal'): string {
  git(dir, 'checkout', '-b', branch);
  writeFileSync(join(dir, '.gitignore'), 'node_modules\ntest-results/\n');
  writeFileSync(join(dir, 'feature.ts'), 'export const f = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'goal work');
  git(dir, 'checkout', 'main');
  return branch;
}

afterEach(() => {
  for (const dir of repos.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('squashMergeGoal — clean tree (기본 경로)', () => {
  // 실제 git spawn 다발 — 전체 스위트 부하에서 기본 5초를 넘길 수 있어 여유 타임아웃
  it('goal 브랜치를 main에 squash 커밋하고 sha를 반환한다', { timeout: 30_000 }, () => {
    const dir = makeRepo();
    const branch = makeGoalBranch(dir);
    const res = squashMergeGoal(dir, branch, 'goal: test', 'local_only', 'main');
    expect(res.error).toBeUndefined();
    expect(res.sha).toBeTruthy();
    expect(res.warning).toBeUndefined();
    expect(readFileSync(join(dir, 'feature.ts'), 'utf-8')).toContain('const f');
  });
});

describe('squashMergeGoal — 사용자 잔여 보존 가드', () => {
  it('goal이 건드리지 않는 파일의 로컬 변경은 merge 후 그대로 복원된다', { timeout: 30_000 }, () => {
    const dir = makeRepo();
    const branch = makeGoalBranch(dir);
    writeFileSync(join(dir, 'app.ts'), 'export const v = 1;\n// local-marker\n');

    const res = squashMergeGoal(dir, branch, 'goal: test', 'local_only', 'main');

    expect(res.error).toBeUndefined();
    expect(res.sha).toBeTruthy();
    expect(res.warning).toBeUndefined();
    expect(readFileSync(join(dir, 'app.ts'), 'utf-8')).toContain('local-marker');
  });

  it('goal이 같은 파일을 수정해도 merge가 성공하고 로컬 변경은 파괴되지 않는다 (인시던트 재현)', { timeout: 30_000 }, () => {
    const dir = makeRepo();
    const branch = makeGoalBranch(dir);
    // 인시던트와 동일: main 작업 트리의 .gitignore에 커밋 안 된 변경
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n# local-marker\n');

    const res = squashMergeGoal(dir, branch, 'goal: test', 'local_only', 'main');

    // 가드 없던 시절: "Your local changes ... would be overwritten by merge"로 실패
    expect(res.error).toBeUndefined();
    expect(res.sha).toBeTruthy();

    // 로컬 변경은 작업 트리로 복원됐거나, 최소한 stash에 보존돼야 한다 (파괴 금지)
    const inTree = readFileSync(join(dir, '.gitignore'), 'utf-8').includes('local-marker');
    if (!inTree) {
      expect(res.warning).toBeTruthy();
      const stashList = git(dir, 'stash', 'list');
      expect(stashList).toContain('crewdeck-squash-guard');
      expect(git(dir, 'stash', 'show', '-p', 'stash@{0}')).toContain('local-marker');
    }
  });

  it('merge가 실제 충돌로 실패해도 로컬 변경을 파괴하지 않고 merge 상태를 정리한다', { timeout: 30_000 }, () => {
    const dir = makeRepo();
    const branch = makeGoalBranch(dir);
    // main을 goal과 충돌하게 전진시킨다 (feature.ts를 다른 내용으로 커밋)
    writeFileSync(join(dir, 'feature.ts'), 'export const f = 999;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'conflicting main work');
    // 커밋 안 된 로컬 변경 (merge와 무관한 파일)
    writeFileSync(join(dir, 'app.ts'), 'export const v = 1;\n// local-marker\n');

    const res = squashMergeGoal(dir, branch, 'goal: test', 'local_only', 'main');

    expect(res.error).toContain('Squash merge failed');
    // 과거 reset --hard는 이 로컬 변경을 파괴했다
    expect(readFileSync(join(dir, 'app.ts'), 'utf-8')).toContain('local-marker');
    // merge 잔해(충돌 index)가 남아 있지 않아야 한다
    const status = git(dir, 'status', '--porcelain');
    expect(status).not.toMatch(/^(UU|AA|DD)/m);
  });
});

describe('integration-time sync helpers — divergence 감지·예측·동기화', () => {
  /** main을 goal과 겹치지 않는 파일로 전진시킨다 */
  const advanceMain = (dir: string) => {
    writeFileSync(join(dir, 'other.ts'), 'export const o = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'main advance (non-overlapping)');
  };

  /** main과 goal이 같은 파일 같은 라인을 다르게 수정한 레포 */
  const makeConflictRepo = (): { dir: string; branch: string } => {
    const dir = makeRepo();
    const branch = 'goal/conflict-goal';
    git(dir, 'checkout', '-b', branch);
    writeFileSync(join(dir, 'app.ts'), 'export const v = 2;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'goal edit');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'app.ts'), 'export const v = 3;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'main edit');
    return { dir, branch };
  };

  it('detectDivergence: base 전진 전 false, 전진 후 true', { timeout: 30_000 }, () => {
    const dir = makeRepo();
    const branch = makeGoalBranch(dir);
    expect(detectDivergence(dir, 'main', branch)).toBe(false);
    advanceMain(dir);
    expect(detectDivergence(dir, 'main', branch)).toBe(true);
  });

  it('predictMergeConflict: 겹치지 않으면 false, 같은 라인 수정이면 true', { timeout: 30_000 }, () => {
    const dir = makeRepo();
    const branch = makeGoalBranch(dir);
    advanceMain(dir);
    expect(predictMergeConflict(dir, 'main', branch)).toBe(false);

    const conflict = makeConflictRepo();
    expect(predictMergeConflict(conflict.dir, 'main', conflict.branch)).toBe(true);
  });

  it('mergeBaseIntoWorktree: 클린 merge로 divergence 해소 + verifyWorktreeSynced ok', { timeout: 30_000 }, () => {
    const dir = makeRepo();
    const branch = makeGoalBranch(dir);
    advanceMain(dir);
    // goal 브랜치 체크아웃 = worktree와 동일 의미 (cwd가 goal 브랜치)
    git(dir, 'checkout', branch);
    expect(verifyWorktreeSynced(dir, 'main', branch, dir).ok).toBe(false); // merge 전 — divergence

    const res = mergeBaseIntoWorktree(dir, 'main');
    expect(res.merged).toBe(true);
    expect(detectDivergence(dir, 'main', branch)).toBe(false);
    expect(verifyWorktreeSynced(dir, 'main', branch, dir).ok).toBe(true);
  });

  it('mergeBaseIntoWorktree: 충돌 시 abort 후 실패 반환, 트리는 클린 유지', { timeout: 30_000 }, () => {
    const { dir, branch } = makeConflictRepo();
    git(dir, 'checkout', branch);
    const res = mergeBaseIntoWorktree(dir, 'main');
    expect(res.merged).toBe(false);
    expect(git(dir, 'ls-files', '-u').trim()).toBe('');
    expect(git(dir, 'status', '--porcelain').trim()).toBe('');
  });
});
