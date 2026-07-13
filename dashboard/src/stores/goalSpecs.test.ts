import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSpec, saveSpec, approveSpec } = vi.hoisted(() => ({
  getSpec: vi.fn(),
  saveSpec: vi.fn(),
  approveSpec: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: { goals: { getSpec, saveSpec, approveSpec } },
}));

import type { GoalSpecState } from "../lib/api";
import { useGoalSpecStore } from "./goalSpecs";

const draft: GoalSpecState = {
  goal_id: "g1",
  status: "draft",
  execution_spec_version_id: null,
  legacy_spec: null,
  versions: [{
    id: "v1",
    version: 1,
    state: "draft",
    scope: "scope",
    out_of_scope: "out",
    acceptance_criteria: ["accepted"],
    expected_tasks: ["task"],
    verification_methods: ["test"],
    created_at: "2026-07-12T00:00:00.000Z",
    approved_at: null,
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  useGoalSpecStore.setState({
    byGoalId: {},
    loadingByGoalId: {},
    savingByGoalId: {},
    approvingByGoalId: {},
    errorByGoalId: {},
  });
});

describe("Goal Spec store", () => {
  it("stores the fetched state by goal id", async () => {
    getSpec.mockResolvedValue(draft);

    await useGoalSpecStore.getState().fetchGoalSpec("g1");

    expect(useGoalSpecStore.getState().byGoalId.g1).toEqual(draft);
  });

  it("rejects a mismatched response without polluting another goal cache", async () => {
    getSpec.mockResolvedValue({ ...draft, goal_id: "other-goal" });

    await expect(useGoalSpecStore.getState().fetchGoalSpec("g1"))
      .rejects.toThrow("Blueprint response goal_id mismatch");
    expect(useGoalSpecStore.getState().byGoalId).toEqual({});
  });

  it("replaces status and version history immediately after save and approve", async () => {
    const changed = {
      ...draft,
      status: "changes_pending" as const,
      versions: [...draft.versions, { ...draft.versions[0], id: "v2", version: 2 }],
    };
    const approved = {
      ...changed,
      status: "approved" as const,
      execution_spec_version_id: "v2",
      versions: changed.versions.map((version) => version.id === "v2"
        ? { ...version, state: "approved" as const, approved_at: "2026-07-12T01:00:00.000Z" }
        : version),
    };
    saveSpec.mockResolvedValue(changed);
    approveSpec.mockResolvedValue(approved);

    await useGoalSpecStore.getState().saveGoalSpec("g1", {
      scope: "scope",
      out_of_scope: "out",
      acceptance_criteria: ["accepted"],
      expected_tasks: ["task"],
      verification_methods: ["test"],
    });
    expect(useGoalSpecStore.getState().byGoalId.g1).toEqual(changed);

    await useGoalSpecStore.getState().approveGoalSpec("g1", "v2");
    expect(useGoalSpecStore.getState().byGoalId.g1).toEqual(approved);
  });
});
