import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxBackend } from "../core/terminal/tmux.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("terminal process security boundary", () => {
  it("passes bridge secrets only through env while tmux argv and ps stay secret-free", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crewdeck-tmux-security-"));
    dirs.push(dataDir);
    const fakeTmux = join(dataDir, "fake-tmux.cjs");
    const recordsPath = join(dataDir, "records.jsonl");
    writeFileSync(fakeTmux, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("new-session")) {
  const secret = process.env.CREWDECK_API_KEY || "";
  const command = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "command="], { encoding: "utf8" });
  appendFileSync(process.env.CREWDECK_TEST_RECORDS, JSON.stringify({
    argvHasSecret: secret.length > 0 && args.some((arg) => arg.includes(secret)),
    psHasSecret: secret.length > 0 && command.includes(secret),
    envHasExpectedSecret: secret === process.env.CREWDECK_EXPECTED_SECRET,
    hasKeyValueArgument: args.some((arg) => arg.startsWith("CREWDECK_API_KEY=")),
    cwdIsLiteral: args.includes(process.env.CREWDECK_EXPECTED_CWD),
    shellAndArgsAreSeparate: args.slice(-2).join("|") === "/bin/zsh|-l",
  }) + "\\n");
}
process.exit(0);
`, { mode: 0o700 });
    chmodSync(fakeTmux, 0o700);

    const backend = TmuxBackend.detect(dataDir, { command: process.execPath, args: [fakeTmux] });
    expect(backend).not.toBeNull();
    const cwd = join(dataDir, "path with ; shell metacharacters");
    const create = (runtimeId: string, secret: string) => backend!.createSession({
      runtimeId,
      shell: "/bin/zsh",
      shellArgs: ["-l"],
      cwd,
      cols: 100,
      rows: 30,
      env: {
        ...process.env,
        CREWDECK_API_KEY: secret,
        CREWDECK_EXPECTED_SECRET: secret,
        CREWDECK_EXPECTED_CWD: cwd,
        CREWDECK_TEST_RECORDS: recordsPath,
      },
    });
    create("first", "test-only-first-bridge-secret");
    create("second", "test-only-second-bridge-secret");

    const records = readFileSync(recordsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toEqual([
      {
        argvHasSecret: false,
        psHasSecret: false,
        envHasExpectedSecret: true,
        hasKeyValueArgument: false,
        cwdIsLiteral: true,
        shellAndArgsAreSeparate: true,
      },
      {
        argvHasSecret: false,
        psHasSecret: false,
        envHasExpectedSecret: true,
        hasKeyValueArgument: false,
        cwdIsLiteral: true,
        shellAndArgsAreSeparate: true,
      },
    ]);

    const configPath = join(dataDir, "terminal-runtime", "tmux.conf");
    chmodSync(configPath, 0o666);
    create("third", "test-only-third-bridge-secret");
    const config = readFileSync(configPath, "utf8");
    expect(config).toContain("CREWDECK_API_KEY");
    expect(config).not.toContain("test-only-first-bridge-secret");
    expect(config).not.toContain("test-only-second-bridge-secret");
    expect(config).not.toContain("test-only-third-bridge-secret");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });
});
