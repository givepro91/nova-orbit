// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TerminalSession } from "../../../shared/types";

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
  selectGoal: vi.fn(),
  decomposeGoal: vi.fn(),
  startQueue: vi.fn(),
  updateProject: vi.fn(),
  createTask: vi.fn(),
  decisions: vi.fn(),
  startNext: vi.fn(),
  bind: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    workspaces: { selectGoal: mocks.selectGoal },
    orchestration: { decomposeGoal: mocks.decomposeGoal, startQueue: mocks.startQueue },
    projects: { update: mocks.updateProject },
    tasks: { create: mocks.createTask },
    terminals: { decisions: mocks.decisions, startNext: mocks.startNext, bind: mocks.bind },
  },
}));
vi.mock("./WorkspaceTerminal", () => ({
  WorkspaceTerminal: ({
    onContextStateChange,
    onSessionChange,
  }: {
    onContextStateChange?: (state: TerminalSession["contextState"]) => void;
    onSessionChange?: (session: TerminalSession) => void;
  }) => (
    <button type="button" onClick={() => {
      onContextStateChange?.("connected");
      onSessionChange?.({
        id: "term1", tabNumber: 1, workspaceId: "w1", projectId: "p1", shell: "/bin/zsh", cwd: "/tmp/w1",
        pid: 1, cols: 120, rows: 32, status: "active", exitCode: null, output: "", startedAt: "now", endedAt: null,
        backend: "tmux", contextState: "connected", goalId: "g1", goalTitle: "Selected goal", agentId: "a1",
        agentName: "Frontend", agentRole: "frontend", activeTaskId: null, activeTaskTitle: null, activeTaskStatus: null,
        provider: null,
      });
    }}>Local terminal surface</button>
  ),
}));
vi.mock("./InspectorTabs", () => ({ InspectorTabs: () => <div>Crewdeck inspector</div> }));
vi.mock("./WorkspaceGoalComposer", () => ({ WorkspaceGoalComposer: () => <div>Goal composer opened</div> }));
vi.mock("./AddAgentDialog", () => ({ AddAgentDialog: () => <div>Add agent opened</div> }));
vi.mock("./AgentDetail", () => ({ AgentDetail: () => <div>Agent detail opened</div> }));
vi.mock("./OrgChart", () => ({ OrgChart: () => <div>Organization editor opened</div> }));
vi.mock("./GoalSpecPanel", () => ({ default: () => <div>Blueprint opened</div> }));

import "../i18n";
import { useStore } from "../stores/useStore";
import { SessionWorkspace } from "./SessionWorkspace";

beforeEach(() => {
  useStore.setState({
    projects: [{ id: "p1", name: "Project", mission: "Ship", source: "new", status: "active", workdir: "/tmp", created_at: "now", autopilot: "off" }],
    currentProjectId: "p1",
    workspaces: [{
      id: "w1", projectId: "p1", goalId: null, activeGoalId: "g1", name: "Workspace", kind: "manual", state: "ready",
      worktreePath: "/tmp/w1", worktreeBranch: "workspace/w1", baseRef: "main", setupStep: null, setupProgress: 100,
      error: null, pathExists: true, dirty: false, sessionCount: 0, activeSessionCount: 0, terminalSessionCount: 1,
      activeTerminalSessionCount: 1, createdAt: "now", updatedAt: "now", archivedAt: null,
    }],
    agents: [{ id: "a1", project_id: "p1", name: "Frontend", role: "frontend", status: "idle", current_task_id: null, current_activity: null }],
    goals: [{
      id: "g1", project_id: "p1", title: "Selected goal", description: "", references: "[]", priority: "medium", progress: 0,
      goal_model: "goal_as_unit", squash_status: "none", squash_commit_sha: null, acceptance_script: null, qa_regression_task_id: null,
      worktree_path: null, worktree_branch: null, has_spec: 1, execution_spec_version_id: "v1", spec_approval_required: 1,
      merge_outcome: null, pr_url: null, pr_number: null, pr_state: null, pr_state_checked_at: null,
    }],
    tasks: [{ id: "t1", goal_id: "g1", project_id: "p1", title: "Implement", description: "", assignee_id: "a1", status: "todo", verification_id: null }],
  });
  mocks.selectGoal.mockResolvedValue({});
  mocks.decisions.mockResolvedValue([]);
  mocks.startNext.mockResolvedValue({
    task: { id: "t1", status: "in_progress" },
    terminal: null,
    provider: "claude",
    launchKey: "term1:t1:claude",
    launchState: "requested",
  });
  mocks.bind.mockResolvedValue({
    id: "term1", tabNumber: 1, workspaceId: "w1", projectId: "p1", shell: "/bin/zsh", cwd: "/tmp/w1",
    pid: 1, cols: 120, rows: 32, status: "active", exitCode: null, output: "", startedAt: "now", endedAt: null,
    backend: "tmux", contextState: "connected", goalId: "g1", goalTitle: "Selected goal", agentId: "a1",
    agentName: "Frontend", agentRole: "frontend", activeTaskId: "t1", activeTaskTitle: "Implement", activeTaskStatus: "todo",
    provider: "codex",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SessionWorkspace orchestration controls", () => {
  it("exposes goal creation, blueprint, task splitting, and agent organization controls", async () => {
    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId="g1" onClose={() => {}} />);

    expect(screen.getByText("Local terminal surface")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create a new goal" }));
    expect(await screen.findByText("Goal composer opened")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    expect(await screen.findByText("Add agent opened")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit organization" }));
    expect(await screen.findByText("Organization editor opened")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(await screen.findByText("Blueprint opened")).toBeTruthy();
  });

  it("persists the selected goal as terminal context", async () => {
    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId={null} onClose={() => {}} />);

    fireEvent.change(await screen.findByRole("combobox", { name: "Goals" }), { target: { value: "g1" } });
    await waitFor(() => expect(mocks.selectGoal).toHaveBeenCalledWith("w1", "g1"));
  });

  it("starts the next task and provider through one primary action", async () => {
    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId="g1" onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Local terminal surface" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start next task" }));

    await waitFor(() => expect(mocks.startNext).toHaveBeenCalledWith("term1", {
      goalId: "g1",
      agentId: "a1",
      provider: null,
    }));
  });

  it("keeps the start action available for a todo task bound from the execution map", async () => {
    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId="g1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Local terminal surface" }));

    fireEvent.click(screen.getByRole("button", { name: /Implement/ }));

    expect(await screen.findByRole("button", { name: "Start next task" })).toBeTruthy();
  });

  it("prevents duplicate starts while the primary action is pending", async () => {
    let finishStart: ((value: unknown) => void) | undefined;
    mocks.startNext.mockReturnValue(new Promise((resolve) => { finishStart = resolve; }));
    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId="g1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Local terminal surface" }));

    const start = await screen.findByRole("button", { name: "Start next task" });
    fireEvent.click(start);
    fireEvent.click(start);

    expect(mocks.startNext).toHaveBeenCalledTimes(1);
    finishStart?.({
      task: { id: "t1", status: "in_progress" }, terminal: null, provider: "claude",
      launchKey: "term1:t1:claude", launchState: "requested",
    });
    await waitFor(() => expect(start).toHaveProperty("disabled", false));
  });
});
