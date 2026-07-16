// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TerminalSession } from "../../../shared/types";

const mocks = vi.hoisted(() => {
  const storage = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => storage.clear(),
  };
  return {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    kill: vi.fn(),
    dismiss: vi.fn(),
    bind: vi.fn(),
    launch: vi.fn(),
    selectGoal: vi.fn(),
    wsSend: vi.fn(),
    writes: [] as string[],
  };
});

vi.mock("../lib/api", () => ({
  api: {
    terminals: {
      list: mocks.list,
      get: mocks.get,
      create: mocks.create,
      kill: mocks.kill,
      dismiss: mocks.dismiss,
      bind: mocks.bind,
      launch: mocks.launch,
    },
    workspaces: { selectGoal: mocks.selectGoal },
  },
}));
vi.mock("../hooks/useWebSocket", () => ({ wsSend: mocks.wsSend }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 120;
    rows = 32;
    loadAddon() {}
    open() {}
    focus() {}
    write(value: string) { mocks.writes.push(value); }
    writeln(value: string) { mocks.writes.push(value); }
    onData() { return { dispose() {} }; }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

import "../i18n";
import { WorkspaceTerminal } from "./WorkspaceTerminal";

const terminal = (overrides: Partial<TerminalSession> = {}): TerminalSession => ({
  id: "terminal-old",
  tabNumber: 1,
  workspaceId: "w1",
  projectId: "p1",
  shell: "/bin/zsh",
  cwd: "/tmp/workspace",
  pid: null,
  cols: 120,
  rows: 32,
  status: "interrupted",
  exitCode: null,
  output: "preserved output\r\n",
  startedAt: "2026-07-16 00:00:00",
  endedAt: "2026-07-16 00:01:00",
  backend: "pty",
  contextState: "unknown",
  goalId: null,
  goalTitle: null,
  agentId: null,
  agentName: null,
  agentRole: null,
  activeTaskId: null,
  activeTaskTitle: null,
  activeTaskStatus: null,
  provider: null,
  ...overrides,
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  mocks.writes.length = 0;
  mocks.get.mockResolvedValue(terminal());
  mocks.create.mockResolvedValue(terminal({
    id: "terminal-new",
    tabNumber: 2,
    status: "active",
    pid: 1234,
    output: "",
    endedAt: null,
  }));
  mocks.dismiss.mockResolvedValue({ status: "dismissed", terminalId: "terminal-old" });
  mocks.bind.mockImplementation(async (_id: string, data: Partial<TerminalSession>) => terminal({
    id: "terminal-connected",
    status: "active",
    contextState: "connected",
    endedAt: null,
    ...data,
  }));
  mocks.launch.mockImplementation(async (_id: string, data: { provider: "claude" | "codex" }) => ({
    status: "launched",
    runningProvider: null,
    kickoffSent: false,
    terminal: terminal({
      id: "terminal-connected",
      status: "active",
      contextState: "connected",
      endedAt: null,
      provider: data.provider,
    }),
  }));
  mocks.selectGoal.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkspaceTerminal restart recovery", () => {
  it("preserves an interrupted session and waits for explicit continuation", async () => {
    mocks.list.mockResolvedValue([terminal()]);
    render(<WorkspaceTerminal workspaceId="w1" />);

    expect(await screen.findByText("The terminal was interrupted by a server restart")).toBeTruthy();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(screen.getByRole("button", {
      name: "Terminal 1 · interrupted by server restart",
    })).toBeTruthy();
    await waitFor(() => expect(mocks.writes).toContain("preserved output\r\n"));

    fireEvent.click(screen.getByRole("button", { name: "Continue in a new terminal" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({
      workspaceId: "w1",
      cols: 120,
      rows: 32,
      forceNew: true,
    }));
    await waitFor(() => expect(screen.queryByText("The terminal was interrupted by a server restart")).toBeNull());

    fireEvent.click(screen.getByRole("button", {
      name: "Terminal 1 · interrupted by server restart",
    }));
    expect(await screen.findByText("This is preserved output from an interrupted terminal. It is read-only.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go to active terminal" }));
    await waitFor(() => expect(screen.queryByText("This is preserved output from an interrupted terminal. It is read-only.")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1 tab" }));
    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith("terminal-old"));
    expect(screen.queryByRole("button", { name: "Terminal 1 · interrupted by server restart" })).toBeNull();
    expect(screen.getByRole("button", { name: "Terminal 2 · active" })).toBeTruthy();
  });

  it("reattaches to an existing active terminal without opening another one", async () => {
    mocks.list.mockResolvedValue([terminal({
      id: "terminal-active",
      status: "active",
      pid: 1234,
      output: "active output",
      endedAt: null,
    })]);
    render(<WorkspaceTerminal workspaceId="w1" />);

    expect(await screen.findByRole("button", { name: "Terminal 1 · active" })).toBeTruthy();
    expect(screen.queryByText("The terminal was interrupted by a server restart")).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("identifies a persistent tmux-backed terminal", async () => {
    mocks.list.mockResolvedValue([terminal({
      id: "terminal-persistent",
      status: "active",
      pid: 1234,
      output: "active output",
      endedAt: null,
      backend: "tmux",
    })]);
    render(<WorkspaceTerminal workspaceId="w1" />);

    expect(await screen.findByText("PTY · tmux · xterm-256color")).toBeTruthy();
  });

  it("connects the selected goal and launches Claude through the guarded endpoint", async () => {
    mocks.list.mockResolvedValue([terminal({
      id: "terminal-connected",
      status: "active",
      contextState: "connected",
      pid: 1234,
      output: "",
      endedAt: null,
    })]);
    render(<WorkspaceTerminal workspaceId="w1" activeGoalId="g1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Claude" }));
    await waitFor(() => expect(mocks.selectGoal).toHaveBeenCalledWith("w1", "g1"));
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledWith("terminal-connected", { provider: "claude", goalId: "g1" }));
    // 서버 판정 없이 클라이언트가 PTY에 `claude`를 직접 타이핑하지 않는다.
    expect(mocks.wsSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: "terminal:input", data: "claude\r" }));
  });

  it("reuses an already running Claude session instead of retyping the command", async () => {
    mocks.list.mockResolvedValue([terminal({
      id: "terminal-connected",
      status: "active",
      contextState: "connected",
      pid: 1234,
      output: "",
      endedAt: null,
    })]);
    mocks.launch.mockResolvedValue({
      status: "already_running",
      runningProvider: "claude",
      kickoffSent: false,
      terminal: terminal({ id: "terminal-connected", status: "active", contextState: "connected", endedAt: null, provider: "claude" }),
    });
    render(<WorkspaceTerminal workspaceId="w1" activeGoalId="g1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Claude" }));
    expect((await screen.findByRole("status")).textContent).toContain("already running");
    expect(mocks.wsSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: "terminal:input", data: "claude\r" }));
  });

  it("blocks launching Claude while a Codex session is running", async () => {
    mocks.list.mockResolvedValue([terminal({
      id: "terminal-connected",
      status: "active",
      contextState: "connected",
      pid: 1234,
      output: "",
      endedAt: null,
    })]);
    mocks.launch.mockResolvedValue({
      status: "conflict",
      runningProvider: "codex",
      kickoffSent: false,
      terminal: terminal({ id: "terminal-connected", status: "active", contextState: "connected", endedAt: null }),
    });
    render(<WorkspaceTerminal workspaceId="w1" activeGoalId="g1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Claude" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Codex");
    expect(mocks.wsSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: "terminal:input", data: "claude\r" }));
  });

  it("blocks AI launch when terminal context does not match", async () => {
    mocks.list.mockResolvedValue([terminal({
      id: "terminal-mismatch",
      status: "active",
      contextState: "mismatch",
      pid: 1234,
      output: "",
      endedAt: null,
    })]);
    render(<WorkspaceTerminal workspaceId="w1" activeGoalId="g1" />);

    const claude = await screen.findByRole("button", { name: "Claude" });
    expect(claude).toHaveProperty("disabled", true);
    expect((await screen.findByRole("alert")).textContent).toContain("different project or Workspace");
    expect(mocks.selectGoal).not.toHaveBeenCalled();
  });
});
