import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { collectDiffSummary } from '../core/quality-gate/evaluator.js';

// R2 회귀 방지: Goal-as-Unit 에서 Evaluator diff 가 HEAD~1..HEAD(마지막 커밋)만 봐서
// (1) 미커밋 goal WIP 가 diff 에 안 보이고 (2) 잔여물 커밋(.omc)이 "변경 파일"로 잡혀
// no-changes 가드가 무력화되던 결함. goal 누적 diff + 도구 상태 경로 제외를 검증한다.

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'nova-evdiff-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@nova.local');
  git(repo, 'config', 'user.name', 'nova-test');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-m', 'base');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('collectDiffSummary — Goal-as-Unit 누적 diff (goalBase)', () => {
  it('분기점 이후의 커밋된 변경 + 미커밋 변경 + untracked를 모두 잡는다', () => {
    git(repo, 'checkout', '-b', 'goal/x');
    // 커밋된 변경 (architect phase 등)
    writeFileSync(join(repo, 'committed.txt'), 'committed\n');
    git(repo, 'add', 'committed.txt');
    git(repo, 'commit', '-m', 'architect residue');
    // 미커밋 변경 (Goal-as-Unit WIP — 구현 태스크 산출물)
    writeFileSync(join(repo, 'a.txt'), 'implemented\n');
    // untracked 신규 파일
    writeFileSync(join(repo, 'new.txt'), 'new\n');

    const diff = collectDiffSummary(repo, { goalBase: 'main' });

    expect(diff.error).toBeUndefined();
    expect(diff.files).toContain('committed.txt');
    expect(diff.files).toContain('a.txt'); // ← 미커밋 WIP가 diff에 보여야 한다 (핵심)
    expect(diff.untracked).toContain('new.txt');
    expect(diff.baseRef).toContain('main');
  });

  it('.omc 등 도구 상태 경로는 diff와 untracked에서 제외된다', () => {
    git(repo, 'checkout', '-b', 'goal/x');
    // 잔여물 커밋 시뮬레이션 — .omc만 커밋됨 (R1 1차 스모크의 residue 커밋)
    mkdirSync(join(repo, '.omc'), { recursive: true });
    writeFileSync(join(repo, '.omc', 'state.json'), '{}\n');
    git(repo, 'add', '.omc');
    git(repo, 'commit', '-m', 'residue');
    // untracked 도구 상태
    mkdirSync(join(repo, '.playwright-mcp'), { recursive: true });
    writeFileSync(join(repo, '.playwright-mcp', 'page.yml'), 'x\n');

    const diff = collectDiffSummary(repo, { goalBase: 'main' });

    // 도구 상태만 변경된 goal은 "변경 없음"으로 보여야 no-changes 가드가 발동한다
    expect(diff.files).toHaveLength(0);
    expect(diff.fileCount).toBe(0);
    expect(diff.untracked).toHaveLength(0);
  });

  it('goalBase의 merge-base를 못 찾으면 legacy(HEAD~1..HEAD)로 fallback한다', () => {
    writeFileSync(join(repo, 'b.txt'), 'second\n');
    git(repo, 'add', 'b.txt');
    git(repo, 'commit', '-m', 'second');

    const diff = collectDiffSummary(repo, { goalBase: 'no-such-branch' });

    expect(diff.baseRef).toBe('HEAD~1');
    expect(diff.files).toContain('b.txt');
  });
});

describe('collectDiffSummary — legacy 모드 (goalBase 없음)', () => {
  it('HEAD~1..HEAD 커밋 diff를 그대로 사용한다', () => {
    writeFileSync(join(repo, 'b.txt'), 'second\n');
    git(repo, 'add', 'b.txt');
    git(repo, 'commit', '-m', 'second');
    writeFileSync(join(repo, 'a.txt'), 'uncommitted\n'); // legacy에선 안 보이는 게 기존 계약

    const diff = collectDiffSummary(repo);

    expect(diff.baseRef).toBe('HEAD~1');
    expect(diff.files).toContain('b.txt');
    expect(diff.files).not.toContain('a.txt');
  });

  it('git repo가 아니면 error를 담아 반환한다', () => {
    const plain = mkdtempSync(join(tmpdir(), 'nova-plain-'));
    try {
      const diff = collectDiffSummary(plain);
      expect(diff.error).toBeTruthy();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
