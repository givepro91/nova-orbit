import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitTaskResult } from '../core/project/git-workflow.js';

/**
 * commitTaskResult — 이미 staged된 삭제/이름변경 재-add 회귀 테스트.
 *
 * 2026-07-15 인시던트(swk-infra-console): 에이전트가 Next.js dynamic route
 * 디렉터리(`app/machines/[logicalResourceUid]/page.tsx`)를 삭제하고 그 삭제가
 * 이미 index에 staged된 상태(`D `)에서, commitTaskResult가 status의 모든 dirty
 * 경로를 `git add`로 재-스테이징하려다 실패했다:
 *   fatal: pathspec '.../[logicalResourceUid]/page.tsx' did not match any files
 * 파일이 워크트리·index 양쪽에서 사라졌고, `[...]` 대괄호는 git이 glob 문자
 * 클래스로 해석해 literal 경로도 매칭 못 한다. gitExec가 throw → 태스크가
 * blocked→retry→reassign 무한 루프에 빠져 스케줄러 슬롯을 영구 점유했다.
 *
 * 가드: worktree side(Y)가 clean인 이미-staged 항목은 `git add` 대상에서
 * 제외하되, 커밋에는 그대로 포함되어야 한다.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' });

const repos: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crewdeck-commit-staged-'));
  repos.push(dir);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@crewdeck.local');
  git(dir, 'config', 'user.name', 'Crewdeck Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  mkdirSync(join(dir, 'app/machines/[logicalResourceUid]'), { recursive: true });
  writeFileSync(join(dir, 'app/machines/[logicalResourceUid]/page.tsx'), 'export default function P() { return null; }\n');
  writeFileSync(join(dir, 'app/keep.tsx'), 'export const v = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'base');
  return dir;
}

afterEach(() => {
  for (const dir of repos.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('commitTaskResult — 이미 staged된 항목 재-add 회귀', () => {
  it('staged 삭제된 대괄호 경로가 있어도 throw 없이 커밋한다', () => {
    const dir = makeRepo();
    // 에이전트가 dynamic route 파일을 삭제하고 그 삭제를 이미 stage함(D  상태)
    git(dir, 'rm', 'app/machines/[logicalResourceUid]/page.tsx');
    // + 다른 파일은 워크트리에서 수정(아직 unstaged, ` M`)
    writeFileSync(join(dir, 'app/keep.tsx'), 'export const v = 2;\n');

    const result = commitTaskResult(dir, 'API v2 계약 확정', 'backend');

    expect(result.committed).toBe(true);
    // 삭제 + 수정 = 2개 변경이 모두 커밋에 반영
    const logged = git(dir, 'show', '--name-status', '--format=', 'HEAD').trim();
    expect(logged).toContain('D\tapp/machines/[logicalResourceUid]/page.tsx');
    expect(logged).toContain('M\tapp/keep.tsx');
    // 삭제가 실제로 반영되어 파일이 사라졌는지
    expect(existsSync(join(dir, 'app/machines/[logicalResourceUid]/page.tsx'))).toBe(false);
  });

  it('모든 변경이 이미 staged여도(add할 unstaged 없음) 그대로 커밋한다', () => {
    const dir = makeRepo();
    git(dir, 'rm', 'app/machines/[logicalResourceUid]/page.tsx');
    writeFileSync(join(dir, 'app/keep.tsx'), 'export const v = 3;\n');
    git(dir, 'add', 'app/keep.tsx'); // 이제 둘 다 staged, worktree clean

    const result = commitTaskResult(dir, 'all-staged', 'backend');

    expect(result.committed).toBe(true);
    const logged = git(dir, 'show', '--name-status', '--format=', 'HEAD').trim();
    expect(logged).toContain('D\tapp/machines/[logicalResourceUid]/page.tsx');
    expect(logged).toContain('M\tapp/keep.tsx');
  });

  it('변경이 없으면 커밋하지 않는다', () => {
    const dir = makeRepo();
    const result = commitTaskResult(dir, 'noop', 'backend');
    expect(result.committed).toBe(false);
    expect(result.filesChanged).toBe(0);
  });
});
