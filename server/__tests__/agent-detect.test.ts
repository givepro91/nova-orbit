import { describe, expect, it } from "vitest";
import { detectRunningAgent, findAgentInTree, parseProcessTable } from "../core/terminal/agent-detect.js";

const table = (rows: Array<[number, number, string]>) =>
  rows.map(([pid, ppid, command]) => ({ pid, ppid, command }));

describe("agent-detect", () => {
  it("parses ps pid/ppid/command output", () => {
    const entries = parseProcessTable([
      "  100     1 /bin/zsh -l",
      "  200   100 node /opt/homebrew/bin/claude --strict-mcp-config",
      "trailing garbage",
      "",
    ].join("\n"));
    expect(entries).toEqual([
      { pid: 100, ppid: 1, command: "/bin/zsh -l" },
      { pid: 200, ppid: 100, command: "node /opt/homebrew/bin/claude --strict-mcp-config" },
    ]);
  });

  it("finds claude launched through a node shim under the terminal shell", () => {
    const entries = table([
      [100, 1, "/bin/zsh -l"],
      [200, 100, "node /opt/homebrew/bin/claude --strict-mcp-config --mcp-config /tmp/claude-mcp.json"],
    ]);
    expect(findAgentInTree(entries, 100)).toBe("claude");
  });

  it("finds a codex binary executed directly", () => {
    const entries = table([
      [100, 1, "/bin/zsh -l"],
      [300, 100, "/Users/dev/.local/bin/codex"],
    ]);
    expect(findAgentInTree(entries, 100)).toBe("codex");
  });

  it("ignores agent-spawned children like the crewdeck MCP server", () => {
    const entries = table([
      [100, 1, "/bin/zsh -l"],
      [400, 100, "node /srv/crewdeck/dist/bin/crewdeck-mcp.js"],
      [500, 100, "git status --porcelain"],
    ]);
    expect(findAgentInTree(entries, 100)).toBeNull();
  });

  it("returns the shallowest match so the interactive REPL wins over its subprocesses", () => {
    const entries = table([
      [100, 1, "/bin/zsh -l"],
      [200, 100, "claude --strict-mcp-config"],
      [210, 200, "node /srv/crewdeck/dist/bin/crewdeck-mcp.js"],
      [220, 200, "codex exec --json"],
    ]);
    expect(findAgentInTree(entries, 100)).toBe("claude");
  });

  it("does not look at processes outside the terminal's tree", () => {
    const entries = table([
      [100, 1, "/bin/zsh -l"],
      [900, 1, "claude"],
    ]);
    expect(findAgentInTree(entries, 100)).toBeNull();
  });

  it("treats a missing root pid as no running agent", () => {
    expect(detectRunningAgent(null, table([[200, 100, "claude"]]))).toBeNull();
    expect(detectRunningAgent(undefined, table([[200, 100, "claude"]]))).toBeNull();
  });
});
