import { describe, expect, it, vi } from "vitest";
import { runPreflight } from "./runner.js";
import {
  classifySqliteNativeError,
  nodeVersionCheck,
  runtimeChecks,
  sqliteNativeCheck,
} from "./runtime-checks.js";

const INSTALL_ROOT = "/opt/crewdeck installation";
const resolveInstallRoot = () => INSTALL_ROOT;

function databaseLoader(options: { close?: () => void } = {}) {
  const close = options.close ?? vi.fn();
  const openedFilenames: string[] = [];
  class Database {
    constructor(filename: string) {
      openedFilenames.push(filename);
    }

    close(): void {
      close();
    }
  }

  return {
    close,
    openedFilenames,
    load: vi.fn(async () => ({ default: Database })),
  };
}

describe("nodeVersionCheck", () => {
  it("passes at the minimum supported Node major", () => {
    expect(nodeVersionCheck(20, "20.0.0").run()).toEqual({
      status: "pass",
      summary: "Node.js 20.0.0",
      detail: "Node.js >= 20 요구치를 만족합니다.",
      recoveryCommands: [],
    });
  });

  it("reports current and required versions and tells the user to rerun", async () => {
    const result = await nodeVersionCheck(20, "18.20.8").run();

    expect(result).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("18.20.8"),
      recoveryCommands: ["nvm install 20", "nvm use 20", "npx crewdeck"],
    });
    expect(result.detail).toContain("Node.js >= 20");
    expect(result.detail).toContain("현재 버전은 18.20.8");
    expect(result.detail).toContain("다시 실행");
  });

  it("fails safely when a supplied version cannot be parsed", () => {
    expect(nodeVersionCheck(20, "unknown").run()).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("unknown"),
    });
  });

  it("prevents the sqlite loader from running after an unsupported Node failure", async () => {
    const sqlite = databaseLoader();

    await expect(
      runPreflight([
        nodeVersionCheck(20, "18.20.8"),
        sqliteNativeCheck(sqlite.load),
      ]),
    ).rejects.toMatchObject({ failedCheck: { id: "node" } });
    expect(sqlite.load).not.toHaveBeenCalled();
  });
});

describe("sqliteNativeCheck", () => {
  it("passes after opening and closing an in-memory database", async () => {
    const sqlite = databaseLoader();

    await expect(sqliteNativeCheck(sqlite.load).run()).resolves.toEqual({
      status: "pass",
      summary: "better-sqlite3 로드 성공",
      detail: "better-sqlite3 네이티브 모듈이 정상 로드됩니다.",
      recoveryCommands: [],
    });
    expect(sqlite.openedFilenames).toEqual([":memory:"]);
    expect(sqlite.close).toHaveBeenCalledOnce();
  });

  it("classifies a Node ABI mismatch and scopes rebuild to the Crewdeck install", async () => {
    const load = vi.fn(async () => {
      throw new Error(
        "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115.",
      );
    });

    const result = await sqliteNativeCheck(load, resolveInstallRoot).run();

    expect(result.status).toBe("fail");
    expect(result.summary).toContain("ABI");
    // 재빌드는 사용자 CWD 가 아니라 Crewdeck 설치 위치(--prefix)를 대상으로 한다.
    expect(result.recoveryCommands[0]).toBe(
      `npm rebuild better-sqlite3 --prefix "${INSTALL_ROOT}"`,
    );
    expect(result.recoveryCommands[1]).toBe(
      `npm install --force better-sqlite3 --prefix "${INSTALL_ROOT}"`,
    );
  });

  it("classifies a missing native binding and recommends reinstalling Crewdeck first", async () => {
    const error = Object.assign(
      new Error("Could not locate the bindings file: better_sqlite3.node"),
      { code: "MODULE_NOT_FOUND" },
    );
    const load = vi.fn(async () => {
      throw error;
    });

    const result = await sqliteNativeCheck(load, resolveInstallRoot).run();

    expect(result.status).toBe("fail");
    expect(result.summary).toContain("바인딩");
    expect(result.recoveryCommands[0]).toBe(
      `npm install --force better-sqlite3 --prefix "${INSTALL_ROOT}"`,
    );
  });

  it("returns Crewdeck-scoped recovery commands for an unclassified native load failure", async () => {
    const load = vi.fn(async () => {
      throw new Error("unexpected native initialization failure");
    });

    const result = await sqliteNativeCheck(load, resolveInstallRoot).run();

    expect(result.status).toBe("fail");
    expect(result.recoveryCommands[0]).toBe(
      `npm rebuild better-sqlite3 --prefix "${INSTALL_ROOT}"`,
    );
    expect(result.recoveryCommands[1]).toBe(
      `npm install --force better-sqlite3 --prefix "${INSTALL_ROOT}"`,
    );
  });

  it("falls back to reinstalling Crewdeck when its install root cannot be resolved", async () => {
    const load = vi.fn(async () => {
      throw new Error("unexpected native initialization failure");
    });

    const result = await sqliteNativeCheck(load, () => null).run();

    expect(result.recoveryCommands).toEqual([
      "npm install --global crewdeck@latest",
    ]);
  });
});

describe("runtimeChecks", () => {
  it("runs Node before sqlite so an unsupported runtime cannot load the native module", () => {
    expect(runtimeChecks().map(({ id }) => id)).toEqual([
      "node",
      "sqlite",
      "provider-cli",
    ]);
  });
});

describe("classifySqliteNativeError", () => {
  it("uses an error code even when the message is generic", () => {
    const error = Object.assign(new Error("dynamic loading failed"), {
      code: "ERR_DLOPEN_FAILED",
    });

    expect(classifySqliteNativeError(error)).toBe("binding-missing");
  });
});
