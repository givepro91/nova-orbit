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
import { _resetRealtimeStateForTests, useWebSocket, wsSend } from "./useWebSocket";

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

// --- W2: 실시간 계층 코어 ---------------------------------------------------

function WsOnly() {
  useWebSocket();
  return null;
}

function wsMsg(body: Record<string, unknown>): MessageEvent<string> {
  return { data: JSON.stringify(body) } as MessageEvent<string>;
}

describe("W2 재연결 복구 (구독 replay + 전역 refresh 1회)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetRealtimeStateForTests();
  });

  afterEach(() => {
    cleanup(); // 훅 언마운트 → 디바운스 타이머 정리까지 fake timer 안에서 수행
    vi.useRealTimers();
  });

  it("connected 수신 시 구독 replay는 무조건(최초 포함), refresh는 재연결부터 1회 발화한다", () => {
    const refreshes: Array<Record<string, unknown>> = [];
    const onRefresh = (e: Event) => refreshes.push((e as CustomEvent).detail);
    window.addEventListener("crewdeck:refresh", onRefresh);

    // 연결 전(소켓 없음)에 들어온 구독 요청 — 레지스트리에만 남는다.
    // 최초 connected 가 이 구독의 유일한 복구 기회다 (서버 Set add 는 멱등).
    wsSend({ type: "subscribe:terminal", terminalId: "term-0" });

    render(<WsOnly />);
    expect(sockets).toHaveLength(1);

    // 최초 연결의 connected: 구독 replay 는 수행, refresh 만 스킵(초기 로드와 중복)
    act(() => { sockets[0].onmessage?.(wsMsg({ type: "connected" })); });
    const sentFirst = sockets[0].send.mock.calls.map(([raw]) => JSON.parse(raw as string));
    expect(sentFirst.filter((m) => m.type === "subscribe:terminal")).toEqual([
      { type: "subscribe:terminal", terminalId: "term-0" },
    ]);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(refreshes).toHaveLength(0);

    // 구독 등록 — 같은 터미널 중복(dedupe 대상) + agent 구독/해지
    wsSend({ type: "subscribe:terminal", terminalId: "term-1" });
    wsSend({ type: "subscribe:terminal", terminalId: "term-1" });
    wsSend({ type: "subscribe:agent", agentId: "agent-1" });
    wsSend({ type: "subscribe:agent", agentId: "agent-2" });
    wsSend({ type: "unsubscribe:agent", agentId: "agent-2" });

    // 연결 유실 → 백오프(1s) 후 재연결 → 인증 → connected
    act(() => { sockets[0].onclose?.({} as CloseEvent); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(sockets).toHaveLength(2);
    act(() => { sockets[1].onopen?.(new Event("open")); });
    act(() => { sockets[1].onmessage?.(wsMsg({ type: "connected" })); });

    const sent = sockets[1].send.mock.calls.map(([raw]) => JSON.parse(raw as string));
    // 구독 replay: 터미널 2건(dedupe — term-0/term-1 각 1회), agent는 해지된 agent-2 제외 1건
    expect(sent.filter((m) => m.type === "subscribe:terminal")).toEqual([
      { type: "subscribe:terminal", terminalId: "term-0" },
      { type: "subscribe:terminal", terminalId: "term-1" },
    ]);
    expect(sent.filter((m) => m.type === "subscribe:agent")).toEqual([
      { type: "subscribe:agent", agentId: "agent-1" },
    ]);

    // 전역 재동기화 refresh는 코얼레싱(400ms) 후 정확히 1회, 스코프 없음
    expect(refreshes).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(400); });
    expect(refreshes).toEqual([{}]);

    window.removeEventListener("crewdeck:refresh", onRefresh);
  });
});

