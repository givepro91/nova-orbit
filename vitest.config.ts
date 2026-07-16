import { defineConfig, configDefaults } from 'vitest/config';

// 실제 git worktree/서버 spawn으로 무거운 통합·E2E 테스트 (파일당 수~수십초, 합계 ~5.5분).
// 평소 `npm test`(빠른 unit)에서는 제외하고 `npm run test:e2e`로 따로 돌린다.
// 새 통합/E2E 테스트를 추가하면 여기에 등록한다(그러지 않으면 fast에 섞여 루프가 느려진다).
const SLOW = [
  'server/__tests__/goal-as-unit.e2e.test.ts',
  'server/__tests__/scheduler-contract.e2e.test.ts',
  'server/__tests__/steering.e2e.test.ts',
  'server/__tests__/git-recovery-guard.test.ts',
  'server/__tests__/recovery-scheduling.test.ts',
  'server/__tests__/git-workflow-squash.test.ts',
  'server/__tests__/process-termination.test.ts',
  'server/__tests__/goal-delete-cleanup.test.ts',
  'server/__tests__/evaluator-diff.test.ts',
  'server/__tests__/worktree-checkpoint.test.ts',
  'server/__tests__/worktree-slug.test.ts',
  'server/__tests__/workdir-snapshot.test.ts',
  'server/__tests__/worktree-remove-locked.test.ts',
  'server/__tests__/terminal-orchestration-dogfood.test.ts',
];

// 서버 테스트만. 대시보드 테스트는 jsdom+@testing-library가 dashboard/node_modules에만 있어
// root에서 실행 불가 → 대시보드 패키지에서 `cd dashboard && npm test`로 따로 돈다(패키지별 자기 테스트).
const ALL_INCLUDE = [
  'server/__tests__/**/*.test.ts',
  'server/core/**/*.test.ts',
];

// CREWDECK_TEST_SCOPE: 미설정(fast, SLOW 제외) | 'e2e'(SLOW만) | 'all'(전체)
const scope = process.env.CREWDECK_TEST_SCOPE;
const isE2E = scope === 'e2e';
const includesAll = scope === 'e2e' || scope === 'all';

export default defineConfig({
  test: {
    include: isE2E ? SLOW : ALL_INCLUDE,
    exclude: includesAll ? [...configDefaults.exclude] : [...configDefaults.exclude, ...SLOW],
    // git worktree/server 스폰이 무거운 통합·E2E 테스트가 파일 병렬 실행 시
    // git-index·소켓 경합으로 산발 실패(ECONNRESET/lock) → 파일 단위 직렬화로 제거.
    fileParallelism: false,
    // E2E(실서버 spawn + git worktree)는 기본 5s 안에 못 끝나 산발 timeout → 여유 부여.
    testTimeout: 30_000,
    // E2E 실서버 spawn/fetch의 비결정적 ECONNRESET 레이스 흡수용. 결정적 실패는 여전히 모든 재시도에서 실패.
    retry: 2,
  },
});
