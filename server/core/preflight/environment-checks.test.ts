import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dataDirectoryCheck,
  resolveDataDirectory,
  type DataDirectorySelection,
} from "./filesystem-checks.js";
import { pidLockCheck, portAvailabilityCheck } from "./port-check.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "crewdeck-preflight-"));
  temporaryDirectories.push(directory);
  return directory;
}

function selection(path: string): DataDirectorySelection {
  return {
    path,
    source: "command-line",
    reason: "--data-dir 옵션에서 선택했습니다.",
  };
}

function addressInUse(): NodeJS.ErrnoException {
  return Object.assign(new Error("address already in use"), {
    code: "EADDRINUSE",
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("resolveDataDirectory", () => {
  it("preserves command-line, environment, legacy, and default priority", () => {
    const cwd = "/workspace/project";
    const home = "/Users/tester";
    const legacyDatabase = resolve(cwd, ".crewdeck", "crewdeck.db");
    const pathExists = (path: string) => path === legacyDatabase;

    expect(resolveDataDirectory(
      ["--data-dir=./from-flag"],
      {
        cwd,
        home,
        env: { CREWDECK_DATA_DIR: "./from-env" },
        pathExists,
      },
    )).toMatchObject({
      path: resolve(cwd, "from-flag"),
      source: "command-line",
      reason: expect.stringContaining("--data-dir"),
    });

    expect(resolveDataDirectory([], {
      cwd,
      home,
      env: { CREWDECK_DATA_DIR: "./from-env" },
      pathExists,
    })).toMatchObject({
      path: resolve(cwd, "from-env"),
      source: "environment",
      reason: expect.stringContaining("CREWDECK_DATA_DIR"),
    });

    expect(resolveDataDirectory([], {
      cwd,
      home,
      env: {},
      pathExists,
    })).toMatchObject({
      path: resolve(cwd, ".crewdeck"),
      source: "legacy",
      reason: expect.stringContaining("crewdeck.db"),
    });

    expect(resolveDataDirectory([], {
      cwd,
      home,
      env: {},
      pathExists: () => false,
    })).toMatchObject({
      path: resolve(home, ".crewdeck"),
      source: "default",
      reason: expect.stringContaining("~/.crewdeck"),
    });
  });

  it("does not treat an empty flag as overriding the environment", () => {
    expect(resolveDataDirectory(["--data-dir="], {
      cwd: "/workspace",
      home: "/home/tester",
      env: { CREWDECK_DATA_DIR: "configured" },
      pathExists: () => false,
    })).toMatchObject({
      path: resolve("/workspace", "configured"),
      source: "environment",
    });
  });
});

describe("dataDirectoryCheck", () => {
  it("creates a missing directory and removes the write probe", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "missing", "data");

    const result = await dataDirectoryCheck(selection(dataDirectory), {
      createProbeName: () => ".known-probe",
    }).run();

    expect(result).toMatchObject({
      status: "pass",
      detail: expect.stringContaining("생성"),
    });
    expect(existsSync(dataDirectory)).toBe(true);
    expect(await readdir(dataDirectory)).toEqual([]);
  });

  it("rejects a file path and returns a shell-safe fallback command", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, "crewdeck.db");
    await writeFile(filePath, "not a directory");

    const result = await dataDirectoryCheck(selection(filePath), {
      fallbackPath: "/tmp/crewdeck user's data",
    }).run();

    expect(result).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("파일"),
      recoveryCommands: [
        `npx crewdeck --data-dir='/tmp/crewdeck user'"'"'s data'`,
      ],
    });
  });

  it("cleans a created probe after a permission error while removing it", async () => {
    const root = await temporaryDirectory();
    const unlink = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("operation not permitted"), {
        code: "EPERM",
      }))
      .mockResolvedValueOnce(undefined);

    const result = await dataDirectoryCheck(selection(root), {
      createProbeName: () => ".known-probe",
      fallbackPath: "/tmp/crewdeck-safe",
      fs: { unlink },
    }).run();

    expect(result).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("operation not permitted"),
      recoveryCommands: [
        "npx crewdeck --data-dir='/tmp/crewdeck-safe'",
      ],
    });
    expect(unlink).toHaveBeenCalledTimes(2);
  });

  it("validates the default fallback before suggesting it as a recovery command", async () => {
    const stat = vi.fn(async (path: unknown) => {
      if (String(path).endsWith(".crewdeck-fallback")) {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      }
      return { isDirectory: () => false };
    }) as any;
    const mkdir = vi.fn(async () => undefined) as any;
    const open = vi.fn(async () => ({
      writeFile: async () => undefined,
      close: async () => undefined,
    })) as any;
    const unlink = vi.fn(async () => undefined) as any;

    const result = await dataDirectoryCheck(selection("/some/file-path"), {
      createProbeName: () => ".known-probe",
      fs: { stat, mkdir, open, unlink },
    }).run();

    expect(result.status).toBe("fail");
    expect(result.recoveryCommands).toHaveLength(1);
    expect(result.recoveryCommands[0]).toMatch(
      /^npx crewdeck --data-dir='.*\.crewdeck-fallback'$/,
    );
    expect(mkdir).toHaveBeenCalledWith(
      expect.stringContaining(".crewdeck-fallback"),
      { recursive: true },
    );
  });

  it("does not suggest an unwritable default fallback and asks for a manual --data-dir instead", async () => {
    const stat = vi.fn(async (path: unknown) => {
      if (String(path).endsWith(".crewdeck-fallback")) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return { isDirectory: () => false };
    }) as any;

    const result = await dataDirectoryCheck(selection("/some/file-path"), {
      fs: { stat },
    }).run();

    expect(result).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("--data-dir=<path>"),
      recoveryCommands: [],
    });
  });
});