describe("W2 중앙 코얼레싱 (crewdeck:refresh 디바운스)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetRealtimeStateForTests();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("burst N건을 refresh 1회로 코얼레싱하고, 일관된 projectId는 detail로 전달한다", () => {
    const refreshes: Array<Record<string, unknown>> = [];
    const onRefresh = (e: Event) => refreshes.push((e as CustomEvent).detail);
    const passthrough: Array<{ type?: string; projectId?: string }> = [];
    const onWsEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      passthrough.push({ type: detail?.type, projectId: detail?.projectId });
    };
    window.addEventListener("crewdeck:refresh", onRefresh);
    window.addEventListener("crewdeck:ws-event", onWsEvent);

    render(<WsOnly />);

    // 같은 프로젝트 스코프 burst 3건 — trailing 디바운스 확인(중간 이벤트가 창을 연장)
    act(() => {
      sockets[0].onmessage?.(wsMsg({ type: "queue:resumed", payload: { projectId: "p1" } }));
      sockets[0].onmessage?.(wsMsg({ type: "queue:paused", payload: { projectId: "p1" } }));
    });
    act(() => { vi.advanceTimersByTime(300); });
    act(() => {
      sockets[0].onmessage?.(wsMsg({ type: "project:updated", payload: { projectId: "p1" } }));
    });
    act(() => { vi.advanceTimersByTime(300); }); // 마지막 이벤트로부터 300ms < 400ms
    expect(refreshes).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(100); }); // 마지막 이벤트로부터 400ms 도달
    expect(refreshes).toEqual([{ projectId: "p1" }]);
    // 데이터 소비자용 패스스루는 코얼레싱 없이 즉시 3건 — 추출된 projectId 스코프 포함
    expect(passthrough.map((p) => p.type)).toEqual(["queue:resumed", "queue:paused", "project:updated"]);
    expect(passthrough.every((p) => p.projectId === "p1")).toBe(true);

    // 서로 다른 프로젝트가 한 창에 섞이면 전역(빈 detail)
    act(() => {
      sockets[0].onmessage?.(wsMsg({ type: "queue:resumed", payload: { projectId: "p1" } }));
      sockets[0].onmessage?.(wsMsg({ type: "queue:resumed", payload: { projectId: "p2" } }));
    });
    act(() => { vi.advanceTimersByTime(400); });
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1]).toEqual({});

    // 스코프를 알 수 없는 이벤트(payload에 projectId 없음)도 전역
    act(() => {
      sockets[0].onmessage?.(wsMsg({ type: "task:started", payload: { taskId: "t1", agentId: "a1" } }));
    });
    act(() => { vi.advanceTimersByTime(400); });
    expect(refreshes).toHaveLength(3);
    expect(refreshes[2]).toEqual({});

    window.removeEventListener("crewdeck:refresh", onRefresh);
    window.removeEventListener("crewdeck:ws-event", onWsEvent);
  });

  it("지속 burst가 trailing 창을 계속 연장해도 max-wait(2s) 안에 강제 발화한다", () => {
    const refreshes: Array<Record<string, unknown>> = [];
    const onRefresh = (e: Event) => refreshes.push((e as CustomEvent).detail);
    window.addEventListener("crewdeck:refresh", onRefresh);

    render(<WsOnly />);

    // 300ms 간격(< 400ms 디바운스 창) 지속 burst — max-wait 없이는 발화가 무한 연기된다
    act(() => {
      sockets[0].onmessage?.(wsMsg({ type: "project:updated", payload: { projectId: "p1" } }));
    });
    for (let i = 0; i < 6; i++) { // 이벤트 시각: t=300..1800
      act(() => { vi.advanceTimersByTime(300); });
      act(() => {
        sockets[0].onmessage?.(wsMsg({ type: "project:updated", payload: { projectId: "p1" } }));
      });
    }
    // t=1800 시점까지는 미발화 (max-wait 2000ms 미도달)
    expect(refreshes).toHaveLength(0);
    // 첫 pending(t=0)으로부터 2000ms 도달 시 강제 발화
    act(() => { vi.advanceTimersByTime(200); });
    expect(refreshes).toEqual([{ projectId: "p1" }]);

    window.removeEventListener("crewdeck:refresh", onRefresh);
  });
});
