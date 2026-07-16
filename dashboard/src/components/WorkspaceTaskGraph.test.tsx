// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TaskGraphResponse } from "../lib/api";

vi.hoisted(() => {
  const storage = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => storage.clear(),
  };
});

const mocks = vi.hoisted(() => ({
  getGraph: vi.fn(),
  updateGraph: vi.fn(),
  decomposeGoal: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    tasks: { getGraph: mocks.getGraph, updateGraph: mocks.updateGraph },
    orchestration: { decomposeGoal: mocks.decomposeGoal },
  },
}));

import "../i18n";
import { WorkspaceTaskGraph } from "./WorkspaceTaskGraph";

const graph: TaskGraphResponse = {
  goal: { id: "g1", project_id: "p1", title: "Ship editor", description: "Make planning operational", priority: "high", progress: 0 },
  plan: {
    status: "approved",
    version_id: "v1",
    version: 1,
    scope: "Edit the same task graph used by orchestration",
    acceptance_criteria: ["Dependencies are honest"],
    expected_tasks: ["Contract", "UI"],
    verification_methods: ["Component test"],
  },
  tasks: [
    {
      id: "t1", goal_id: "g1", project_id: "p1", title: "Contract", description: "API", assignee_id: "a1",
      status: "done", priority: "high", sort_order: 0, depends_on: [], blocked_by: [], execution_state: "complete",
    },
    {
      id: "t2", goal_id: "g1", project_id: "p1", title: "UI", description: "Editor", assignee_id: null,
      status: "todo", priority: "medium", sort_order: 1, depends_on: ["t1"], blocked_by: [], execution_state: "ready",
    },
  ],
};

beforeEach(() => {
  mocks.getGraph.mockResolvedValue(structuredClone(graph));
  mocks.updateGraph.mockImplementation(async (_goalId: string, tasks: Array<Record<string, unknown>>) => ({
    ...structuredClone(graph),
    tasks: graph.tasks.map((task) => ({ ...task, ...(tasks.find((edit) => edit.id === task.id) ?? {}) })),
  }));
  mocks.decomposeGoal.mockResolvedValue({ taskCount: 2 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceTaskGraph", () => {
  it("shows blueprint context, execution readiness, and saves the orchestration task SoT", async () => {
    const onChanged = vi.fn();
    render(
      <WorkspaceTaskGraph
        goalId="g1"
        agents={[{ id: "a1", name: "Builder", role: "coder" }, { id: "a2", name: "Reviewer", role: "reviewer" }]}
        onClose={() => {}}
        onOpenBlueprint={() => {}}
        onChanged={onChanged}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Edit goal execution plan" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" })));
    expect(await screen.findByText("Edit the same task graph used by orchestration")).toBeTruthy();
    expect(screen.getByText("Ready to start")).toBeTruthy();
    expect(screen.getByText("Complete")).toBeTruthy();

    const titles = screen.getAllByLabelText("Task name");
    fireEvent.change(titles[1], { target: { value: "Workspace editor" } });
    const assignees = screen.getAllByLabelText("Assigned agent");
    fireEvent.change(assignees[1], { target: { value: "a2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(mocks.updateGraph).toHaveBeenCalledWith("g1", expect.arrayContaining([
      expect.objectContaining({ id: "t2", title: "Workspace editor", assignee_id: "a2", depends_on: ["t1"] }),
    ])));
    expect(onChanged).toHaveBeenCalled();
  });

  it("re-splits an existing plan only after confirmation and reloads the graph", async () => {
    render(
      <WorkspaceTaskGraph
        goalId="g1"
        agents={[]}
        onClose={() => {}}
        onOpenBlueprint={() => {}}
        onChanged={() => {}}
      />,
    );
    await screen.findByText("Contract");

    fireEvent.click(screen.getByRole("button", { name: "Re-split Tasks" }));
    expect(mocks.decomposeGoal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(mocks.decomposeGoal).toHaveBeenCalledWith("g1"));
    await waitFor(() => expect(mocks.getGraph).toHaveBeenCalledTimes(2));
  });
});
