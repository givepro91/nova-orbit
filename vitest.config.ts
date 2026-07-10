import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['server/__tests__/**/*.test.ts', 'server/core/**/*.test.ts'],
    // git worktree/server 스폰이 무거운 통합·E2E 테스트가 파일 병렬 실행 시
    // git-index·소켓 경합으로 산발 실패(ECONNRESET/lock) → 파일 단위 직렬화로 제거.
    fileParallelism: false,
    // E2E(실서버 spawn + git worktree)는 기본 5s 안에 못 끝나 산발 timeout → 여유 부여.
    testTimeout: 30_000,
    // E2E 실서버 spawn/fetch의 비결정적 ECONNRESET 레이스 흡수용. 결정적 실패는 여전히 모든 재시도에서 실패.
    retry: 2,
  },
});
