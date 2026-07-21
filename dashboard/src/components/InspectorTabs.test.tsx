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

const { wsSend } = vi.hoisted(() => ({ wsSend: vi.fn() }));
vi.mock("../hooks/useWebSocket", () => ({ wsSend }));
vi.mock("./AnomalyPanel", () => ({ AnomalyPanel: () => <div>anomaly panel</div> }));
vi.mock("./DiffPane", () => ({ DiffPane: () => <div>diff pane</div> }));
vi.mock("./GoalDetail", () => ({ GoalDetail: () => <div>verdict panel</div> }));

import "../i18n";
import { InspectorTabs } from "./InspectorTabs";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("InspectorTabs live agent tab", () => {
  it("mounts the working agent's live stream and subscribes to its output", () => {
    render(
      <InspectorTabs
        goalId="g1"
        workspaceId="w1"
        projectId="p1"
        liveAgent={{ id: "a1", name: "Frontend", task: "Implement" }}
        liveSelectToken={1}
      />,
    );

    // 실행 중 탭이 자동 포커스되어 담당 에이전트·태스크가 보이고 라이브 세션 구독이 붙는다.
    expect(screen.getByText("Frontend")).toBeTruthy();
    expect(screen.getByText("· Implement")).toBeTruthy();
    expect(wsSend).toHaveBeenCalledWith({ type: "subscribe:agent", agentId: "a1" });
  });

  it("omits the live tab and subscription when no working agent is targeted", () => {
    render(<InspectorTabs goalId="g1" workspaceId="w1" projectId="p1" />);

    expect(screen.queryByText("Frontend")).toBeNull();
    expect(wsSend).not.toHaveBeenCalled();
  });
});
