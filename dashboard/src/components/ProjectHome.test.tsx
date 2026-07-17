// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// --- W2: loadData stale guard + refresh 프로젝트 스코프 ----------------------

const taskBase = {
  id: "t1",
  goal_id: "g1",
  project_id: "p1",
  title: "Task",
  description: "",
  assignee_id: null,
  status: "todo" as const,
  verification_id: null,
  result_summary: null,
  skip_reason: null,
  depends_on: null,
  created_at: "2026-07-16 00:00:00",
  updated_at: "2026-07-16 00:00:00",
};

describe("ProjectHome refresh 재조회 (W2)", () => {
  it("구세대 loadData 응답이 늦게 도착하면 폐기한다 (stale guard)", async () => {
    const staleTask = { ...taskBase, id: "t-stale", title: "Stale" };
    const freshTask = { ...taskBase, id: "t-fresh", title: "Fresh" };
    let resolveStale: (value: unknown) => void = () => {};
    mocks.listTasks
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }))
      .mockResolvedValue([freshTask]);
    mocks.listGoals.mockResolvedValue([]);

    render(<ProjectHome />);
    // 1세대 로드가 tasks 응답을 기다리는 사이 refresh → 2세대 로드가 먼저 완료
    window.dispatchEvent(new CustomEvent("crewdeck:refresh", { detail: {} }));
    await waitFor(() => expect(useStore.getState().tasks.map((t) => t.id)).toEqual(["t-fresh"]));

    // 1세대(구세대) 응답이 뒤늦게 도착 — 최신 상태를 덮지 않고 폐기돼야 한다
    await act(async () => { resolveStale([staleTask]); });
    expect(useStore.getState().tasks.map((t) => t.id)).toEqual(["t-fresh"]);
  });

  it("다른 프로젝트로 스코프된 refresh는 재조회하지 않는다", async () => {
    mocks.listGoals.mockResolvedValue([]);
    mocks.listTasks.mockResolvedValue([]);

    render(<ProjectHome />);
    await waitFor(() => expect(mocks.listTasks).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new CustomEvent("crewdeck:refresh", { detail: { projectId: "other-project" } }));
    await act(async () => { await Promise.resolve(); });
    expect(mocks.listTasks).toHaveBeenCalledTimes(1); // 스킵됨

    window.dispatchEvent(new CustomEvent("crewdeck:refresh", { detail: { projectId: "p1" } }));
    await waitFor(() => expect(mocks.listTasks).toHaveBeenCalledTimes(2)); // 현 프로젝트는 재조회
  });
});
