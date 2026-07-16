import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTeamDesign, buildTeamDesignPrompt, designTeamCached, clearDesignCache, getDesignStatus, markDesignConsumed } from '../core/agent/team-designer.js';

const createdDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crewdeck-team-designer-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const validItem = (over: Record<string, unknown> = {}) => ({
  name: '카피 정합 검증자',
  role: 'reviewer',
  reason: '확정 어휘 준수 검증이 핵심이라',
  system_prompt: '이 프로젝트의 vocab.ts를 SoT로 삼아 화면 카피의 폐기 어휘 잔존을 검증한다. 코드 구조 변경은 하지 않는다.',
  ...over,
});

describe('parseTeamDesign — LLM 응답 파싱', () => {
  it('raw JSON 배열을 파싱하고 source를 ai로 표시한다', () => {
    const raw = JSON.stringify([validItem(), validItem({ name: 'Python 파이프라인 엔지니어', role: 'backend' })]);
    const agents = parseTeamDesign(raw);
    expect(agents.filter((a) => a.source === 'ai')).toHaveLength(2);
    expect(agents[0].source).toBe('ai');
    expect(agents[0].name).toBe('카피 정합 검증자');
  });

  it('markdown 코드펜스로 감싼 JSON도 파싱한다', () => {
    const raw = '설계 결과입니다:\n```json\n' + JSON.stringify([validItem()]) + '\n```\n';
    expect(parseTeamDesign(raw).filter((a) => a.source === 'ai')).toHaveLength(1);
  });

  it('JSON이 아닌 응답은 throw한다 (호출부 fallback 계약)', () => {
    expect(() => parseTeamDesign('죄송합니다, 팀을 설계할 수 없습니다.')).toThrow();
  });

  it('빈 배열은 throw한다', () => {
    expect(() => parseTeamDesign('[]')).toThrow();
  });

  it('name 또는 system_prompt가 없는 항목은 버린다 — 전부 무효면 throw', () => {
    const raw = JSON.stringify([
      validItem(),
      { role: 'backend', reason: 'name 없음', system_prompt: 'x'.repeat(300) },
      validItem({ system_prompt: '' }),
    ]);
    const agents = parseTeamDesign(raw);
    expect(agents.filter((a) => a.source === 'ai')).toHaveLength(1);

    expect(() => parseTeamDesign(JSON.stringify([{ role: 'backend' }]))).toThrow();
  });

  it('VALID_ROLES 밖의 role은 custom으로 강제한다', () => {
    const raw = JSON.stringify([
      validItem({ role: 'game-designer' }),
      validItem({ name: 'QA', role: 'qa' }),
    ]);
    const agents = parseTeamDesign(raw);
    expect(agents[0].role).toBe('custom');
    expect(agents[1].role).toBe('qa');
  });

  it('reviewer/qa 계열이 없으면 프리셋 reviewer를 자동 추가한다', () => {
    const raw = JSON.stringify([validItem({ role: 'backend' }), validItem({ name: 'FE', role: 'frontend' })]);
    const agents = parseTeamDesign(raw);
    expect(agents.some((a) => a.role === 'reviewer')).toBe(true);
    expect(agents.find((a) => a.role === 'reviewer')?.source).toBe('preset');
  });

  it('maxAgents를 초과하는 항목은 자른다 (보장 role 자동 추가는 예외)', () => {
    const raw = JSON.stringify(Array.from({ length: 10 }, (_, i) => validItem({ name: `에이전트${i}`, role: 'qa' })));
    expect(parseTeamDesign(raw, 4).filter((a) => a.source === 'ai')).toHaveLength(4);
  });

  it('cto/pm 조정자가 없으면 프리셋 CTO를 자동 추가한다', () => {
    const raw = JSON.stringify([validItem({ role: 'backend' }), validItem({ name: 'QA', role: 'qa' })]);
    const agents = parseTeamDesign(raw);
    const cto = agents.find((a) => a.role === 'cto');
    expect(cto).toBeDefined();
    expect(cto?.source).toBe('preset');
  });

  it('설계에 cto 또는 pm이 있으면 조정자를 중복 추가하지 않는다', () => {
    const withCto = parseTeamDesign(JSON.stringify([validItem({ name: '프로덕트 아키텍트', role: 'cto' }), validItem({ name: 'QA', role: 'qa' })]));
    expect(withCto.filter((a) => a.role === 'cto' || a.role === 'pm')).toHaveLength(1);

    const withPm = parseTeamDesign(JSON.stringify([validItem({ name: 'PM', role: 'pm' }), validItem({ name: 'QA', role: 'qa' })]));
    expect(withPm.filter((a) => a.role === 'cto' || a.role === 'pm')).toHaveLength(1);
  });

  it('에이전트별 model 배정을 파싱하고, 허용 외 값은 버린다 (role 기본으로 해석되도록)', () => {
    const raw = JSON.stringify([
      validItem({ name: '아키텍트', role: 'cto', model: 'opus' }),
      validItem({ name: 'QA', role: 'qa', model: 'haiku' }),
      validItem({ name: 'FE', role: 'frontend', model: 'gpt-5' }),
    ]);
    const agents = parseTeamDesign(raw);
    expect(agents[0].model).toBe('opus');
    expect(agents[1].model).toBe('haiku');
    expect(agents[2].model).toBeUndefined();
  });

  it('필드 길이 상한을 적용한다', () => {
    const raw = JSON.stringify([
      validItem({ name: 'N'.repeat(200), reason: 'R'.repeat(500), system_prompt: 'P'.repeat(10000), role: 'qa' }),
    ]);
    const [a] = parseTeamDesign(raw);
    expect(a.name.length).toBeLessThanOrEqual(50);
    expect(a.reason.length).toBeLessThanOrEqual(200);
    expect(a.systemPrompt.length).toBeLessThanOrEqual(4000);
  });
});

