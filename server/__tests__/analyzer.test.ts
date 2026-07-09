import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeProject } from '../core/project/analyzer.js';

const createdDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crewdeck-test-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('analyzeProject — TypeScript + React project', () => {
  it('detects TypeScript language', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }));
    writeFileSync(join(dir, 'tsconfig.json'), '{}');

    const result = analyzeProject(dir);
    expect(result.techStack.languages).toContain('TypeScript');
  });

  it('detects React framework', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }));

    const result = analyzeProject(dir);
    expect(result.techStack.frameworks).toContain('React');
  });

  it('detects npm as package manager (no lock files)', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0' },
    }));

    const result = analyzeProject(dir);
    expect(result.techStack.packageManager).toBe('npm');
  });

  it('detects vitest as test framework', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      devDependencies: { vitest: '^1.0.0' },
    }));

    const result = analyzeProject(dir);
    expect(result.techStack.testFramework).toBe('Vitest');
  });

  it('suggests Frontend Dev + Reviewer + QA for React + TypeScript with tests', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0', express: '^4.0.0' },
      devDependencies: { typescript: '^5.0.0', vitest: '^1.0.0' },
    }));

    const result = analyzeProject(dir);
    const roles = result.suggestedAgents.map((a) => a.role);
    expect(roles).toContain('coder');
    expect(roles).toContain('reviewer');
    expect(roles).toContain('qa');
  });

  it('always includes at least one coder and one reviewer', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0' },
    }));

    const result = analyzeProject(dir);
    expect(result.suggestedAgents.some((a) => a.role === 'coder')).toBe(true);
    expect(result.suggestedAgents.some((a) => a.role === 'reviewer')).toBe(true);
  });
});

describe('analyzeProject — empty directory', () => {
  it('returns empty languages and frameworks', () => {
    const dir = makeTempDir();

    const result = analyzeProject(dir);
    expect(result.techStack.languages).toHaveLength(0);
    expect(result.techStack.frameworks).toHaveLength(0);
  });

  it('still suggests at least one agent', () => {
    const dir = makeTempDir();

    const result = analyzeProject(dir);
    expect(result.suggestedAgents.length).toBeGreaterThan(0);
  });

  it('has undefined packageManager', () => {
    const dir = makeTempDir();

    const result = analyzeProject(dir);
    expect(result.techStack.packageManager).toBeUndefined();
  });
});

describe('analyzeProject — nonexistent directory', () => {
  it('throws an error', () => {
    expect(() => analyzeProject('/tmp/no-such-dir-crewdeck-xyz')).toThrow(
      /Directory not found/,
    );
  });
});

// D-2 (proof dogfooding): requirements-dev.txt 접미사 변형·중첩 web/package.json 미인식 회귀 방지
describe('analyzeProject — 모노레포 / requirements 변형 (D-2)', () => {
  it('requirements-dev.txt 만 있어도 Python + pytest를 감지한다', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'requirements-dev.txt'), 'pytest>=8.0\nruff\n');

    const result = analyzeProject(dir);
    expect(result.techStack.languages).toContain('Python');
    expect(result.techStack.testFramework).toBe('pytest');
  });

  it('1-depth 하위 디렉토리의 package.json을 감지한다 (web/ 모노레포)', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'web'));
    writeFileSync(join(dir, 'web', 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0' },
      devDependencies: { typescript: '^5.0.0', vite: '^5.0.0' },
    }));

    const result = analyzeProject(dir);
    expect(result.techStack.languages).toContain('TypeScript');
    expect(result.techStack.frameworks).toContain('React');
    expect(result.techStack.buildTool).toBe('Vite');
  });

  it('proof형 구조: 루트 requirements-dev.txt + web/package.json 병합 감지', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'requirements-dev.txt'), 'pytest\n');
    mkdirSync(join(dir, 'web'));
    writeFileSync(join(dir, 'web', 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0', tailwindcss: '^4.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }));

    const result = analyzeProject(dir);
    expect(result.techStack.languages).toEqual(expect.arrayContaining(['Python', 'TypeScript']));
    expect(result.techStack.frameworks).toEqual(expect.arrayContaining(['React', 'TailwindCSS']));
    expect(result.techStack.testFramework).toBe('pytest');
  });

  it('루트와 하위 디렉토리에 같은 스택이 있어도 중복 없이 병합한다', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }));
    mkdirSync(join(dir, 'dashboard'));
    writeFileSync(join(dir, 'dashboard', 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }));

    const result = analyzeProject(dir);
    expect(result.techStack.languages.filter((l) => l === 'TypeScript')).toHaveLength(1);
    expect(result.techStack.frameworks.filter((f) => f === 'React')).toHaveLength(1);
  });
});

describe('analyzeProject — suggested agents based on tech stack', () => {
  it('suggests separate frontend/backend coders for fullstack project', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0', express: '^4.0.0' },
    }));

    const result = analyzeProject(dir);
    const coders = result.suggestedAgents.filter((a) => a.role === 'coder');
    expect(coders.length).toBe(2);
    expect(coders.some((a) => a.name === 'Frontend Dev')).toBe(true);
    expect(coders.some((a) => a.name === 'Backend Dev')).toBe(true);
  });

  it('suggests single Developer for backend-only project', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { express: '^4.0.0' },
    }));

    const result = analyzeProject(dir);
    const coders = result.suggestedAgents.filter((a) => a.role === 'coder');
    expect(coders.length).toBe(1);
    expect(coders[0].name).toBe('Developer');
  });

  it('detects test directory and sets testFramework to "detected"', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'tests'));
    // no package.json with test framework

    const result = analyzeProject(dir);
    expect(result.techStack.testFramework).toBe('detected');
  });

  it('does not suggest QA agent when no test framework', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0' },
    }));
    // no test framework in deps, no tests/ directory

    const result = analyzeProject(dir);
    expect(result.suggestedAgents.some((a) => a.role === 'qa')).toBe(false);
  });
});
