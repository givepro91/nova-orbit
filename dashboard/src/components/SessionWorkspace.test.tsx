// @vitest-environment jsdom
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
  claimNext: vi.fn(),
  launch: vi.fn(),
  terminalSession: {
    id: "term1", tabNumber: 1, workspaceId: "w1", projectId: "p1", shell: "/bin/zsh", cwd: "/tmp/w1",
    pid: 10, cols: 120, rows: 32, status: "active", exitCode: null, output: "", startedAt: "now", endedAt: null,
    backend: "pty", contextState: "connected", goalId: "g1", goalTitle: "Selected goal", agentId: null, agentName: null,
    agentRole: null, activeTaskId: null, activeTaskTitle: null, activeTaskStatus: null, provider: null,
  },
}));

vi.mock("../lib/api", () => ({
  api: {
    workspaces: { selectGoal: mocks.selectGoal },
    orchestration: { decomposeGoal: mocks.decomposeGoal, startQueue: mocks.startQueue },
    projects: { update: mocks.updateProject },
    tasks: { create: mocks.createTask },
    terminals: { decisions: mocks.decisions, claimNext: mocks.claimNext, launch: mocks.launch },
  },
}));
vi.mock("./WorkspaceTerminal", () => ({
  WorkspaceTerminal: (props: { onSessionChange?: (session: unknown) => void }) => {
    useEffect(() => { props.onSessionChange?.(mocks.terminalSession); }, [props]);
    return <div>Local terminal surface</div>;
  },
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
});

describe("SessionWorkspace claim kickoff", () => {
  it("confirms the kickoff was delivered to the running agent session", async () => {
    mocks.claimNext.mockResolvedValue({
      task: { id: "t1", project_id: "p1" },
      terminal: { ...mocks.terminalSession, activeTaskId: "t1", activeTaskTitle: "Implement", activeTaskStatus: "in_progress" },
      kickoff: { status: "sent", provider: "claude" },
    });
    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId="g1" onClose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Claim next task" }));

    await waitFor(() => expect(mocks.claimNext).toHaveBeenCalledWith("term1", {
      goalId: "g1",
      agentId: null,
      provider: null,
    }));
    expect((await screen.findByRole("status")).textContent).toContain("Kickoff sent to the Claude session");
  });

  it("offers to start an agent with the kickoff when only a shell is running", async () => {
    mocks.claimNext.mockResolvedValue({
      task: { id: "t1", project_id: "p1" },
      terminal: { ...mocks.terminalSession, activeTaskId: "t1", activeTaskTitle: "Implement", activeTaskStatus: "in_progress" },
      kickoff: { status: "agent_not_running", provider: null },
    });
    mocks.launch.mockResolvedValue({
      status: "launched",
      runningProvider: null,
      kickoffSent: true,
      terminal: { ...mocks.terminalSession, activeTaskId: "t1", activeTaskTitle: "Implement", activeTaskStatus: "in_progress", provider: "claude" },
    });
    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId="g1" onClose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Claim next task" }));

    expect((await screen.findByRole("status")).textContent).toContain("No AI session is running in this terminal");
    fireEvent.click(screen.getByRole("button", { name: /Start Claude \+ kick off/ }));

    await waitFor(() => expect(mocks.launch).toHaveBeenCalledWith("term1", {
      provider: "claude",
      goalId: "g1",
      kickoff: true,
    }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Kickoff sent to the Claude session"));
  });

  it("surfaces a kickoff delivery failure with a dismissible alert", async () => {
    mocks.claimNext.mockResolvedValue({
      task: { id: "t1", project_id: "p1" },
      terminal: { ...mocks.terminalSession, activeTaskId: "t1", activeTaskTitle: "Implement", activeTaskStatus: "in_progress" },
      kickoff: { status: "failed", provider: "claude" },
    });
    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId="g1" onClose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Claim next task" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not deliver the kickoff");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss kickoff notice" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
