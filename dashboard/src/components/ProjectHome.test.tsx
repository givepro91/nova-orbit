// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GoalListItem } from "../lib/api";

const mocks = vi.hoisted(() => {
  const storage = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => storage.clear(),
  };
  return {
    goals: [] as GoalListItem[],
    listAgents: vi.fn(),
    listGoals: vi.fn(),
    listTasks: vi.fn(),
    queueStatus: vi.fn(),
    designStatus: vi.fn(),
    decomposeGoal: vi.fn(),
  };
});

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      agents: { ...actual.api.agents, list: mocks.listAgents, designStatus: mocks.designStatus },
      goals: { ...actual.api.goals, list: mocks.listGoals },
      tasks: { ...actual.api.tasks, list: mocks.listTasks },
      orchestration: { ...actual.api.orchestration, queueStatus: mocks.queueStatus, decomposeGoal: mocks.decomposeGoal },
    },
  };
});

vi.mock("./GoalSpecPanel", () => ({
  default: ({ goalId }: { goalId: string }) => <div role="dialog">blueprint:{goalId}</div>,
}));
vi.mock("./OrgChart", () => ({ OrgChart: () => null, parseActivity: (value: string) => value, getCtoPhase: () => null }));
vi.mock("./TaskTimeline", () => ({ TaskTimeline: () => null }));
vi.mock("./ProjectStats", () => ({ ProjectStats: () => null }));
vi.mock("./TaskList", () => ({ TaskList: () => null }));
vi.mock("./ActivityFeed", () => ({ ActivityFeed: () => null }));

import "../i18n";
import { ProjectHome } from "./ProjectHome";
import { useStore } from "../stores/useStore";

const baseGoal: GoalListItem = {
  id: "g1",
  project_id: "p1",
  title: "Approval gate",
  description: "Approval gate",
  references: "[]",
  priority: "medium",
  progress: 0,
  goal_model: "goal_as_unit",
  squash_status: "none",
  squash_commit_sha: null,
  acceptance_script: null,
  qa_regression_task_id: null,
  worktree_path: null,
  worktree_branch: null,
  has_spec: 0,
  execution_spec_version_id: null,
  spec_approval_required: 1,
  merge_outcome: null,
  pr_url: null,
  pr_number: null,
  pr_state: null,
  pr_state_checked_at: null,
};

async function renderGoal(goal: GoalListItem) {
  mocks.goals = [goal];
  mocks.listGoals.mockResolvedValue(mocks.goals);
  render(<ProjectHome />);
  await waitFor(() => expect(screen.getByText("Approval gate")).toBeTruthy());
}

beforeEach(() => {
  mocks.listAgents.mockResolvedValue([]);
  mocks.listTasks.mockResolvedValue([]);
  mocks.queueStatus.mockResolvedValue({ running: false, paused: false, maxConcurrency: 0, rateLimitRetries: 0, nextRetryAt: null });
  mocks.designStatus.mockResolvedValue({ running: false, ready: false });
  mocks.decomposeGoal.mockResolvedValue({ status: "decomposing", goalId: "g1" });
  useStore.setState({
    projects: [{ id: "p1", name: "Test", mission: "", source: "new", status: "active", workdir: "", created_at: "2026-07-12" }],
    currentProjectId: "p1",
    agents: [],
    goals: [],
    tasks: [],
    connected: false,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectHome goal blueprint action", () => {
  it("shows create only when no legacy or versioned blueprint exists", async () => {
    await renderGoal(baseGoal);
    expect(screen.getByRole("button", { name: "Generate Blueprint" })).toBeTruthy();
  });

  it.each([
    // 미승인 draft(실행 기준 미고정)는 눈에 띄는 "Approve" CTA, 승인본은 조용한 "View Blueprint"
    ["unapproved versioned draft", null, "Approve"],
    ["approved version", "approved-v1", "View Blueprint"],
  ])("shows the blueprint action for an %s and opens that goal's panel", async (_label, executionSpecVersionId, buttonName) => {
    await renderGoal({ ...baseGoal, has_spec: 1, execution_spec_version_id: executionSpecVersionId });
    const action = screen.getByRole("button", { name: buttonName });
    fireEvent.click(action);
    expect(screen.getByRole("dialog").textContent).toBe("blueprint:g1");
  });

  it("opens approval without requesting task split when the current blueprint is unapproved", async () => {
    await renderGoal(baseGoal);
    fireEvent.click(screen.getByRole("button", { name: "Split into Tasks" }));
    expect(screen.getByRole("dialog").textContent).toBe("blueprint:g1");
    expect(mocks.decomposeGoal).not.toHaveBeenCalled();
  });
});
