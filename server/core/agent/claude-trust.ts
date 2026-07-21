import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("claude-trust");

/**
 * claude 는 처음 보는 디렉토리에서 "Is this a project you trust?" 다이얼로그를 띄우고
 * 사람이 Enter 를 누를 때까지 아무것도 실행하지 않는다. crewdeck 이 goal/workspace 마다
 * 새 worktree 를 만드는 구조라 이 다이얼로그가 매번 떠서, 무인 실행이 첫 줄도 못 나가고 멈춘다.
 *
 * 그래서 crewdeck 이 만든 worktree 에 한해 **부모 프로젝트의 신뢰를 상속**시킨다.
 * 부모(프로젝트 workdir)가 이미 신뢰돼 있을 때만 등록하므로, 사용자가 신뢰한 적 없는
 * 코드베이스를 crewdeck 이 대신 신뢰하는 일은 없다.
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

function configPath(): string {
  return join(homedir(), ".claude.json");
}

function isTrusted(projects: Record<string, unknown>, path: string): boolean {
  const entry = projects[path] as { hasTrustDialogAccepted?: boolean } | undefined;
  return entry?.hasTrustDialogAccepted === true;
}

/**
 * worktreePath 를 claude 신뢰 목록에 등록한다 — parentPath 가 이미 신뢰된 경우에만.
 *
 * @returns 등록했으면 true, (이미 신뢰됨 / 부모 미신뢰 / 실패)면 false
 */
export function inheritClaudeTrust(worktreePath: string, parentPath: string): boolean {
  try {
    const file = configPath();
    if (!existsSync(file)) return false;

    const target = resolve(worktreePath);
    const parent = resolve(parentPath);
    if (target === parent) return false;

    const raw = readFileSync(file, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const projects = (config.projects ?? {}) as Record<string, unknown>;

    if (isTrusted(projects, target)) return false; // 이미 신뢰됨 — 건드리지 않는다
    if (!isTrusted(projects, parent)) {
      // 사용자가 부모 프로젝트를 신뢰한 적 없다 → 상속할 신뢰가 없다. 조용히 넘어간다.
      log.debug(`Skip trust inheritance: parent not trusted (${parent})`);
      return false;
    }

    projects[target] = { ...MINIMAL_ENTRY };
    config.projects = projects;

    // 원자적 쓰기 — 이 파일에는 oauth/계정 정보가 들어 있어 부분 쓰기로 깨뜨리면 안 된다.
    const tmp = `${file}.crewdeck-${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (error) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
      throw error;
    }
    log.info(`Inherited claude trust for worktree: ${target}`);
    return true;
  } catch (error) {
    // 신뢰 등록 실패가 worktree 생성을 막아서는 안 된다 — 최악의 경우 사람이 Enter 를 누르면 된다.
    log.warn(`Trust inheritance failed for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