describe("portAvailabilityCheck", () => {
  it("passes after binding and releasing the requested port", async () => {
    const probe = vi.fn(async () => undefined);

    await expect(portAvailabilityCheck(7200, { probe }).run()).resolves.toEqual({
      status: "pass",
      summary: "127.0.0.1:7200 포트 사용 가능",
      detail: "요청 포트에 bind할 수 있습니다.",
      recoveryCommands: [],
    });
    expect(probe).toHaveBeenCalledWith(7200, "127.0.0.1");
  });

  it("finds a bindable alternative when the requested port is occupied", async () => {
    const probe = vi.fn(async (port: number) => {
      if (port === 7200 || port === 7201) throw addressInUse();
    });

    const result = await portAvailabilityCheck(7200, { probe }).run();

    expect(result).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("사용 중"),
      detail: expect.stringContaining("7202"),
      recoveryCommands: ["npx crewdeck --port=7202"],
    });
    expect(probe.mock.calls.map(([port]) => port)).toEqual([7200, 7201, 7202]);
  });

  it.each([0, -1, 65_536, Number.NaN, 7200.5])(
    "rejects invalid port %s without probing",
    async (port) => {
      const probe = vi.fn(async () => undefined);

      const result = await portAvailabilityCheck(port, { probe }).run();

      expect(result).toMatchObject({
        status: "fail",
        recoveryCommands: ["npx crewdeck --port=7200"],
      });
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it("does not suggest a different port for a non-collision bind error", async () => {
    const error = Object.assign(new Error("address not available"), {
      code: "EADDRNOTAVAIL",
    });
    const probe = vi.fn(async () => {
      throw error;
    });

    await expect(portAvailabilityCheck(7200, { probe }).run()).resolves.toMatchObject({
      status: "fail",
      detail: "address not available",
      recoveryCommands: [],
    });
  });

  it("keeps the selected --data-dir in the recovery command for a port collision", async () => {
    const probe = vi.fn(async (port: number) => {
      if (port === 7200) throw addressInUse();
    });

    const result = await portAvailabilityCheck(7200, {
      probe,
      dataDir: "/Users/tester/custom-data",
    }).run();

    expect(result).toMatchObject({
      status: "fail",
      recoveryCommands: [
        "npx crewdeck --data-dir='/Users/tester/custom-data' --port=7201",
      ],
    });
  });

  it("keeps the selected --data-dir in the recovery command for an invalid port", async () => {
    const probe = vi.fn(async () => undefined);

    const result = await portAvailabilityCheck(0, {
      probe,
      dataDir: "/Users/tester/custom-data",
    }).run();

    expect(result).toMatchObject({
      status: "fail",
      recoveryCommands: [
        "npx crewdeck --data-dir='/Users/tester/custom-data' --port=7200",
      ],
    });
  });

  it("shell-quotes a data directory containing special characters", async () => {
    const probe = vi.fn(async (port: number) => {
      if (port === 7200) throw addressInUse();
    });

    const result = await portAvailabilityCheck(7200, {
      probe,
      dataDir: "/tmp/crewdeck user's data",
    }).run();

    expect(result.recoveryCommands).toEqual([
      `npx crewdeck --data-dir='/tmp/crewdeck user'"'"'s data' --port=7201`,
    ]);
  });

  it("surfaces a live PID lock without suggesting an unsafe kill or a different port", async () => {
    const probe = vi.fn(async (port: number) => {
      if (port === 7200) throw addressInUse();
    });
    const runningInstance = vi.fn(() => ({ pid: 4242 }));

    const result = await portAvailabilityCheck(7200, {
      probe,
      dataDir: "/Users/tester/custom-data",
      runningInstance,
    }).run();

    expect(result).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("pid 4242"),
      // server.pid의 PID는 재사용된 무관한 프로세스일 수 있으므로 먼저 조회만 안내한다.
      recoveryCommands: [
        "ps -p 4242 -o pid=,command=",
        "npx crewdeck --data-dir='/Users/tester/custom-data' --port=7200",
      ],
    });
    expect(result.recoveryCommands.join("\n")).not.toContain("kill 4242");
    expect(runningInstance).toHaveBeenCalledWith("/Users/tester/custom-data");
    // 살아있는 인스턴스가 있으면 다른 포트를 탐색하지 않는다.
    expect(probe.mock.calls.map(([port]) => port)).toEqual([7200]);
  });

  it("still suggests an alternative port when no live instance holds the data directory", async () => {
    const probe = vi.fn(async (port: number) => {
      if (port === 7200) throw addressInUse();
    });
    const runningInstance = vi.fn(() => null);

    const result = await portAvailabilityCheck(7200, {
      probe,
      dataDir: "/Users/tester/custom-data",
      runningInstance,
    }).run();

    expect(result).toMatchObject({
      status: "fail",
      recoveryCommands: [
        "npx crewdeck --data-dir='/Users/tester/custom-data' --port=7201",
      ],
    });
    expect(runningInstance).toHaveBeenCalledWith("/Users/tester/custom-data");
  });
});

