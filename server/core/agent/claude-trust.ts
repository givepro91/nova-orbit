import { existsSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("claude-trust");

/**
 * claude 는 처음 보는 디렉토리에서 "Is this a project you trust?" 다이얼로그를 띄우고
 * 사람이 Enter 를 누를 때까지 아무것도 실행하지 않는다. crewdeck 이 goal/workspace 마다
 * 새 worktree 를 만드는 구조라 이 다이얼로그가 매번 떠서, PTY 무인 실행이 첫 줄도 못 나가고 멈춘다.
 *
 * 우회로가 없다는 것을 실측으로 확인했다:
 *   - `--permission-mode bypassPermissions` / `--dangerously-skip-permissions` 둘 다 다이얼로그가 뜬다.
 *   - `CLAUDE_CONFIG_DIR` 로 설정을 격리하면 인증이 따라오지 않는다("Not logged in").
 * 즉 codex 처럼 crewdeck 전용 격리 홈에 신뢰를 넣는 방법이 없어, 전역 설정에 등록하는 수밖에 없다.
 *
 * 그래서 **crewdeck 이 만든 worktree 경로만** 등록한다. 사용자의 원본 프로젝트 디렉토리는
 * 건드리지 않으며, worktree 는 crewdeck 이 만들고 goal 종료 시 정리하는 임시 공간이라
 * 신뢰 범위가 그 수명으로 한정된다. (비대화 실행에서는 claude 가 `-p` 로 이 다이얼로그를
 * 건너뛰므로 headless 경로는 애초에 이 등록이 필요 없다.)
 */
const MINIMAL_ENTRY = {
  allowedTools: [] as string[],
  mcpContextUris: [] as string[],
  mcpServers: {} as Record<string, unknown>,
  enabledMcpjsonServers: [] as string[],
  disabledMcpjsonServers: [] as string[],
  hasTrustDialogAccepted: true,
  projectOnboardingSeenCount: 0,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
};

/** 동시 쓰기와 부딪혔을 때 다시 읽어보는 횟수. 계속 부딪히면 포기한다(fail-soft). */
const WRITE_ATTEMPTS = 3;

function configPath(): string {
  return join(homedir(), ".claude.json");
}

function isTrusted(projects: Record<string, unknown>, path: string): boolean {
  const entry = projects[path] as { hasTrustDialogAccepted?: boolean } | undefined;
  return entry?.hasTrustDialogAccepted === true;
}

/**
 * crewdeck 이 만든 worktree 를 claude 신뢰 목록에 등록한다.
 *
 * 반드시 crewdeck 이 생성한 worktree 경로만 넘겨야 한다 — 사용자의 원본 프로젝트
 * 디렉토리를 넘기면 신뢰 범위가 의도보다 넓어진다.
 *
 * @returns 등록했으면 true, (이미 신뢰됨 / 설정 없음 / 실패)면 false
 */
export function grantClaudeTrust(worktreePath: string): boolean {
  try {
    // 사용자 전역 설정을 건드리는 유일한 지점이라 옵트아웃을 둔다. 테스트는 이걸 켜서
    // 실행하는 사람의 ~/.claude.json 을 오염시키지 않는다(실측: 통합 테스트가 실제 worktree 를
    // 만들며 엔트리를 쌓았다). PTY 에서 claude 를 쓰지 않는 사용자도 끌 수 있다.
    if (process.env.CREWDECK_SKIP_CLAUDE_TRUST === "1") return false;
    const file = configPath();
    if (!existsSync(file)) return false;

    const target = resolve(worktreePath);

    // 이 파일은 claude 가 자기 세션 중에도 계속 쓴다. 우리가 읽고-고쳐-쓰는 사이에 claude 가
    // 쓰면 그 내용이 통째로 덮인다(lost update). 완전한 상호배제는 불가능하므로(claude 는
    // 락을 잡지 않는다) 쓰기 직전 파일이 읽은 그대로인지 확인하고, 바뀌었으면 다시 읽는다.
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const before = statSync(file);
      const config = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
      const projects = (config.projects ?? {}) as Record<string, unknown>;

      if (isTrusted(projects, target)) return false; // 이미 신뢰됨 — 건드리지 않는다

      projects[target] = { ...MINIMAL_ENTRY };
      config.projects = projects;
      const payload = JSON.stringify(config, null, 2);

      const now = statSync(file);
      if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) continue; // 남이 썼다 — 다시 읽는다

      // 원자적 쓰기 — 이 파일에는 oauth/계정 정보가 들어 있어 부분 쓰기로 깨뜨리면 안 된다.
      const tmp = `${file}.crewdeck-${process.pid}.tmp`;
      try {
        writeFileSync(tmp, payload, { mode: 0o600 });
        renameSync(tmp, file);
      } catch (error) {
        try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
        throw error;
      }
      log.info(`Granted claude trust for crewdeck worktree: ${target}`);
      return true;
    }
    // 계속 바뀌는 중이면 포기한다 — 남의 변경을 덮느니 다이얼로그를 한 번 띄우는 게 낫다.
    log.warn(`Claude trust registration skipped for ${target}: ~/.claude.json is being written concurrently`);
    return false;
  } catch (error) {
    // 신뢰 등록 실패가 worktree 생성을 막아서는 안 된다 — 최악의 경우 사람이 Enter 를 누르면 된다.
    log.warn(`Claude trust registration failed for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
