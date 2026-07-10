import { describe, expect, it, vi } from "vitest";
import { runStartupPreflight } from "./index.js";
import { PreflightError, runPreflight } from "./runner.js";
import type { PreflightCheck } from "./types.js";

function check(
  id: string,
  options: {
    required?: boolean;
    status?: "pass" | "warning" | "fail";
    run?: PreflightCheck["run"];
  } = {},
): PreflightCheck {
  return {
    id,
    required: options.required ?? true,
    run:
      options.run ??
      (() => ({
        status: options.status ?? "pass",
        summary: `${id} summary`,
        detail: `${id} detail`,
        recoveryCommands: [],
      })),
  };
}

describe("runPreflight", () => {
  it("runs checks sequentially in declaration order", async () => {
    const events: string[] = [];
    const checks = [
      check("first", {
        run: async () => {
          events.push("first:start");
          await Promise.resolve();
          events.push("first:end");
          return {
            status: "pass",
            summary: "first passed",
            detail: "",
            recoveryCommands: [],
          };
        },
      }),
      check("second", {
        run: () => {
          events.push("second:start");
          return {
            status: "pass",
            summary: "second passed",
            detail: "",
            recoveryCommands: [],
          };
        },
      }),
    ];

    const results = await runPreflight(checks);

    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    expect(results.map(({ check: executedCheck }) => executedCheck.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("prints a per-check summary and does not error when every check succeeds", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const results = await runStartupPreflight([check("node"), check("cli")]);

    expect(results).toHaveLength(2);
    const logged = consoleLog.mock.calls.map(([line]) => String(line)).join("\n");
    expect(logged).toContain("[node]");
    expect(logged).toContain("[cli]");
    expect(consoleError).not.toHaveBeenCalled();
    consoleLog.mockRestore();
    consoleError.mockRestore();
  });

  it("keeps warning and optional failure results and continues", async () => {
    const lastCheck = check("last");

    const results = await runPreflight([
      check("warning", { status: "warning" }),
      check("optional", { required: false, status: "fail" }),
      lastCheck,
    ]);

    expect(results.map(({ result }) => result.status)).toEqual([
      "warning",
      "fail",
      "pass",
    ]);
  });

  it("continues past a required failure to collect every cause", async () => {
    const afterFailure = vi.fn<PreflightCheck["run"]>(() => ({
      status: "fail",
      summary: "port is occupied",
      detail: "",
      recoveryCommands: ["npx crewdeck --port=7201"],
    }));
    const recoveryCommands = ["npm rebuild better-sqlite3"];

    const promise = runPreflight([
      check("node"),
      check("sqlite", {
        status: "fail",
        run: () => ({
          status: "fail",
          summary: "Native module is incompatible.",
          detail: "better-sqlite3 failed to load.",
          recoveryCommands,
        }),
      }),
      check("port", { run: afterFailure }),
    ]);

    await expect(promise).rejects.toMatchObject({
      name: "PreflightError",
      exitCode: 1,
      // failedCheck/result 는 하위호환용 — 첫 필수 실패를 가리킨다.
      failedCheck: { id: "sqlite" },
      result: { status: "fail", recoveryCommands },
      // 모든 필수 실패를 일괄 수집한다.
      failures: [{ check: { id: "sqlite" } }, { check: { id: "port" } }],
      completedChecks: [
        { check: { id: "node" } },
        { check: { id: "sqlite" } },
        { check: { id: "port" } },
      ],
    });
    expect(afterFailure).toHaveBeenCalledOnce();
  });

  it("halts the chain when a haltChain check fails so dependents never run", async () => {
    const dependent = vi.fn<PreflightCheck["run"]>(() => ({
      status: "pass",
      summary: "should not run",
      detail: "",
      recoveryCommands: [],
    }));

    const promise = runPreflight([
      { ...check("node", { status: "fail" }), haltChain: true },
      check("sqlite", { run: dependent }),
    ]);

    await expect(promise).rejects.toMatchObject({
      name: "PreflightError",
      exitCode: 1,
      failedCheck: { id: "node" },
      failures: [{ check: { id: "node" } }],
      completedChecks: [{ check: { id: "node" } }],
    });
    expect(dependent).not.toHaveBeenCalled();
  });

  it("turns a thrown check error into a required failure", async () => {
    const promise = runPreflight([
      check("runtime", {
        run: () => {
          throw new Error("spawn ENOENT");
        },
      }),
    ]);

    await expect(promise).rejects.toBeInstanceOf(PreflightError);
    await expect(promise).rejects.toMatchObject({
      exitCode: 1,
      result: {
        status: "fail",
        detail: "spawn ENOENT",
        recoveryCommands: [],
      },
    });
  });

  it("allows a check to be executed independently", async () => {
    const nodeCheck = check("node");

    await expect(Promise.resolve(nodeCheck.run())).resolves.toMatchObject({
      status: "pass",
      summary: "node summary",
      detail: "node detail",
      recoveryCommands: [],
    });
  });
});
