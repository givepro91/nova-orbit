import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { stashCheckpoint, restoreCheckpoint, dropCheckpoint } from '../core/project/worktree.js';

// R1 스모크에서 발견된 P0 회귀 방지:
// stashCheckpoint 가 push 만 하고 트리를 복원하지 않아, Goal-as-Unit 공유 worktree 의
// 미커밋 goal WIP(이전 태스크 산출물)가 stash 로 쓸려나가고 성공 시 dropCheckpoint 가
// 그 stash 를 지우면서 구현이 영구 소실됐다. (smoke-calc: subtract 구현 증발)

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crewdeck-ckpt-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@crewdeck.local');
  git(repo, 'config', 'user.name', 'crewdeck-test');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-m', 'base');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('stashCheckpoint — goal WIP 보존', () => {
  it('체크포인트 생성 후에도 작업 트리의 WIP가 유지된다 (tracked + untracked)', () => {
    writeFileSync(join(repo, 'a.txt'), 'wip\n'); // 이전 태스크의 미커밋 산출물
    writeFileSync(join(repo, 'new.txt'), 'untracked wip\n');

    const created = stashCheckpoint(repo, 'task-2');

    expect(created).toBe(true);
    expect(readFileSync(join(repo, 'a.txt'), 'utf-8')).toBe('wip\n');
    expect(readFileSync(join(repo, 'new.txt'), 'utf-8')).toBe('untracked wip\n');
    expect(git(repo, 'stash', 'list')).toContain('crewdeck-checkpoint-task-2');
  });

  it('성공 경로: dropCheckpoint 후에도 WIP가 트리에 남는다', () => {
    writeFileSync(join(repo, 'a.txt'), 'wip\n');
    stashCheckpoint(repo, 'task-2');

    dropCheckpoint(repo, 'task-2');

    expect(readFileSync(join(repo, 'a.txt'), 'utf-8')).toBe('wip\n');
    expect(git(repo, 'stash', 'list')).toBe('');
  });

  it('변경사항이 없으면 stash를 만들지 않고 false를 반환한다', () => {
    expect(stashCheckpoint(repo, 'task-x')).toBe(false);
    expect(git(repo, 'stash', 'list')).toBe('');
  });

  it('동일 taskId 체크포인트가 이미 있으면 중복 생성하지 않는다', () => {
    writeFileSync(join(repo, 'a.txt'), 'wip\n');
    expect(stashCheckpoint(repo, 'task-2')).toBe(true);
    expect(stashCheckpoint(repo, 'task-2')).toBe(false);
    expect(git(repo, 'stash', 'list').trim().split('\n')).toHaveLength(1);
  });
});

describe('restoreCheckpoint — 실패 롤백', () => {
  it('실패한 태스크의 변경만 폐기하고 pre-task WIP를 복원한다', () => {
    writeFileSync(join(repo, 'a.txt'), 'wip\n');
    writeFileSync(join(repo, 'new.txt'), 'untracked wip\n');
    stashCheckpoint(repo, 'task-3');

    // 실패한 태스크가 어지럽힌 트리
    writeFileSync(join(repo, 'a.txt'), 'broken\n');
    writeFileSync(join(repo, 'junk.txt'), 'junk\n');

    const restored = restoreCheckpoint(repo, 'task-3');

    expect(restored).toBe(true);
    expect(readFileSync(join(repo, 'a.txt'), 'utf-8')).toBe('wip\n');
    expect(readFileSync(join(repo, 'new.txt'), 'utf-8')).toBe('untracked wip\n');
    expect(existsSync(join(repo, 'junk.txt'))).toBe(false);
    expect(git(repo, 'stash', 'list')).toBe(''); // pop으로 소진
  });

  it('체크포인트가 없으면(pre-task 트리 클린) 태스크 변경 폐기만으로 복원 성공', () => {
    writeFileSync(join(repo, 'a.txt'), 'broken\n');
    writeFileSync(join(repo, 'junk.txt'), 'junk\n');

    const restored = restoreCheckpoint(repo, 'task-9');

    expect(restored).toBe(true);
    expect(readFileSync(join(repo, 'a.txt'), 'utf-8')).toBe('base\n');
    expect(existsSync(join(repo, 'junk.txt'))).toBe(false);
  });
});
