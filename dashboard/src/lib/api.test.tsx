import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Goal Spec API response guard", () => {
  it("accepts the common state wrapper and rejects the legacy shape", async () => {
    const { parseGoalSpecState } = await import("./api");
    const missing = {
      goal_id: "g1",
      status: "missing",
      generation_status: "idle",
      generation_error: null,
      execution_spec_version_id: null,
      versions: [],
    };

    expect(parseGoalSpecState(missing)).toEqual({
      goal_id: "g1",
      status: "missing",
      execution_spec_version_id: null,
      versions: [],
      legacy_spec: null,
    });
    expect(() => parseGoalSpecState({ prd_summary: {}, feature_specs: [] })).toThrow("Invalid blueprint response");
  });

  it("projects version snapshots without unknown server fields", async () => {
    const { parseGoalSpecState } = await import("./api");
    const parsed = parseGoalSpecState({
      goal_id: "g1",
      status: "draft",
      execution_spec_version_id: null,
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
        secret_extra: "must not reach the store",
      }],
    });

    expect(parsed.versions[0]).toEqual({
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
    });
    expect(parsed.versions[0]).not.toHaveProperty("secret_extra");
  });

  it("surfaces the actionable validation message and field location", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_spec",
      message: "scope is required",
      location: "scope",
    }), { status: 400, headers: { "content-type": "application/json" } })));
    const { api } = await import("./api");

    await expect(api.goals.saveSpec("g1", {
      scope: "",
      out_of_scope: "",
      acceptance_criteria: [],
      expected_tasks: [],
      verification_methods: [],
    })).rejects.toMatchObject({
      message: "scope is required",
      code: "invalid_spec",
      location: "scope",
    });
  });

  it("rejects a response for a different goal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      goal_id: "other-goal",
      status: "missing",
      execution_spec_version_id: null,
      versions: [],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const { api } = await import("./api");

    await expect(api.goals.getSpec("requested-goal")).rejects.toThrow("Blueprint response goal_id mismatch");
  });
});

describe("Goal execution report API", () => {
  it("loads the typed project comparison response from the report endpoint", async () => {
    const response = { reports: [] } satisfies import("../../../shared/types").ProjectGoalReportsResponse;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api");

    await expect(api.projects.goalReports("p1")).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/projects/p1/goal-reports"),
      expect.any(Object),
    );
  });

  it("loads a typed goal detail response from the execution report endpoint", async () => {
    const response = {
      goalId: "g1",
      title: "Goal",
      finalStatus: "completed",
      startedAt: "2026-07-10T10:00:00.000Z",
      endedAt: "2026-07-10T10:01:00.000Z",
      durationMs: 60_000,
      providers: [{ provider: "codex", sessionCount: 1, tokens: null, costUsd: null }],
      retryCount: 0,
      failoverCount: 0,
      evaluationCount: 1,
      fixRoundCount: 0,
      finalVerdict: "pass",
      telemetry: "partial",
      agentRoles: ["reviewer"],
      history: [],
    } satisfies import("../../../shared/types").ReportDetail;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api");

    await expect(api.goals.getExecutionReport("g1")).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/goals/g1/execution-report"),
      expect.any(Object),
    );
  });
});

