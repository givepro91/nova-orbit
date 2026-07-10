import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PreflightCheck, PreflightCheckResult } from "./types.js";

export type DataDirectorySource =
  | "command-line"
  | "environment"
  | "legacy"
  | "default";

export interface DataDirectorySelection {
  path: string;
  source: DataDirectorySource;
  reason: string;
}

interface ResolveDataDirectoryOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
  pathExists?: (path: string) => boolean;
}

interface FileSystemOperations {
  stat: typeof stat;
  mkdir: typeof mkdir;
  open: typeof open;
  unlink: typeof unlink;
}

interface DataDirectoryCheckOptions {
  fs?: Partial<FileSystemOperations>;
  createProbeName?: () => string;
  fallbackPath?: string;
}

const defaultFileSystem: FileSystemOperations = {
  stat,
  mkdir,
  open,
  unlink,
};

function optionValue(args: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const argument = args.find((value) => value.startsWith(prefix));
  const value = argument?.slice(prefix.length);
  return value || undefined;
}

/** 기존 CLI 계약과 같은 우선순위로 데이터 디렉토리를 선택한다. */
export function resolveDataDirectory(
  args: readonly string[],
  options: ResolveDataDirectoryOptions = {},
): DataDirectorySelection {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const pathExists = options.pathExists ?? existsSync;

  const commandLinePath = optionValue(args, "--data-dir");
  if (commandLinePath) {
    return {
      path: resolve(cwd, commandLinePath),
      source: "command-line",
      reason: "--data-dir 옵션에서 선택했습니다.",
    };
  }

  if (env.CREWDECK_DATA_DIR) {
    return {
      path: resolve(cwd, env.CREWDECK_DATA_DIR),
      source: "environment",
      reason: "CREWDECK_DATA_DIR 환경변수에서 선택했습니다.",
    };
  }

  const legacyPath = resolve(cwd, ".crewdeck");
  if (pathExists(join(legacyPath, "crewdeck.db"))) {
    return {
      path: legacyPath,
      source: "legacy",
      reason: "현재 작업 디렉토리의 기존 .crewdeck/crewdeck.db를 감지했습니다.",
    };
  }

  return {
    path: resolve(home, ".crewdeck"),
    source: "default",
    reason: "정식 기본 위치 ~/.crewdeck을 선택했습니다.",
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String(error.code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * OS 임시 디렉토리는 재부팅/정리 시 삭제될 수 있어 DB 저장 위치로 부적합하므로
 * 후보를 홈 디렉토리 아래(영구 위치)에 둔다. 실제로 쓰기 가능한지는
 * probeFallbackDirectory 로 사용 시점에 검증한다.
 */
function fallbackDataDirectory(): string {
  return resolve(homedir(), ".crewdeck-fallback");
}

function recoveryCommand(path: string): string {
  return `npx crewdeck --data-dir=${shellQuote(path)}`;
}

/** 후보 디렉토리가 실제로 생성·쓰기 가능한지 확인한다 — 검증 없이 복구 명령으로 제안하지 않기 위함. */
async function probeFallbackDirectory(
  fs: FileSystemOperations,
  path: string,
  createProbeName: () => string,
): Promise<boolean> {
  try {
    const entry = await fs.stat(path);
    if (!entry.isDirectory()) return false;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return false;
    try {
      await fs.mkdir(path, { recursive: true });
    } catch {
      return false;
    }
  }

  const probePath = join(path, createProbeName());
  try {
    const handle = await fs.open(probePath, "wx", 0o600);
    await handle.writeFile("crewdeck write probe\n", "utf8");
    await handle.close();
    await fs.unlink(probePath);
    return true;
  } catch {
    return false;
  }
}

/** 명시적으로 제공된 fallbackPath는 신뢰하고, 자동 후보는 사용 전 검증한다. */
async function resolveFallbackPath(
  fs: FileSystemOperations,
  createProbeName: () => string,
  providedFallbackPath: string | undefined,
): Promise<string | null> {
  if (providedFallbackPath) return providedFallbackPath;

  const candidate = fallbackDataDirectory();
  const viable = await probeFallbackDirectory(fs, candidate, createProbeName);
  return viable ? candidate : null;
}

async function directoryFailure(
  selection: DataDirectorySelection,
  fs: FileSystemOperations,
  createProbeName: () => string,
  providedFallbackPath: string | undefined,
  detail: string,
): Promise<PreflightCheckResult> {
  const fallbackPath = await resolveFallbackPath(
    fs,
    createProbeName,
    providedFallbackPath,
  );

  return {
    status: "fail",
    summary: `데이터 디렉토리를 사용할 수 없습니다: ${selection.path}`,
    detail: fallbackPath
      ? detail
      : `${detail} 자동으로 대체할 수 있는 디렉토리도 찾지 못했습니다. ` +
        "쓰기 가능한 디렉토리를 --data-dir=<path>로 직접 지정하세요.",
    recoveryCommands: fallbackPath ? [recoveryCommand(fallbackPath)] : [],
  };
}

/** 선택된 데이터 디렉토리를 생성하고 실제 쓰기/정리 가능 여부를 확인한다. */
export function dataDirectoryCheck(
  selection: DataDirectorySelection,
  options: DataDirectoryCheckOptions = {},
): PreflightCheck {
  const fs = { ...defaultFileSystem, ...options.fs };
  const createProbeName = options.createProbeName ??
    (() => `.crewdeck-write-probe-${process.pid}-${randomUUID()}`);
  const fallbackPath = options.fallbackPath;

  return {
    id: "data-directory",
    required: true,
    run: async (): Promise<PreflightCheckResult> => {
      let createdDirectory = false;

      try {
        const entry = await fs.stat(selection.path);
        if (!entry.isDirectory()) {
          return directoryFailure(
            selection,
            fs,
            createProbeName,
            fallbackPath,
            `${selection.path} 경로가 디렉토리가 아니라 파일입니다.`,
          );
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          return directoryFailure(
            selection,
            fs,
            createProbeName,
            fallbackPath,
            `경로 상태를 확인할 수 없습니다: ${errorMessage(error)}`,
          );
        }

        try {
          await fs.mkdir(selection.path, { recursive: true });
          createdDirectory = true;
        } catch (mkdirError) {
          return directoryFailure(
            selection,
            fs,
            createProbeName,
            fallbackPath,
            `디렉토리를 생성할 수 없습니다: ${errorMessage(mkdirError)}`,
          );
        }
      }

      const probePath = join(selection.path, createProbeName());
      let probeHandle: Awaited<ReturnType<typeof open>> | undefined;
      let probeCreated = false;
      try {
        probeHandle = await fs.open(probePath, "wx", 0o600);
        probeCreated = true;
        await probeHandle.writeFile("crewdeck write probe\n", "utf8");
        await probeHandle.close();
        probeHandle = undefined;
        await fs.unlink(probePath);
        probeCreated = false;
      } catch (error) {
        return directoryFailure(
          selection,
          fs,
          createProbeName,
          fallbackPath,
          `쓰기 probe를 완료할 수 없습니다: ${errorMessage(error)}`,
        );
      } finally {
        if (probeHandle) {
          await probeHandle.close().catch(() => undefined);
        }
        if (probeCreated) {
          await fs.unlink(probePath).catch(() => undefined);
        }
      }

      return {
        status: "pass",
        summary: `데이터 디렉토리 사용 가능: ${selection.path}`,
        detail: createdDirectory
          ? `디렉토리를 생성하고 쓰기 probe를 정리했습니다. ${selection.reason}`
          : `쓰기 probe를 정리했습니다. ${selection.reason}`,
        recoveryCommands: [],
      };
    },
  };
}
