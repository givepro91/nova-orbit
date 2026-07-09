import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createGoalWorktree } from '../core/project/worktree.js';
import { createAgentBranch } from '../core/project/github.js';

// D-3 (proof dogfooding): 한글 goal 제목이 slugify에서 통째로 소거되어
// goal-goal-xxx 무의미 worktree/브랜치명이 되던 문제의 회귀 방지.

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crewdeck-slug-'));
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

describe('createGoalWorktree — 한글 slug 보존 (D-3)', () => {
  it('한글 goal 제목이 worktree 경로와 브랜치명에 보존된다', () => {
    const info = createGoalWorktree(repo, '감사 원장 어휘 폐기');

    expect(info).not.toBeNull();
    expect(info!.branch).toMatch(/^goal\/감사-원장-어휘-폐기-[0-9a-f]{8}$/);
    expect(info!.path).toContain('goal-감사-원장-어휘-폐기-');
    // 실제 git ref로도 유효해야 한다
    expect(git(repo, 'branch', '--list', info!.branch).trim()).not.toBe('');
  });

  it('영문 제목은 기존과 동일하게 동작한다', () => {
    const info = createGoalWorktree(repo, 'Add login feature');

    expect(info).not.toBeNull();
    expect(info!.branch).toMatch(/^goal\/add-login-feature-[0-9a-f]{8}$/);
  });

  it('기호만 있는 제목은 goal fallback을 쓴다', () => {
    const info = createGoalWorktree(repo, '!!! ???');

    expect(info).not.toBeNull();
    expect(info!.branch).toMatch(/^goal\/goal-[0-9a-f]{8}$/);
  });
});

describe('createAgentBranch — 한글 태스크 제목 (D-3)', () => {
  it('한글 태스크 제목이 브랜치명에 보존된다', () => {
    const branch = createAgentBranch(repo, 'Backend Dev', '로그인 기능 추가');

    expect(branch).toBe('agent/backend-dev/로그인-기능-추가');
    expect(git(repo, 'branch', '--list', branch).trim()).not.toBe('');
  });

  it('기호만 있는 제목도 유효한 ref를 만든다 (agent/x/ 방지)', () => {
    const branch = createAgentBranch(repo, 'Backend Dev', '###');

    expect(branch).toBe('agent/backend-dev/task');
    expect(git(repo, 'branch', '--list', branch).trim()).not.toBe('');
  });
});