describe("Workspace API", () => {
  it("loads the project-scoped read model", async () => {
    const response = [{
      id: "w1",
      projectId: "p 1",
      goalId: "g1",
      activeGoalId: "g1",
      name: "Goal workspace",
      kind: "goal",
      state: "ready",
      worktreePath: "/tmp/w1",
      worktreeBranch: "agent/w1",
      baseRef: "main",
      setupStep: null,
      setupProgress: 100,
      error: null,
      pathExists: true,
      dirty: false,
      sessionCount: 1,
      activeSessionCount: 0,
      terminalSessionCount: 1,
      activeTerminalSessionCount: 1,
      createdAt: "2026-07-15 00:00:00",
      updatedAt: "2026-07-15 00:00:00",
      archivedAt: null,
    }] satisfies import("../../../shared/types").Workspace[];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api");

    await expect(api.workspaces.list("p 1")).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/workspaces?projectId=p%201"),
      expect.any(Object),
    );
  });

  it("selects the active Workspace goal", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "w1", activeGoalId: "g1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api");

    await expect(api.workspaces.selectGoal("w1", "g1")).resolves.toMatchObject({ activeGoalId: "g1" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/workspaces/w1/context"),
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ goalId: "g1" }) }),
    );
  });

  it("creates a manual Workspace and reads its inspector surfaces", async () => {
    const workspace = { id: "w-manual", state: "ready" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(workspace), {
        status: 201,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ diff: "patch", truncated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: ["README.md"], truncated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api");

    await expect(api.workspaces.create({ projectId: "p1", name: "Terminal" }))
      .resolves.toEqual(workspace);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/workspaces"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ projectId: "p1", name: "Terminal" }),
      }),
    );
    await expect(api.workspaces.getDiff("w-manual")).resolves.toEqual({ diff: "patch", truncated: false });
    await expect(api.workspaces.getFiles("w-manual")).resolves.toEqual({ files: ["README.md"], truncated: false });
  });

  it("archives a manual Workspace with an explicit dirty confirmation", async () => {
    const workspace = { id: "w-manual", state: "archived" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(workspace), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api");

    await expect(api.workspaces.archive("w manual", { confirmDirty: true })).resolves.toEqual(workspace);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/workspaces/w manual"),
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ confirmDirty: true }),
      }),
    );
  });

  it("loads goal-scoped terminal phase evidence", async () => {
    const response = [{
      id: "event-1",
      workspaceId: "w 1",
      terminalSessionId: "term-1",
      kind: "task_updated",
      goalId: "g/1",
      goalTitle: null,
      taskId: "t1",
      taskTitle: "Verify",
      status: "done",
      summary: "docs/proof.md reviewed",
      evidence: { dirty: true, changedFiles: ["docs/proof.md"], diffStat: "1 file changed" },
      createdAt: "2026-07-15 10:00:00",
    }] satisfies import("../../../shared/types").TerminalBridgeActivity[];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api");

    await expect(api.terminalBridge.events("w 1", "g/1")).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/terminal-bridge/events?workspaceId=w%201&goalId=g%2F1"),
      expect.any(Object),
    );
  });

  it("dismisses a completed terminal tab", async () => {
    const response = { status: "dismissed", terminalId: "term-1" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api");

    await expect(api.terminals.dismiss("term-1")).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/terminals/term-1/dismiss"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("Terminal task start API", () => {
  it("uses the single start-next endpoint with the selected binding", async () => {
    const response = {
      task: { id: "t1", status: "in_progress" },
      terminal: null,
      provider: "codex",
      launchKey: "term1:t1:codex",
      launchState: "requested",
    } as const;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api");

    await expect(api.terminals.startNext("term1", {
      goalId: "g1",
      agentId: "a1",
      provider: "codex",
    })).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/terminals/term1/start-next"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ goalId: "g1", agentId: "a1", provider: "codex" }),
      }),
    );
  });

  it("loads structured terminal evidence with scoped filters", async () => {
    const response = { items: [], nextCursor: null };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api");

    await expect(api.terminalActivities.list("w 1", {
      goalId: "g/1",
      terminalSessionId: "term 1",
      limit: 25,
    })).resolves.toEqual(response);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/terminal-activities?");
    expect(new URL(url, "http://localhost").searchParams.get("workspaceId")).toBe("w 1");
    expect(new URL(url, "http://localhost").searchParams.get("goalId")).toBe("g/1");
    expect(new URL(url, "http://localhost").searchParams.get("terminalSessionId")).toBe("term 1");
  });

  it("sends immutable completion evidence and runs its terminal review", async () => {
    const review = {
      id: "review-1", workspaceId: "w1", terminalSessionId: "term1", goalId: "g1", taskId: "t1",
      agentId: "a1", status: "pending", scope: "standard",
      evidence: { summary: "done", changedFiles: ["src/a.ts"], verificationCommands: ["npm test"] },
      attempt: 0, verificationId: null, findings: [], errorMessage: null, startedAt: null, completedAt: null,
      createdAt: "2026-07-16T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z",
    } satisfies import("../../../shared/types").TerminalReviewRequest;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ review, task: { id: "t1" }, terminal: null, replayed: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        started: true, stale: false, review: { ...review, status: "passed", attempt: 1 },
        task: { id: "t1", status: "done" }, terminal: null, nextReadyTask: null, hasNextReadyTask: false,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api");
    const evidence = {
      summary: "done", changedFiles: ["src/a.ts"], verificationCommands: ["npm test"],
      idempotencyKey: "completion:t1:initial",
    };

    await api.terminals.requestCompletion("term1", evidence);
    await api.terminals.verifyReview("term1", "review-1");

    expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringContaining("/terminals/term1/completion"), expect.objectContaining({
      method: "POST", body: JSON.stringify(evidence),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining("/terminals/term1/reviews/review-1/verify"), expect.objectContaining({
      method: "POST", body: JSON.stringify({ retry: false }),
    }));
  });
});
