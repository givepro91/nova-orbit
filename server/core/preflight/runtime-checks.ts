import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  providerCliCheck,
  type EffectiveProviderDecision,
  type RestartContext,
} from "./provider-check.js";
import type { PreflightCheck, PreflightCheckResult } from "./types.js";

const MIN_NODE_MAJOR = 20;

/**
 * better-sqlite3 를 담고 있는 Crewdeck 설치 위치의 package root 를 찾는다.
 *
 * 복구 명령을 사용자의 현재 디렉터리가 아니라 Crewdeck 이 실제로 설치된 곳에
 * 겨냥하기 위한 것. ABI/바인딩 오류에서도 package.json 은 디스크에 남아 있어
 * resolve 는 성공한다(네이티브 바이너리를 로드하지 않음).
 */
function crewdeckInstallRoot(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("better-sqlite3/package.json");
    // .../node_modules/better-sqlite3/package.json → 세 단계 위 = Crewdeck root
    return dirname(dirname(dirname(pkg)));
  } catch {
    return null;
  }
}

type DatabaseInstance = {
  close: () => void;
};

type DatabaseConstructor = new (filename: string) => DatabaseInstance;

type BetterSqlite3Module = {
  default: DatabaseConstructor;
};

type BetterSqlite3Loader = () => Promise<BetterSqlite3Module>;

export type SqliteNativeFailureKind =
  | "abi-mismatch"
  | "binding-missing"
  | "load-failure";

const ABI_ERROR_PATTERNS = [
  /NODE_MODULE_VERSION/i,
  /compiled against a different Node\.js version/i,
  /module did not self-register/i,
  /invalid ELF header/i,
  /wrong ELF class/i,
];

const BINDING_ERROR_PATTERNS = [
  /Could not locate the bindings file/i,
  /better_sqlite3\.node/i,
  /native binding/i,
  /ERR_DLOPEN_FAILED/i,
  /cannot find module/i,
  /module not found/i,
  /no such file or directory/i,
  /specified module could not be found/i,
];

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = "code" in error ? String(error.code) : "";
    return [error.name, code, error.message, error.stack]
      .filter(Boolean)
      .join("\n");
  }
  return String(error);
}

/** better-sqlite3 로드 실패를 사용자 복구 방법에 맞는 범주로 분류한다. */
export function classifySqliteNativeError(
  error: unknown,
): SqliteNativeFailureKind {
  const text = errorText(error);
  if (ABI_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
    return "abi-mismatch";
  }
  if (BINDING_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
    return "binding-missing";
  }
  return "load-failure";
}

/** Node.js 런타임 버전이 최소 요구치를 만족하는지 확인한다. */
export function nodeVersionCheck(
  minMajor = MIN_NODE_MAJOR,
  version = process.versions.node,
): PreflightCheck {
  return {
    id: "node",
    required: true,
    // Node 실패 시 이후 네이티브 모듈(better-sqlite3) 로드를 시도하지 않도록 체인을 중단한다.
    haltChain: true,
    run: (): PreflightCheckResult => {
      const major = Number.parseInt(version.split(".")[0] ?? "", 10);
      if (Number.isFinite(major) && major >= minMajor) {
        return {
          status: "pass",
          summary: `Node.js ${version}`,
          detail: `Node.js >= ${minMajor} 요구치를 만족합니다.`,
          recoveryCommands: [],
        };
      }

      return {
        status: "fail",
        summary: `Node.js ${version} 는 지원되지 않습니다.`,
        detail:
          `Crewdeck 은 Node.js >= ${minMajor} 이 필요합니다. ` +
          `현재 버전은 ${version} 입니다. 버전을 전환한 뒤 Crewdeck 을 다시 실행하세요.`,
        recoveryCommands: [
          `nvm install ${minMajor}`,
          `nvm use ${minMajor}`,
          "npx crewdeck",
        ],
      };
    },
  };
}

/** 설치 루트를 찾지 못했을 때만 사용하는 최후 복구 명령. */
const REINSTALL_CREWDECK = "npm install --global crewdeck@latest";

