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
    open(host: HTMLElement) { host.appendChild(document.createElement("textarea")); }
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
  mocks.selectGoal.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkspaceTerminal restart recovery", () => {
  it("exposes terminal tabs, controls, input, and status with stable accessible names", async () => {
    mocks.list.mockResolvedValue([terminal({
      id: "terminal-active",
      status: "active",
      contextState: "connected",
      pid: 1234,
      output: "",
      endedAt: null,
    })]);
    render(<WorkspaceTerminal workspaceId="w1" activeGoalId="g1" />);

    expect((await screen.findByRole("tab", { name: "Terminal 1 · active" })).getAttribute("aria-selected")).toBe("true");
    expect((await screen.findByRole("textbox", { name: "Local terminal" })).getAttribute("aria-multiline")).toBe("true");
    expect(screen.getByRole("button", { name: "New terminal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop terminal" })).toBeTruthy();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });

  it("preserves an interrupted session and waits for explicit continuation", async () => {
    mocks.list.mockResolvedValue([terminal()]);
    render(<WorkspaceTerminal workspaceId="w1" />);

    expect(await screen.findByText("The terminal was interrupted by a server restart")).toBeTruthy();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", {
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

    fireEvent.click(screen.getByRole("tab", {
      name: "Terminal 1 · interrupted by server restart",
    }));
    expect(await screen.findByText("This is preserved output from an interrupted terminal. It is read-only.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go to active terminal" }));
    await waitFor(() => expect(screen.queryByText("This is preserved output from an interrupted terminal. It is read-only.")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1 tab" }));
    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith("terminal-old"));
    expect(screen.queryByRole("tab", { name: "Terminal 1 · interrupted by server restart" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Terminal 2 · active" })).toBeTruthy();
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

    expect(await screen.findByRole("tab", { name: "Terminal 1 · active" })).toBeTruthy();
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

  it("connects the selected goal before launching Claude", async () => {
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
    expect(mocks.wsSend).toHaveBeenCalledWith(expect.objectContaining({
      type: "terminal:input",
      terminalId: "terminal-connected",
      data: "claude\r",
    }));
  });

  it("keeps direct provider launch as an explicit retry fallback", async () => {
    mocks.list.mockResolvedValue([terminal({
      id: "terminal-connected",
      status: "active",
      contextState: "connected",
      pid: 1234,
      output: "",
      endedAt: null,
      provider: "claude",
    })]);
    render(<WorkspaceTerminal workspaceId="w1" activeGoalId="g1" />);

    const claude = await screen.findByRole("button", { name: "Claude" });
    fireEvent.click(claude);
    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledWith(expect.objectContaining({ data: "claude\r" })));
    mocks.wsSend.mockClear();

    // The primary start action is idempotent. This advanced button intentionally
    // remains available after the provider exits back to the shell.
    fireEvent.click(claude);
    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledWith(expect.objectContaining({ data: "claude\r" })));
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
