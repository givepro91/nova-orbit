import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTeamDesign, buildTeamDesignPrompt } from '../core/agent/team-designer.js';

const createdDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nova-team-designer-'));
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
    expect(agents).toHaveLength(2);
    expect(agents[0].source).toBe('ai');
    expect(agents[0].name).toBe('카피 정합 검증자');
  });

  it('markdown 코드펜스로 감싼 JSON도 파싱한다', () => {
    const raw = '설계 결과입니다:\n```json\n' + JSON.stringify([validItem()]) + '\n```\n';
    expect(parseTeamDesign(raw)).toHaveLength(1);
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

  it('maxAgents를 초과하는 항목은 자른다', () => {
    const raw = JSON.stringify(Array.from({ length: 10 }, (_, i) => validItem({ name: `에이전트${i}`, role: 'qa' })));
    expect(parseTeamDesign(raw, 4)).toHaveLength(4);
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
});