/**
 * Crewdeck 설치 위치의 better-sqlite3 만 재빌드하는 명령을 만든다.
 *
 * `--prefix` 로 사용자의 현재 디렉터리가 아니라 Crewdeck 이 설치된
 * node_modules 를 대상으로 삼는다. root 를 못 찾으면(모듈 자체 부재) null.
 */
function rebuildCommand(root: string | null): string | null {
  return root ? `npm rebuild better-sqlite3 --prefix "${root}"` : null;
}

/** Crewdeck 설치 위치의 better-sqlite3 만 강제로 다시 설치한다. */
function reinstallCommand(root: string | null): string {
  return root
    ? `npm install --force better-sqlite3 --prefix "${root}"`
    : REINSTALL_CREWDECK;
}

function isPresent(command: string | null): command is string {
  return command !== null;
}

function sqliteFailure(
  error: unknown,
  installRoot: string | null,
): PreflightCheckResult {
  const kind = classifySqliteNativeError(error);
  const detail = error instanceof Error ? error.message : String(error);
  const rebuild = rebuildCommand(installRoot);
  const reinstall = reinstallCommand(installRoot);

  if (kind === "abi-mismatch") {
    return {
      status: "fail",
      summary: "better-sqlite3 ABI 가 현재 Node.js 버전과 호환되지 않습니다.",
      detail,
      recoveryCommands: [rebuild, reinstall].filter(isPresent),
    };
  }

  if (kind === "binding-missing") {
    // 바인딩 파일 자체가 없을 수 있으므로 재설치를 먼저 안내한다.
    return {
      status: "fail",
      summary: "better-sqlite3 네이티브 바인딩을 찾거나 로드할 수 없습니다.",
      detail,
      recoveryCommands: [reinstall, rebuild].filter(isPresent),
    };
  }

  return {
    status: "fail",
    summary: "better-sqlite3 네이티브 모듈을 로드할 수 없습니다.",
    detail,
    recoveryCommands: [rebuild, reinstall].filter(isPresent),
  };
}

const loadBetterSqlite3: BetterSqlite3Loader = async () =>
  import("better-sqlite3");

/**
 * better-sqlite3 를 실제 인메모리 DB 생성까지 probe 한다.
 *
 * 동적 import 는 run() 안에서만 수행하므로 Node 버전 check 가 먼저 실패하면
 * 네이티브 모듈을 로드하지 않는다.
 */
export function sqliteNativeCheck(
  load: BetterSqlite3Loader = loadBetterSqlite3,
  resolveInstallRoot: () => string | null = crewdeckInstallRoot,
): PreflightCheck {
  return {
    id: "sqlite",
    required: true,
    run: async (): Promise<PreflightCheckResult> => {
      try {
        const { default: Database } = await load();
        const db = new Database(":memory:");
        db.close();
        return {
          status: "pass",
          summary: "better-sqlite3 로드 성공",
          detail: "better-sqlite3 네이티브 모듈이 정상 로드됩니다.",
          recoveryCommands: [],
        };
      } catch (error) {
        return sqliteFailure(error, resolveInstallRoot());
      }
    },
  };
}

export interface RuntimeChecksOptions {
  /** provider-cli 진단이 실제로 확인한 실행 provider를 재probe 없이 전달받는다. */
  onProviderResolved?: (decision: EffectiveProviderDecision) => void;
  /** provider-cli 복구 재실행 명령이 현재 호출의 --data-dir·--port·--no-open을 보존하도록 전달. */
  restart?: RestartContext;
}

/**
 * 시작 프리플라이트 체크 목록 (선언 순서대로 실행).
 *
 * Node 검사를 가장 먼저 두어, 지원되지 않는 Node 에서는 네이티브 모듈
 * 로드(better-sqlite3)를 시도하지 않고 중단한다.
 */
export function runtimeChecks(options: RuntimeChecksOptions = {}): PreflightCheck[] {
  return [
    nodeVersionCheck(),
    sqliteNativeCheck(),
    providerCliCheck({
      onResolved: options.onProviderResolved,
      restart: options.restart,
    }),
  ];
}
