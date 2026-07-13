import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase, migrate } from "../db/schema.js";
import {
  approveSpecVersion,
  assertExecutionAllowed,
  beginExecutionRun,
  formatExecutionSpecContext,
  getExecutionSpec,
  getSpecState,
  saveSpecDraft,
  SpecApprovalError,
} from "../core/goal-spec/spec-approval.js";
import { buildSummonContext } from "../core/agent/summon-context.js";

function seedGoal(db: Database.Database): string {
  db.prepare("INSERT INTO projects (id, name, source) VALUES ('p1', 'test', 'new')").run();
  db.prepare("INSERT INTO goals (id, project_id, description) VALUES ('g1', 'p1', 'goal')").run();
  return "g1";
}

const completeSpec = {
  scope: "Goal Spec API",
  out_of_scope: "dashboard editing",
  acceptance_criteria: ["three endpoints share one response"],
  expected_tasks: ["implement routes"],
  verification_methods: ["route test"],
};

describe("Goal Spec snapshot store", () => {
  let db: Database.Database;
  let goalId: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    migrate(db);
    goalId = seedGoal(db);
  });

  it("projects legacy goal_specs as read-only legacy_spec when no versioned rows exist", () => {
    db.prepare(`INSERT INTO goal_specs (goal_id, prd_summary, feature_specs, user_flow, acceptance_criteria, tech_considerations, generated_by)
      VALUES (?, ?, ?, ?, ?, ?, 'ai')`).run(
      goalId,
      JSON.stringify({ background: "old bg", objective: "old obj", scope: "old scope", success_metrics: ["m1", "m2"] }),
      JSON.stringify([{ name: "F1", description: "d1", requirements: ["r1"], priority: "must" }]),
      JSON.stringify([{ step: 1, action: "a1", expected: "e1" }]),
      JSON.stringify(["given/when/then"]),
      JSON.stringify(["tech1"]),
    );

    const state = getSpecState(db, goalId);
    expect(state.status).toBe("missing");
    expect(state.versions).toHaveLength(0);
    expect(state.legacy_spec).toMatchObject({
      prd_summary: { background: "old bg", objective: "old obj", scope: "old scope", success_metrics: ["m1", "m2"] },
      feature_specs: [{ name: "F1", description: "d1", requirements: ["r1"], priority: "must" }],
      user_flow: [{ step: 1, action: "a1", expected: "e1" }],
      acceptance_criteria: ["given/when/then"],
      tech_considerations: ["tech1"],
      generated_by: "ai",
    });
  });

  it("stops projecting legacy content once a versioned snapshot exists", () => {
    db.prepare("INSERT INTO goal_specs (goal_id, prd_summary, generated_by) VALUES (?, ?, 'ai')").run(
      goalId, JSON.stringify({ scope: "old scope" }),
    );
    saveSpecDraft(db, goalId, completeSpec);
    expect(getSpecState(db, goalId).legacy_spec).toBeNull();
  });

  it("treats a generation-sentinel-only goal_specs row as no legacy content", () => {
    db.prepare("INSERT INTO goal_specs (goal_id, prd_summary, generated_by) VALUES (?, ?, 'ai')").run(
      goalId, JSON.stringify({ _status: "generating" }),
    );
    expect(getSpecState(db, goalId).legacy_spec).toBeNull();
  });

  it("creates a new immutable snapshot for every save", () => {
    const first = saveSpecDraft(db, goalId, completeSpec);
    const second = saveSpecDraft(db, goalId, { ...completeSpec, scope: "changed scope" });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(getSpecState(db, goalId).versions).toMatchObject([
      { id: first.id, version: 1, scope: "Goal Spec API", state: "draft" },
      { id: second.id, version: 2, scope: "changed scope", state: "draft" },
    ]);
  });

  it("approves the requested version, fixes the execution pointer, and is idempotent", () => {
    const version = saveSpecDraft(db, goalId, completeSpec);
    const approved = approveSpecVersion(db, goalId, version.id);
    const approvedAgain = approveSpecVersion(db, goalId, version.id);

    expect(approved.state).toBe("approved");
    expect(approved.approved_at).not.toBeNull();
    expect(approvedAgain.approved_at).toBe(approved.approved_at);
    expect(getSpecState(db, goalId)).toMatchObject({
      status: "approved",
      execution_spec_version_id: version.id,
    });
  });

  it("blocks missing, draft, and changes_pending but allows the latest approved snapshot", () => {
    db.prepare("UPDATE goals SET spec_approval_required = 1 WHERE id = ?").run(goalId);
    expect(assertExecutionAllowed(db, goalId)).toMatchObject({
      allowed: false,
      reason: "spec_not_approved",
      specStatus: "missing",
      currentDraftVersion: null,
    });

    const first = saveSpecDraft(db, goalId, completeSpec);
    expect(assertExecutionAllowed(db, goalId)).toMatchObject({
      allowed: false,
      specStatus: "draft",
      currentDraftVersion: 1,
    });

    approveSpecVersion(db, goalId, first.id);
    expect(assertExecutionAllowed(db, goalId)).toEqual({ allowed: true });

    saveSpecDraft(db, goalId, { ...completeSpec, scope: "unapproved change" });
    expect(assertExecutionAllowed(db, goalId)).toMatchObject({
      allowed: false,
      specStatus: "changes_pending",
      currentDraftVersion: 2,
    });
  });

  it("rejects re-approving a stale (non-latest) snapshot and leaves the execution pointer untouched", () => {
    const first = saveSpecDraft(db, goalId, completeSpec);
    approveSpecVersion(db, goalId, first.id);
    const latest = saveSpecDraft(db, goalId, { ...completeSpec, scope: "latest" });
    approveSpecVersion(db, goalId, latest.id);

    expect(() => approveSpecVersion(db, goalId, first.id)).toThrow(SpecApprovalError);
    expect(() => approveSpecVersion(db, goalId, first.id)).toThrow(/newer spec version/i);

    expect(getSpecState(db, goalId)).toMatchObject({
      status: "approved",
      execution_spec_version_id: latest.id,
    });
    expect(assertExecutionAllowed(db, goalId)).toEqual({ allowed: true });
  });

  it("rejects approving a stale draft once a newer draft exists, without reviving the invalidated pointer", () => {
    const v1 = saveSpecDraft(db, goalId, completeSpec);
    approveSpecVersion(db, goalId, v1.id);
    saveSpecDraft(db, goalId, { ...completeSpec, scope: "v3 draft" }); // invalidates approval → execution_spec_version_id = NULL

    expect(() => approveSpecVersion(db, goalId, v1.id)).toThrow(SpecApprovalError);

    expect(getSpecState(db, goalId)).toMatchObject({
      status: "changes_pending",
      execution_spec_version_id: null,
    });
    expect(assertExecutionAllowed(db, goalId)).toMatchObject({
      allowed: false,
      specStatus: "changes_pending",
      currentDraftVersion: 2,
    });
  });

  it("prevents update and delete of an approved snapshot at the database boundary", () => {
    const version = saveSpecDraft(db, goalId, completeSpec);
    approveSpecVersion(db, goalId, version.id);

    expect(() => db.prepare("UPDATE goal_spec_versions SET scope = 'tampered' WHERE id = ?").run(version.id))
      .toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM goal_spec_versions WHERE id = ?").run(version.id))
      .toThrow(/immutable/);

    db.prepare("DELETE FROM goals WHERE id = ?").run(goalId);
    expect(db.prepare("SELECT 1 FROM goal_spec_versions WHERE id = ?").get(version.id)).toBeUndefined();
  });

  it("keeps decomposition, implementation, and verification context on the approved snapshot", () => {
    const approved = saveSpecDraft(db, goalId, completeSpec);
    approveSpecVersion(db, goalId, approved.id);
    db.prepare(`
      INSERT INTO goal_specs
        (goal_id, prd_summary, feature_specs, user_flow, acceptance_criteria, tech_considerations, generated_by)
      VALUES (?, ?, '[]', '[]', '[]', '[]', 'manual')
    `).run(goalId, JSON.stringify({ scope: "unapproved legacy scope" }));

    const executionSpec = getExecutionSpec(db, goalId);
    const sharedPromptContext = formatExecutionSpecContext(executionSpec);

    expect(executionSpec).toMatchObject({ id: approved.id, scope: completeSpec.scope });
    expect(sharedPromptContext).toContain(`id: ${approved.id}`);
    expect(sharedPromptContext).toContain(`**Scope**: ${completeSpec.scope}`);
    expect(sharedPromptContext).not.toContain("unapproved legacy scope");
  });

  it("keeps the real implementation session preamble on the approved snapshot", () => {
    const approved = saveSpecDraft(db, goalId, completeSpec);
    approveSpecVersion(db, goalId, approved.id);
    db.prepare(`
      INSERT INTO goal_specs
        (goal_id, prd_summary, feature_specs, user_flow, acceptance_criteria, tech_considerations, generated_by)
      VALUES (?, ?, '[]', '[]', '[]', '[]', 'manual')
    `).run(goalId, JSON.stringify({ scope: "unapproved legacy scope" }));
    db.prepare(`
      INSERT INTO tasks (id, project_id, goal_id, title, description, priority, sort_order)
      VALUES ('task-approved-spec', 'p1', ?, 'implementation', 'task', 'medium', 1)
    `).run(goalId);
    beginExecutionRun(db, goalId);

    const { preamble } = buildSummonContext(db, "task-approved-spec");

    expect(preamble).toContain(`id: ${approved.id}`);
    expect(preamble).toContain(`**Scope**: ${completeSpec.scope}`);
    expect(preamble).not.toContain("unapproved legacy scope");
  });

  it("rejects values that cannot satisfy the shared response schema", () => {
    expect(() => saveSpecDraft(db, goalId, {
      ...completeSpec,
      expected_tasks: ["valid", 1],
    })).toThrowError(SpecApprovalError);
    expect(getSpecState(db, goalId).versions).toHaveLength(0);
  });
});
