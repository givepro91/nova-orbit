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
  activities: vi.fn(),
  reviews: vi.fn(),
  requestCompletion: vi.fn(),
  verifyReview: vi.fn(),
  getTerminal: vi.fn(),
  startNext: vi.fn(),
  bind: vi.fn(),
  createTerminal: vi.fn(),
  resume: vi.fn(),
  addAgentProps: null as { goal?: { id: string; title: string } | null } | null,
  session: null as TerminalSession | null,
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()), // 실제 ApiError 등 보존, api 만 오버라이드
  api: {
    workspaces: { selectGoal: mocks.selectGoal },
    orchestration: { decomposeGoal: mocks.decomposeGoal, startQueue: mocks.startQueue },
    projects: { update: mocks.updateProject },
    tasks: { create: mocks.createTask },
    terminalActivities: { list: mocks.activities },
    terminals: {
      decisions: mocks.decisions,
      reviews: mocks.reviews,
      requestCompletion: mocks.requestCompletion,
      verifyReview: mocks.verifyReview,
      get: mocks.getTerminal,
      startNext: mocks.startNext,
      bind: mocks.bind,
      create: mocks.createTerminal,
      resume: mocks.resume,
    },
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
      onSessionChange?.(mocks.session ?? {
        id: "term1", tabNumber: 1, workspaceId: "w1", projectId: "p1", shell: "/bin/zsh", cwd: "/tmp/w1",
        pid: 1, cols: 120, rows: 32, status: "active", exitCode: null, output: "", startedAt: "now", endedAt: null,
        backend: "tmux", contextState: "connected", goalId: "g1", goalTitle: "Selected goal", agentId: "a1",
        agentName: "Frontend", agentRole: "frontend", activeTaskId: null, activeTaskTitle: null, activeTaskStatus: null,
        provider: null, resumeState: null,
      });
    }}>Local terminal surface</button>
  ),
}));
vi.mock("./InspectorTabs", () => ({ InspectorTabs: () => <div>Crewdeck inspector</div> }));
vi.mock("./WorkspaceGoalComposer", () => ({ WorkspaceGoalComposer: () => <div>Goal composer opened</div> }));
vi.mock("./WorkspaceTaskGraph", () => ({ WorkspaceTaskGraph: () => <div>Execution plan opened</div> }));
vi.mock("./AddAgentDialog", () => ({ AddAgentDialog: (props: { goal?: { id: string; title: string } | null }) => {
  mocks.addAgentProps = props;
  return <div>Add agent opened</div>;
} }));
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
  mocks.activities.mockResolvedValue({ items: [], nextCursor: null });
  mocks.reviews.mockResolvedValue([]);
  mocks.session = null;
  mocks.addAgentProps = null;
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
    provider: "codex", resumeState: null,
  });
  mocks.getTerminal.mockResolvedValue(mocks.bind.mock.results[0]?.value);
  mocks.resume.mockResolvedValue({ status: "resumed", resumeState: null, terminal: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SessionWorkspace orchestration controls", () => {
  it("keeps compact execution and decision controls keyboard reachable", async () => {
    const onClose = vi.fn();
    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId="g1" onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: "Project" })).toBeTruthy();
    const execution = screen.getByRole("button", { name: "Goal execution map" });
    fireEvent.click(execution);
    const closeExecution = screen.getByRole("button", { name: "Close Goal execution map" });
    await waitFor(() => expect(document.activeElement).toBe(closeExecution));
    fireEvent.click(closeExecution);
    await waitFor(() => expect(document.activeElement).toBe(execution));

    const decisions = screen.getByRole("button", { name: "Needs my decision" });
    fireEvent.click(decisions);
    const closeDecisions = screen.getByRole("button", { name: "Close Needs my decision" });
    await waitFor(() => expect(document.activeElement).toBe(closeDecisions));
    fireEvent.keyDown(closeDecisions, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(decisions));

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Project" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("exposes goal creation, blueprint, task splitting, and agent organization controls", async () => {
    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId="g1" onClose={() => {}} />);

    expect(screen.getByText("Local terminal surface")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create a new goal" }));
    expect(await screen.findByText("Goal composer opened")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    expect(await screen.findByText("Add agent opened")).toBeTruthy();
    expect(mocks.addAgentProps?.goal).toEqual({ id: "g1", title: "Selected goal", description: "" });

    fireEvent.click(screen.getByRole("button", { name: "Edit organization" }));
    expect(await screen.findByText("Organization editor opened")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(await screen.findByText("Blueprint opened")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Execution plan" }));
    expect(await screen.findByText("Execution plan opened")).toBeTruthy();
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
      taskId: "t1",
      goalId: "g1",
      agentId: "a1",
      provider: null,
    }));
  });

  it("shows a neutral background notice — not a red error — when the task is already running headless", async () => {
    const { ApiError } = await import("../lib/api");
    mocks.startNext.mockRejectedValueOnce(
      new ApiError(
        "Task is running in the background — attach it to a terminal after that run finishes",
        409, undefined, undefined, undefined, { code: "task_running_headless" },
      ),
    );
    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId="g1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Local terminal surface" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start next task" }));

    // "continue in this terminal" 은 안내 문구에만 있고 서버 에러 원문엔 없다 → 안내를 정확히 지목.
    const notice = await screen.findByText(/continue in this terminal/i);
    expect(notice.closest('[role="status"]')).not.toBeNull(); // 정보 배너(status)
    expect(notice.closest('[role="alert"]')).toBeNull();       // 빨간 에러 배너(alert)가 아니다
  });

  it("spawns a separate terminal for the next task when it belongs to a different agent", async () => {
    useStore.setState({
      agents: [
        { id: "a1", project_id: "p1", name: "Frontend", role: "frontend", status: "idle", current_task_id: null, current_activity: null },
        { id: "a2", project_id: "p1", name: "Reviewer", role: "reviewer", status: "idle", current_task_id: null, current_activity: null },
      ],
      tasks: [
        { id: "t1", goal_id: "g1", project_id: "p1", title: "Implement", description: "", assignee_id: "a1", status: "done", verification_id: null },
        { id: "t2", goal_id: "g1", project_id: "p1", title: "Adversarial review", description: "", assignee_id: "a2", status: "todo", verification_id: null },
      ],
    });
    const spawned = {
      id: "term2", tabNumber: 2, workspaceId: "w1", projectId: "p1", shell: "/bin/zsh", cwd: "/tmp/w1",
      pid: 2, cols: 120, rows: 32, status: "active", exitCode: null, output: "", startedAt: "now", endedAt: null,
      backend: "tmux", contextState: "connected", goalId: "g1", goalTitle: "Selected goal", agentId: null,
      agentName: null, agentRole: null, activeTaskId: null, activeTaskTitle: null, activeTaskStatus: null, provider: null,
      resumeState: null,
    } satisfies TerminalSession;
    mocks.createTerminal.mockResolvedValue(spawned);

    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId="g1" onClose={() => {}} />);
    // selectedTerminal = a1-bound terminal (via mock terminal surface).
    fireEvent.click(screen.getByRole("button", { name: "Local terminal surface" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start next task" }));

    // 다음 ready 태스크(t2)는 다른 에이전트(a2) → a1 터미널 재사용 대신 새 터미널을 띄운다.
    await waitFor(() => expect(mocks.createTerminal).toHaveBeenCalledWith({ workspaceId: "w1", cols: 120, rows: 32, forceNew: true }));
    await waitFor(() => expect(mocks.startNext).toHaveBeenCalledWith("term2", {
      taskId: "t2",
      goalId: "g1",
      agentId: "a2",
      provider: null,
    }));
  });

  it("keeps the start action available for a todo task bound from the execution map", async () => {
    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId="g1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Local terminal surface" }));

    fireEvent.click(screen.getByRole("button", { name: /Implement/ }));

    expect(await screen.findByRole("button", { name: "Start next task" })).toBeTruthy();
  });

  it("starts the exact task from the task row action", async () => {
    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId="g1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Local terminal surface" }));

    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    await waitFor(() => expect(mocks.startNext).toHaveBeenCalledWith("term1", {
      taskId: "t1",
      goalId: "g1",
      agentId: "a1",
      provider: null,
    }));
  });

  it("prevents duplicate starts while the primary action is pending", async () => {
    let finishStart: ((value: unknown) => void) | undefined;
    mocks.startNext.mockReturnValue(new Promise((resolve) => { finishStart = resolve; }));
    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId="g1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Local terminal surface" }));

    const start = await screen.findByRole("button", { name: "Start next task" });
    fireEvent.click(start);
    fireEvent.click(start);

    // 첫 클릭이 actionBusy를 걸어 버튼이 비활성화되므로 두 번째 클릭은 no-op.
    // 라우팅이 startTask 경유라 실제 startNext 호출은 마이크로태스크 1홉 뒤 — waitFor로 확인.
    await waitFor(() => expect(mocks.startNext).toHaveBeenCalledTimes(1));
    finishStart?.({
      task: { id: "t1", status: "in_progress" }, terminal: null, provider: "claude",
      launchKey: "term1:t1:claude", launchState: "requested",
    });
    await waitFor(() => expect(start).toHaveProperty("disabled", false));
  });

  it("freezes reported evidence and starts the terminal Quality Gate loop", async () => {
    const review = {
      id: "review-1", workspaceId: "w1", terminalSessionId: "term1", goalId: "g1", taskId: "t1",
      agentId: "a1", status: "pending", scope: "standard",
      evidence: { summary: "ready", changedFiles: ["src/App.tsx"], verificationCommands: ["npm test"] },
      attempt: 0, verificationId: null, findings: [], errorMessage: null, startedAt: null, completedAt: null,
      createdAt: "2026-07-16T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z",
    } as const;
    const activeSession = {
      id: "term1", tabNumber: 1, workspaceId: "w1", projectId: "p1", shell: "/bin/zsh", cwd: "/tmp/w1",
      pid: 1, cols: 120, rows: 32, status: "active", exitCode: null, output: "", startedAt: "now", endedAt: null,
      backend: "tmux", contextState: "connected", goalId: "g1", goalTitle: "Selected goal", agentId: "a1",
      agentName: "Frontend", agentRole: "frontend", activeTaskId: "t1", activeTaskTitle: "Implement",
      activeTaskStatus: "in_progress", provider: "codex", resumeState: null,
    } satisfies TerminalSession;
    mocks.session = activeSession;
    useStore.setState({ tasks: [{
      id: "t1", goal_id: "g1", project_id: "p1", title: "Implement", description: "", assignee_id: "a1",
      status: "in_progress", verification_id: null,
    }] });
    mocks.activities.mockResolvedValue({
      items: [
        { id: "e1", taskId: "t1", kind: "file_changed", metadata: { path: "src/App.tsx" } },
        { id: "e2", taskId: "t1", kind: "verification_run", metadata: { command: "npm test" } },
      ],
      nextCursor: null,
    });
    mocks.requestCompletion.mockResolvedValue({ review, task: { id: "t1", status: "in_review" }, terminal: activeSession, replayed: false });
    mocks.verifyReview.mockResolvedValue({
      started: true, stale: false, review: { ...review, status: "passed", attempt: 1 },
      task: { id: "t1", status: "done" }, terminal: activeSession, nextReadyTask: null, hasNextReadyTask: false,
    });
    mocks.getTerminal.mockResolvedValue({ ...activeSession, activeTaskStatus: "done" });

    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId="g1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Local terminal surface" }));
    await waitFor(() => expect(mocks.activities).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Request review" }));

    await waitFor(() => expect(mocks.requestCompletion).toHaveBeenCalledWith("term1", expect.objectContaining({
      changedFiles: ["src/App.tsx"],
      verificationCommands: ["npm test"],
      idempotencyKey: "completion:t1:initial",
    })));
    await waitFor(() => expect(mocks.verifyReview).toHaveBeenCalledWith("term1", "review-1", false));
  });

  it("shows a resume affordance for a wedged terminal and resumes it on click", async () => {
    mocks.session = {
      id: "term1", tabNumber: 1, workspaceId: "w1", projectId: "p1", shell: "/bin/zsh", cwd: "/tmp/w1",
      pid: 1, cols: 120, rows: 32, status: "active", exitCode: null, output: "", startedAt: "now", endedAt: null,
      backend: "tmux", contextState: "connected", goalId: "g1", goalTitle: "Selected goal", agentId: "a1",
      agentName: "Frontend", agentRole: "frontend", activeTaskId: null, activeTaskTitle: null, activeTaskStatus: null,
      provider: null, resumeState: "idle",
    } satisfies TerminalSession;

    render(<SessionWorkspace workspaceId="w1" workspaceName="Workspace" goalId="g1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Local terminal surface" }));

    expect(await screen.findByText("No response")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith("term1", { force: false }));
  });
});
