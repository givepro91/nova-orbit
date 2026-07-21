import { resolve } from "node:path";

/**
 * codex 는 신뢰 목록에 없는 디렉토리에서 "Do you trust the contents of this directory?"
 * 온보딩을 띄우고 사람이 고를 때까지 아무것도 실행하지 않는다. crewdeck 의 PTY 터미널은
 * 사람이 들여다볼 수 있을 뿐 실제로는 crewdeck 이 태스크를 무인 집행하는 세션이라,
 * 이 다이얼로그가 뜨면 태스크가 첫 줄도 못 나가고 무기한 멈춘다.
 *
 * 그래서 crewdeck 이 터미널마다 만드는 **격리 CODEX_HOME** 에 대상 디렉토리 신뢰를 미리 넣는다.
 * 이것은 권한 확대가 아니다:
 *   - codex 자신이 비대화 실행(`codex exec`)에서 대상 디렉토리를 자동으로 trusted 로 기록한다(실측).
 *   - 격리 홈은 crewdeck 전용이라 사용자의 `~/.codex/config.toml` 은 건드리지 않는다.
 *   - 같은 태스크를 headless 로 돌리면 이미 `--dangerously-bypass-approvals-and-sandbox` 로 실행된다.
 * 신뢰 대상은 crewdeck 이 만든 workspace worktree 로 한정된다.
 */
export function codexTrustEntry(worktreePath: string): string[] {
  // worktree 는 .git 이 파일이라 codex 가 repo root 로 인식하지 못한다 → cwd 자체를 등록한다.
  // codex 는 cwd 가 신뢰돼 있으면 repo root 를 따지지 않는다(실측).
  return [`[projects.${JSON.stringify(resolve(worktreePath))}]`, 'trust_level = "trusted"', ""];
}