describe('designTeamCached — 캐시/인플라이트 공유 (모달 이탈·새로고침 대비)', () => {
  beforeEach(() => clearDesignCache());

  const input = { projectName: 'p', workdir: '/tmp' } as any;
  const fakeTeam = [{ name: 'A', role: 'cto', systemPrompt: 'x', reason: '', source: 'ai' as const }];

  it('진행 중 동시 요청은 설계를 한 번만 실행하고 결과를 공유한다', async () => {
    let calls = 0;
    const designFn = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return fakeTeam; };
    const [a, b] = await Promise.all([
      designTeamCached('proj1', input, { designFn }),
      designTeamCached('proj1', input, { designFn }),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it('완료 후 재요청은 캐시에서 즉시 반환한다 (새로고침 후 재진입)', async () => {
    let calls = 0;
    const designFn = async () => { calls++; return fakeTeam; };
    await designTeamCached('proj2', input, { designFn });
    await designTeamCached('proj2', input, { designFn });
    expect(calls).toBe(1);
  });

  it('refresh=true는 캐시를 무시하고 새로 설계한다', async () => {
    let calls = 0;
    const designFn = async () => { calls++; return fakeTeam; };
    await designTeamCached('proj3', input, { designFn });
    await designTeamCached('proj3', input, { designFn, refresh: true });
    expect(calls).toBe(2);
  });

  it('실패는 캐시되지 않아 재시도가 가능하다', async () => {
    let calls = 0;
    const designFn = async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return fakeTeam;
    };
    await expect(designTeamCached('proj4', input, { designFn })).rejects.toThrow('boom');
    await expect(designTeamCached('proj4', input, { designFn })).resolves.toEqual(fakeTeam);
    expect(calls).toBe(2);
  });

  it('프로젝트별로 캐시가 분리된다', async () => {
    let calls = 0;
    const designFn = async () => { calls++; return fakeTeam; };
    await designTeamCached('proj-a', input, { designFn });
    await designTeamCached('proj-b', input, { designFn });
    expect(calls).toBe(2);
  });
});

describe('getDesignStatus — 설계 상태 표면화 (새로고침 후 칩 복원)', () => {
  beforeEach(() => clearDesignCache());

  const input = { projectName: 'p', workdir: '/tmp' } as any;
  const fakeTeam = [{ name: 'A', role: 'cto', systemPrompt: 'x', reason: '', source: 'ai' as const }];

  it('진행 중이면 running, 완료 후 미소비면 ready', async () => {
    let resolveDesign!: (v: typeof fakeTeam) => void;
    const designFn = () => new Promise<typeof fakeTeam>((r) => { resolveDesign = r; });
    const p = designTeamCached('s1', input, { designFn });

    expect(getDesignStatus('s1')).toEqual({ running: true, ready: false });
    resolveDesign(fakeTeam);
    await p;
    expect(getDesignStatus('s1')).toEqual({ running: false, ready: true });
  });

  it('markDesignConsumed 후에는 ready가 꺼진다 (결과 확인 완료)', async () => {
    await designTeamCached('s2', input, { designFn: async () => fakeTeam });
    expect(getDesignStatus('s2').ready).toBe(true);
    markDesignConsumed('s2');
    expect(getDesignStatus('s2')).toEqual({ running: false, ready: false });
  });

  it('기록 없는 프로젝트는 둘 다 false', () => {
    expect(getDesignStatus('unknown')).toEqual({ running: false, ready: false });
  });
});

describe('buildTeamDesignPrompt — 프로젝트 컨텍스트 수집', () => {
  it('mission·스택·구조·문서 발췌·아키타입을 프롬프트에 포함한다', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'CLAUDE.md'), '# 프로젝트 규칙\n커리어 증거 도메인이다.');
    mkdirSync(join(dir, 'web'));
    mkdirSync(join(dir, 'pipeline'));

    const prompt = buildTeamDesignPrompt({
      projectName: 'proof',
      mission: '일만 하세요. 커리어 자산은 저절로 쌓입니다.',
      workdir: dir,
      techStack: { languages: ['Python', 'TypeScript'], frameworks: ['React'], testFramework: 'pytest' },
    });

    expect(prompt).toContain('proof');
    expect(prompt).toContain('일만 하세요');
    expect(prompt).toContain('Python, TypeScript');
    expect(prompt).toContain('web/');
    expect(prompt).toContain('커리어 증거 도메인');
    expect(prompt).toContain('reviewer'); // 아키타입 참조
    expect(prompt).toContain('EXACT JSON');
  });

  it('문서·스택이 없어도 동작한다', () => {
    const dir = makeTempDir();
    const prompt = buildTeamDesignPrompt({ projectName: 'bare', workdir: dir });
    expect(prompt).toContain('bare');
    expect(prompt).toContain('(not set)');
  });

  it('선택 목표의 설명·기획·현재 태스크를 팀 설계 입력에 포함한다', () => {
    const dir = makeTempDir();
    const prompt = buildTeamDesignPrompt({
      projectName: 'ops-console',
      workdir: dir,
      focusGoal: {
        title: '자동화 evidence freshness 확정',
        description: '재생된 snapshot을 정상으로 표시하지 않는다',
        plan: 'Acceptance: source 시각과 수집 시각을 함께 검증한다',
        tasks: [{ title: 'signed envelope validator', description: '실효 freshness 계산', status: 'todo' }],
      },
    });

    expect(prompt).toContain('Selected goal');
    expect(prompt).toContain('자동화 evidence freshness 확정');
    expect(prompt).toContain('source 시각과 수집 시각');
    expect(prompt).toContain('signed envelope validator');
    expect(prompt).toContain('Optimize the team for the selected goal');
  });
});
