// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReportDetail, ReportSummary } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
  ...(() => {
    const storage = new Map<string, string>();
    storage.set("crewdeck-lang", "ko");
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, String(value)); },
      removeItem: (key: string) => { storage.delete(key); },
      clear: () => storage.clear(),
    };
    return {};
  })(),
  list: vi.fn(),
  detail: vi.fn(),
}));

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      projects: { ...actual.api.projects, goalReports: mocks.list },
      goals: { ...actual.api.goals, getExecutionReport: mocks.detail },
    },
  };
});

import "../i18n";
import { GoalReports } from "./GoalReports";
import { useStore } from "../stores/useStore";

const completed: ReportSummary = {
  goalId: "g-complete",
  title: "Completed goal",
  finalStatus: "completed",
  startedAt: "2026-07-10T10:00:00.000Z",
  endedAt: "2026-07-10T10:02:00.000Z",
  durationMs: 120_000,
  providers: [
    { provider: "claude", sessionCount: 2, tokens: 1200, costUsd: 0.15 },
    { provider: "codex", sessionCount: 1, tokens: null, costUsd: null },
  ],
  retryCount: 1,
  failoverCount: 1,
  evaluationCount: 2,
  fixRoundCount: 1,
  finalVerdict: "pass",
  telemetry: "partial",
};

const failed: ReportSummary = {
  ...completed,
  goalId: "g-failed",
  title: "Failed goal",
  finalStatus: "failed",
  providers: [{ provider: "claude", sessionCount: 1, tokens: 300, costUsd: 0.02 }],
  retryCount: 3,
  failoverCount: 0,
  finalVerdict: "fail",
  telemetry: "complete",
};

const interrupted: ReportSummary = {
  ...completed,
  goalId: "g-interrupted",
  title: "Interrupted goal",
  finalStatus: "interrupted",
  durationMs: 300_000,
  providers: [{ provider: "codex", sessionCount: 2, tokens: null, costUsd: null }],
  retryCount: 2,
  failoverCount: 4,
  evaluationCount: 1,
  fixRoundCount: 5,
  finalVerdict: null,
};

