import { beforeEach, describe, expect, it, vi } from "vitest";

const configFile = vi.hoisted(() => ({ content: "{}" }));

vi.mock("node:fs", () => ({
  existsSync: () => true,
  readFileSync: () => configFile.content,
}));

vi.mock("node:os", () => ({ homedir: () => "/test-home" }));

import { loadProviderConfig } from "../core/agent/provider.js";

describe("provider budget config parsing", () => {
  beforeEach(() => {
    configFile.content = "{}";
  });

  it("preserves null limits in a valid budget", () => {
    configFile.content = JSON.stringify({
      budget: { tokenLimit: null, timeLimitMs: 60_000, warnPct: 0.8 },
    });

    expect(loadProviderConfig().budget).toEqual({
      tokenLimit: null,
      timeLimitMs: 60_000,
      warnPct: 0.8,
    });
  });

  it.each([
    undefined,
    null,
    [],
    { tokenLimit: -1, timeLimitMs: null, warnPct: 0.8 },
    { tokenLimit: null, timeLimitMs: "60000", warnPct: 0.8 },
    { tokenLimit: null, timeLimitMs: null, warnPct: 1.1 },
  ])("returns undefined for a missing or malformed budget: %j", (budget) => {
    configFile.content = JSON.stringify({ budget });

    expect(loadProviderConfig().budget).toBeUndefined();
  });
});
