import { describe, expect, it } from "vitest";
import { AGENT_HANDOFF_CONTRACT_VERSION } from "../../shared/types.js";
import {
  agentHandoffSchema,
  createAgentHandoff,
  validateAgentHandoff,
} from "../core/agent/handoff.js";

describe("agent handoff contract", () => {
  it.each(["decompose", "implementation", "verification", "fix"] as const)(
    "creates a versioned %s handoff and normalizes absent entries",
    (stage) => {
      expect(createAgentHandoff({ stage })).toEqual({
        version: AGENT_HANDOFF_CONTRACT_VERSION,
        stage,
        changed_files: [],
        decisions: [],
        unresolved_risks: [],
        reproduction_commands: [],
      });
    },
  );

  it("accepts a complete handoff through the shared schema", () => {
    const handoff = createAgentHandoff({
      stage: "implementation",
      changed_files: ["server/core/agent/handoff.ts"],
      decisions: ["Use a provider-neutral contract."],
      reproduction_commands: ["npm test"],
    });

    expect(agentHandoffSchema.safeParse(handoff)).toEqual({
      success: true,
      data: handoff,
      diagnostics: [],
    });
  });

  it("reports every missing required field without normalizing consumer input", () => {
    const result = validateAgentHandoff({ version: 1, stage: "fix" });

    expect(result.success).toBe(false);
    expect(result.diagnostics.map(({ field, code }) => ({ field, code }))).toEqual([
      { field: "changed_files", code: "missing_field" },
      { field: "decisions", code: "missing_field" },
      { field: "unresolved_risks", code: "missing_field" },
      { field: "reproduction_commands", code: "missing_field" },
    ]);
  });

  it("returns field-specific diagnostics for version, stage, array, and entry errors", () => {
    const result = validateAgentHandoff({
      version: 2,
      stage: "review",
      changed_files: "server/index.ts",
      decisions: [""],
      unresolved_risks: [null],
      reproduction_commands: [],
    });

    expect(result.success).toBe(false);
    expect(result.diagnostics.map(({ field, code }) => ({ field, code }))).toEqual([
      { field: "version", code: "unsupported_version" },
      { field: "stage", code: "invalid_value" },
      { field: "changed_files", code: "invalid_type" },
      { field: "decisions[0]", code: "invalid_value" },
      { field: "unresolved_risks[0]", code: "invalid_type" },
    ]);
  });

  it("rejects a non-object root with a root diagnostic", () => {
    expect(validateAgentHandoff(null)).toMatchObject({
      success: false,
      diagnostics: [{ field: "$", code: "invalid_type" }],
    });
  });
});