const detail: ReportDetail = {
  ...completed,
  agentRoles: ["frontend", "reviewer"],
  history: [{ kind: "failover", occurredAt: "2026-07-10T10:01:00.000Z", taskId: "t1", summary: "Claude에서 Codex로 자동 전환" }],
};

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  useStore.setState({ goalReports: [] });
  mocks.list.mockResolvedValue({ reports: [completed, failed] });
  mocks.detail.mockResolvedValue(detail);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GoalReports", () => {
  it("connects the project report API and shows the comparison columns after loading", async () => {
    let resolveList: ((value: { reports: ReportSummary[] }) => void) | undefined;
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve; }));
    render(<GoalReports projectId="p1" />);

    expect(screen.getByLabelText("로딩 중...")).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledWith("p1");
    resolveList?.({ reports: [completed] });

    const table = await screen.findByRole("table");
    for (const heading of ["목표", "소요 시간", "제공자 사용량", "재시도", "자동 전환", "평가", "수정", "최종 결과"]) {
      expect(within(table).getByRole("columnheader", { name: heading })).toBeTruthy();
    }
  });

  it("compares provider usage without turning unreported telemetry into zero", async () => {
    render(<GoalReports projectId="p1" />);
    await screen.findByText("Completed goal");

    const row = screen.getByText("Completed goal").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row!).getByText(/Codex/i)).toBeTruthy();
    expect(within(row!).getAllByText(/미보고/)).toHaveLength(2);
    expect(within(row!).getByText("일부 기록")).toBeTruthy();
  });

  it("filters by status and provider and sorts by retries", async () => {
    render(<GoalReports projectId="p1" />);
    await screen.findByText("Completed goal");

    fireEvent.change(screen.getByLabelText("상태 필터"), { target: { value: "failed" } });
    expect(screen.queryByText("Completed goal")).toBeNull();
    expect(screen.getByText("Failed goal")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("상태 필터"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("제공자 필터"), { target: { value: "codex" } });
    expect(screen.getByText("Completed goal")).toBeTruthy();
    expect(screen.queryByText("Failed goal")).toBeNull();

    fireEvent.change(screen.getByLabelText("제공자 필터"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("정렬 기준"), { target: { value: "retryCount" } });
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText("Failed goal")).toBeTruthy();
  });

  it.each([
    ["durationMs", "Interrupted goal"],
    ["retryCount", "Failed goal"],
    ["failoverCount", "Interrupted goal"],
    ["fixRoundCount", "Interrupted goal"],
  ])("sorts descending by %s", async (sortKey, expectedFirst) => {
    mocks.list.mockResolvedValue({ reports: [completed, failed, interrupted] });
    render(<GoalReports projectId="p1" />);
    await screen.findByText("Completed goal");

    fireEvent.change(screen.getByLabelText("정렬 기준"), { target: { value: sortKey } });
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText(expectedFirst)).toBeTruthy();
  });

  it("sorts by provider composition and keeps missing provider records last", async () => {
    const noProvider: ReportSummary = {
      ...completed,
      goalId: "g-no-provider",
      title: "No provider goal",
      providers: [],
      telemetry: "none",
    };
    mocks.list.mockResolvedValue({ reports: [completed, noProvider, interrupted] });
    render(<GoalReports projectId="p1" />);
    await screen.findByText("Completed goal");

    fireEvent.change(screen.getByLabelText("정렬 기준"), { target: { value: "providers" } });
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText("Interrupted goal")).toBeTruthy();
    expect(within(rows.at(-1)!).getByText("No provider goal")).toBeTruthy();
  });

  it("opens a selected goal detail with roles and run history", async () => {
    render(<GoalReports projectId="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Completed goal" }));

    await waitFor(() => expect(mocks.detail).toHaveBeenCalledWith("g-complete"));
    expect(await screen.findByText("frontend")).toBeTruthy();
    expect(screen.getByText("Claude에서 Codex로 자동 전환")).toBeTruthy();
    const panel = document.getElementById("report-detail");
    expect(panel).not.toBeNull();
    expect(within(panel!).getByText("2m 0s")).toBeTruthy();
    expect(within(panel!).getByText("완료")).toBeTruthy();
    expect(within(panel!).getByText("통과")).toBeTruthy();
    expect(within(panel!).getByText("1 · 1")).toBeTruthy();
    expect(within(panel!).getByText("2 · 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Completed goal" }).getAttribute("aria-expanded")).toBe("true");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("replaces an open detail with a loading state and reports detail request errors", async () => {
    let rejectDetail: ((error: Error) => void) | undefined;
    mocks.detail
      .mockResolvedValueOnce(detail)
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectDetail = reject; }));
    render(<GoalReports projectId="p1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Completed goal" }));
    expect(await screen.findByText("frontend")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Failed goal" }));

    expect(screen.queryByText("frontend")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("상세 기록을 불러오는 중");
    rejectDetail?.(new Error("offline"));
    expect((await screen.findByRole("alert")).textContent).toContain("상세 기록을 불러오지 못했습니다");
  });

  it("ignores an older detail response after switching goals", async () => {
    let resolveCompleted: ((value: ReportDetail) => void) | undefined;
    let resolveFailed: ((value: ReportDetail) => void) | undefined;
    mocks.detail.mockImplementation((goalId: string) => new Promise<ReportDetail>((resolve) => {
      if (goalId === "g-complete") resolveCompleted = resolve;
      else resolveFailed = resolve;
    }));
    render(<GoalReports projectId="p1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Completed goal" }));
    fireEvent.click(screen.getByRole("button", { name: "Failed goal" }));
    resolveFailed?.({ ...detail, ...failed, agentRoles: ["qa"], history: [] });
    expect(await screen.findByRole("heading", { name: "Failed goal" })).toBeTruthy();

    await act(async () => { resolveCompleted?.(detail); });
    expect(screen.getByRole("heading", { name: "Failed goal" })).toBeTruthy();
    expect(screen.getByText("qa")).toBeTruthy();
    expect(screen.queryByText("frontend")).toBeNull();
  });

  it("shows no record instead of zeroes in a detail with no telemetry", async () => {
    mocks.detail.mockResolvedValue({
      ...detail,
      finalStatus: "interrupted",
      telemetry: "none",
      startedAt: null,
      endedAt: null,
      durationMs: null,
      providers: [],
      retryCount: 0,
      failoverCount: 0,
      evaluationCount: 0,
      fixRoundCount: 0,
      finalVerdict: null,
      agentRoles: [],
      history: [],
    });
    render(<GoalReports projectId="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Completed goal" }));

    await screen.findByRole("heading", { name: "Completed goal" });
    const panel = document.getElementById("report-detail");
    expect(panel).not.toBeNull();
    expect(within(panel!).queryByText("중단")).toBeNull();
    expect(within(panel!).queryByText(/^0$/)).toBeNull();
    expect(within(panel!).getAllByText("기록 없음").length).toBeGreaterThanOrEqual(6);
  });

  it("shows an empty state when the project has no report records", async () => {
    mocks.list.mockResolvedValue({ reports: [] });
    render(<GoalReports projectId="p-empty" />);
    expect(await screen.findByText("아직 실행 리포트가 없습니다.")).toBeTruthy();
  });

  it("shows no record instead of zero counts when execution telemetry is absent", async () => {
    mocks.list.mockResolvedValue({ reports: [{ ...completed, finalStatus: "interrupted", telemetry: "none", providers: [], durationMs: null, retryCount: 0, failoverCount: 0, evaluationCount: 0, fixRoundCount: 0 }] });
    render(<GoalReports projectId="p-none" />);
    const row = (await screen.findByText("Completed goal")).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row!).queryByText("0")).toBeNull();
    expect(within(row!).getAllByText("기록 없음").length).toBeGreaterThanOrEqual(6);
    expect(within(row!).queryByText("중단")).toBeNull();

    fireEvent.change(screen.getByLabelText("상태 필터"), { target: { value: "interrupted" } });
    expect(screen.queryByText("Completed goal")).toBeNull();
    expect(screen.getByText("선택한 조건에 맞는 목표가 없습니다.")).toBeTruthy();
  });

  it("shows a partial zero retry count as unreported", async () => {
    mocks.list.mockResolvedValue({ reports: [{ ...completed, retryCount: 0, telemetry: "partial" }] });
    render(<GoalReports projectId="p-partial" />);
    const row = (await screen.findByText("Completed goal")).closest("tr");
    expect(row).not.toBeNull();
    const retryCell = row!.querySelectorAll("td")[3];
    expect(retryCell.textContent).toBe("미보고");
  });

  it("does not show the normal empty state after a list request fails", async () => {
    mocks.list.mockRejectedValue(new Error("offline"));
    render(<GoalReports projectId="p-error" />);
    expect((await screen.findByRole("alert")).textContent).toContain("실행 리포트를 불러오지 못했습니다.");
    expect(screen.queryByText("아직 실행 리포트가 없습니다.")).toBeNull();
  });
});
