import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SQLite from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/preflight/provider-check.js", () => ({
  providerCliCheck: () => ({
    id: "provider-cli",
    required: true,
    run: () => ({
      status: "fail",
      summary: "override provider unavailable",
      detail: "codex unavailable",
      recoveryCommands: ["codex login"],
    }),
  }),
}));

import { setRuntimeDefaultProvider } from "../core/agent/provider.js";
import { startServer } from "../index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  setRuntimeDefaultProvider(null);
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("startServer provider override preflight", () => {
  it("does not change the database or write a PID lock when an override check fails", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "crewdeck-startup-preflight-"));
    temporaryDirectories.push(dataDir);
    const dbPath = join(dataDir, "crewdeck.db");
    const db = new SQLite(dbPath);
    db.pragma("journal_mode = DELETE");
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        default_provider TEXT
      );
      INSERT INTO projects (id, status, default_provider)
      VALUES ('project-1', 'active', 'codex');
    `);
    db.close();
    setRuntimeDefaultProvider("claude");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(startServer({ port: 72_000, dataDir })).rejects.toMatchObject({
      name: "PreflightError",
    });

    const inspection = new SQLite(dbPath, { readonly: true, fileMustExist: true });
    expect(inspection.pragma("journal_mode", { simple: true })).toBe("delete");
    inspection.close();
    expect(existsSync(join(dataDir, "server.pid"))).toBe(false);
  });

  it("reports an unreadable existing database as a preflight failure without changing it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "crewdeck-corrupt-database-"));
    temporaryDirectories.push(dataDir);
    const dbPath = join(dataDir, "crewdeck.db");
    const original = Buffer.alloc(32, 0x41);
    await writeFile(dbPath, original);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(startServer({ port: 7200, dataDir })).rejects.toMatchObject({
      name: "PreflightError",
      failedCheck: { id: "database" },
      result: {
        status: "fail",
        summary: expect.stringContaining("데이터베이스를 읽을 수 없습니다"),
        recoveryCommands: [expect.stringContaining("mktemp -d")],
      },
    });

    const output = consoleError.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("[database]");
    expect(output).toContain("file is not a database");
    expect(output).not.toContain("SqliteError:");
    expect(await readFile(dbPath)).toEqual(original);
    expect(existsSync(join(dataDir, "server.pid"))).toBe(false);
  });
});
