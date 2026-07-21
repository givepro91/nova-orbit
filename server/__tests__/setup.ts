// 테스트는 실행하는 사람의 CLI 설정을 절대 건드리지 않는다.
// 통합 테스트가 실제 git worktree 를 만들면 worktree.ts 가 claude 신뢰를 등록하는데,
// 그대로 두면 `npm test` 한 번에 ~/.claude.json 에 임시 경로가 쌓인다(실측).
process.env.CREWDECK_SKIP_CLAUDE_TRUST = "1";
