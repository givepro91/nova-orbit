// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.hoisted(() => {
  const storage = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => storage.clear(),
  };
});

const sessionView = vi.hoisted(() => ({ props: null as { agentId?: string; goalId?: string | null } | null }));
vi.mock("./SessionView", () => ({
  SessionView: (props: { agentId: string; goalId: string | null }) => {
    sessionView.props = props;
    return <div>session-view {props.agentId}</div>;
  },
}));
vi.mock("./AnomalyPanel", () => ({ AnomalyPanel: () => <div>anomaly panel</div> }));
vi.mock("./DiffPane", () => ({ DiffPane: () => <div>diff pane</div> }));
vi.mock("./GoalDetail", () => ({ GoalDetail: () => <div>verdict panel</div> }));

import "../i18n";
import { InspectorTabs } from "./InspectorTabs";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionView.props = null;
});

describe("InspectorTabs live agent tab", () => {
  it("renders the running agent's live session stream via SessionView (session:stream channel)", () => {
    render(
      <InspectorTabs
        goalId="g1"
        workspaceId="w1"
        projectId="p1"
        liveAgent={{ id: "a1", name: "Frontend", task: "Implement" }}
        liveSelectToken={1}
      />,
    );

    // 실행 중 탭이 자동 포커스되어 담당 에이전트·태스크가 보인다.
    expect(screen.getByText("Frontend")).toBeTruthy();
    expect(screen.getByText("· Implement")).toBeTruthy();
    // 라이브 출력은 agent:output(소환 전용)이 아니라 session:stream(agentId 스코프)을
    // 소비하는 SessionView로 렌더한다 — 실행 중 에이전트 세션의 실제 출력.
    expect(sessionView.props).toEqual({ agentId: "a1", goalId: "g1" });
  });

  it("omits the live tab and stream when no working agent is targeted", () => {
    render(<InspectorTabs goalId="g1" workspaceId="w1" projectId="p1" />);

    expect(screen.queryByText("Frontend")).toBeNull();
    expect(sessionView.props).toBeNull();
  });
});