describe("pidLockCheck", () => {
  it("passes when no live instance holds the data directory", async () => {
    const runningInstance = vi.fn(() => null);

    const result = await pidLockCheck("/Users/tester/custom-data", {
      runningInstance,
    }).run();

    expect(result).toMatchObject({ status: "pass", recoveryCommands: [] });
    expect(runningInstance).toHaveBeenCalledWith("/Users/tester/custom-data");
  });

  it("fails as a [pid-lock] item even when the port is free, with safe recovery", async () => {
    const runningInstance = vi.fn(() => ({ pid: 4242 }));

    const check = pidLockCheck("/Users/tester/custom-data", {
      runningInstance,
    });
    const result = await check.run();

    expect(check.id).toBe("pid-lock");
    expect(result).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("pid 4242"),
      // 살아 있는 PID가 실제 Crewdeck일 수 있으므로 비파괴 조회만 안내한다.
      recoveryCommands: ["ps -p 4242 -o pid=,command="],
    });
    const recovery = result.recoveryCommands.join("\n");
    expect(recovery).not.toContain("kill 4242");
    expect(recovery).not.toContain("rm ");
    // 살아있는 프로세스를 '다른 서버 인스턴스'라고 단정하지 않는다.
    expect(result.summary).not.toContain("다른 서버 인스턴스");
  });
});
