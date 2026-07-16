import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { SteeringNote } from "../../../shared/types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ko" } }),
}));

vi.mock("../lib/api", () => ({
  getApiKey: () => "test-api-key",
  api: { goals: {}, projects: {} },
}));

import { ActivityLog } from "../components/ActivityLog";
import { useLiveSessionStore } from "../stores/liveSession";
import { useWebSocket } from "./useWebSocket";

class MockWebSocket {
  static readonly OPEN = 1;
  readonly readyState = MockWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor() {
    sockets.push(this);
  }
}

const sockets: MockWebSocket[] = [];
const pendingNote: SteeringNote = {
  id: "note-1",
  goalId: "goal-1",
  content: "Keep the existing API contract",
  injected: false,
  injectedAt: null,
  injectedStep: null,
  createdAt: "2026-07-14 01:00:00",
};

function Harness() {
  useWebSocket();
  const notes = useLiveSessionStore((state) => state.notesByGoalId["goal-1"]);
  return (
    <ActivityLog
      events={[]}
      steeringNotes={notes}
      resolveSteeringStep={(step) => step === "session-step-1"
        ? { taskTitle: "Fix API contract", onClick: vi.fn() }
        : null}
    />
  );
}

beforeEach(() => {
  sockets.length = 0;
  vi.stubGlobal("WebSocket", MockWebSocket);
  useLiveSessionStore.setState({
    streamByAgentId: {},
    notesByGoalId: { "goal-1": [pendingNote] },
    loadingByGoalId: {},
    submittingByGoalId: {},
    errorByGoalId: {},
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("steering:injected WebSocket event", () => {
  it("shows the actual reflected time and step link without a refetch", () => {
    render(<Harness />);
    expect(sockets).toHaveLength(1);

    act(() => {
      sockets[0].onmessage?.({
        data: JSON.stringify({
          type: "steering:injected",
          payload: {
            goalId: "goal-1",
            injectedStep: "session-step-1",
            injectedAt: "2026-07-14 01:05:00",
            notes: [{ id: "note-1" }],
          },
        }),
      } as MessageEvent<string>);
    });

    expect(useLiveSessionStore.getState().notesByGoalId["goal-1"]?.[0]).toMatchObject({
      injected: true,
      injectedStep: "session-step-1",
      injectedAt: "2026-07-14 01:05:00",
    });
    expect(screen.getByText("반영됨")).toBeTruthy();
    expect(screen.getByText(/반영 시각:/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "→ Fix API contract" })).toBeTruthy();
  });

  it("forwards terminal evidence and review state to the active workspace", () => {
    const activityListener = vi.fn();
    const reviewListener = vi.fn();
    window.addEventListener("crewdeck:terminal-activity", activityListener);
    window.addEventListener("crewdeck:terminal-review", reviewListener);
    render(<Harness />);

    act(() => {
      sockets[0].onmessage?.({
        data: JSON.stringify({ type: "terminal:activity", payload: { id: "activity-1", workspaceId: "w1" } }),
      } as MessageEvent<string>);
      sockets[0].onmessage?.({
        data: JSON.stringify({ type: "terminal:review", payload: { id: "review-1", status: "running" } }),
      } as MessageEvent<string>);
    });

    expect(activityListener).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ id: "activity-1" }) }));
    expect(reviewListener).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ id: "review-1" }) }));
    window.removeEventListener("crewdeck:terminal-activity", activityListener);
    window.removeEventListener("crewdeck:terminal-review", reviewListener);
  });
});
