// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// jsdom 은 localStorage 를 기본 노출하지 않는다. i18n 이 import 시점에 언어를 정하므로
// 여기서 미리 ko 로 고정해 라벨 단언이 흔들리지 않게 한다.
const mocks = vi.hoisted(() => {
  const store = new Map<string, string>([["crewdeck-lang", "ko"]]);
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
  };
  return {
    getVerificationTimeline: vi.fn(),
    getDiff: vi.fn(),
    fetchArtifact: vi.fn(),
  };
});

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      goals: {
        ...actual.api.goals,
        getVerificationTimeline: mocks.getVerificationTimeline,
        getDiff: mocks.getDiff,
        fetchArtifact: mocks.fetchArtifact,
      },
    },
  };
});

import "../i18n";
import { GoalSquashApprovalDialog } from "./GoalSquashApprovalDialog";
import type { WorkReport } from "../lib/api";

const GOAL = { id: "g1", title: "목록↔상세 스펙 모순 해소", worktree_branch: "goal/spec-fix", acceptance_script: null };

const baseReport = (over: Partial<WorkReport> = {}): WorkReport => ({
  before: "목록과 상세가 다른 사양을 보여줬다",
  changed: "표기를 상세 기준으로 맞췄다",
  after: "두 화면이 같은 값을 표시한다",
  notes: "",
  summaryStatus: "ready",
  screenshots: [],
  ...over,
});

function renderDialog(props: Partial<Parameters<typeof GoalSquashApprovalDialog>[0]> = {}) {
  return render(
    <GoalSquashApprovalDialog
      goal={GOAL}
      commitMessage="fix: 스펙 모순 해소"
      filesChanged={["src/HostsTable.tsx"]}
      workReport={baseReport()}
      onConfirm={async () => {}}
      onCancel={() => {}}
      isApproving={false}
      {...props}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GoalSquashApprovalDialog — 사용자가 보게 될 차이", () => {
  it("체감 변화 없음을 명시적으로 보여준다 (침묵과 구별)", async () => {
    mocks.getVerificationTimeline.mockResolvedValue({ rounds: [] });
    renderDialog({ workReport: baseReport({ userImpact: { visible: false, surfaces: [] } }) });
    expect(await screen.findByText(/사용자가 체감하는 변화는 없습니다/)).toBeTruthy();
  });

  it("화면 단위로 무엇이 달라지는지 나열한다", async () => {
    mocks.getVerificationTimeline.mockResolvedValue({ rounds: [] });
    renderDialog({
      workReport: baseReport({
        userImpact: { visible: true, surfaces: [{ name: "호스트 목록 화면", change: "CPU가 2소켓으로 표시된다" }] },
      }),
    });
    expect(await screen.findByText("호스트 목록 화면")).toBeTruthy();
    expect(screen.getByText("CPU가 2소켓으로 표시된다")).toBeTruthy();
  });
});

describe("GoalSquashApprovalDialog — 요청하지 않은 변경", () => {
  it("범위 밖 변경이 있으면 경고로 보여준다", async () => {
    mocks.getVerificationTimeline.mockResolvedValue({ rounds: [] });
    renderDialog({ workReport: baseReport({ outOfScope: "alias 6대 재생성이 함께 들어왔습니다" }) });
    expect(await screen.findByText(/alias 6대 재생성이 함께 들어왔습니다/)).toBeTruthy();
    expect(screen.getByText("요청하지 않은 변경")).toBeTruthy();
  });

  it("범위 밖 변경이 없으면 블록 자체를 띄우지 않는다", async () => {
    mocks.getVerificationTimeline.mockResolvedValue({ rounds: [] });
    renderDialog({ workReport: baseReport({ outOfScope: "" }) });
    await screen.findByText("목록↔상세 스펙 모순 해소");
    expect(screen.queryByText("요청하지 않은 변경")).toBeNull();
  });

  // 서사가 아직 안 만들어졌으면 outOfScope 는 근거 없는 값이라 띄우지 않는다.
  it("요약이 준비되지 않았으면 경고를 띄우지 않는다", async () => {
    mocks.getVerificationTimeline.mockResolvedValue({ rounds: [] });
    renderDialog({ workReport: baseReport({ summaryStatus: "pending", outOfScope: "뭔가 섞임" }) });
    await screen.findByText("목록↔상세 스펙 모순 해소");
    expect(screen.queryByText("요청하지 않은 변경")).toBeNull();
  });
});

describe("GoalSquashApprovalDialog — 근거 섹션", () => {
  it("코드 변경은 접힌 채로 열려 diff를 미리 받지 않는다", async () => {
    mocks.getVerificationTimeline.mockResolvedValue({ rounds: [] });
    mocks.getDiff.mockResolvedValue({ diff: "diff --git a/x b/x", truncated: false });
    renderDialog();
    expect(await screen.findByText("코드 변경 보기")).toBeTruthy();
    // 접혀 있는 동안 DiffPane 이 마운트되면 안 된다 (접힘의 의미가 사라진다).
    expect(mocks.getDiff).not.toHaveBeenCalled();
  });

  it("조건부 판정이 있으면 품질 게이트를 펼친 채로 연다", async () => {
    mocks.getVerificationTimeline.mockResolvedValue({
      rounds: [{
        round: 1, task_id: "t1", verdict: "conditional", issues: [
          { issue_id: "i1", dimension: "회귀", severity: "minor", evidence: "smoke 테스트가 한 번 실패 후 통과" },
        ],
      }],
    });
    renderDialog();
    expect(await screen.findByText(/smoke 테스트가 한 번 실패 후 통과/)).toBeTruthy();
  });

  it("과거 라운드의 실패가 아니라 태스크별 최신 판정만 집계한다", async () => {
    mocks.getVerificationTimeline.mockResolvedValue({
      rounds: [
        { round: 1, task_id: "t1", verdict: "fail", issues: [{ issue_id: "old", dimension: "d", severity: "s", evidence: "이미 고쳐진 결함" }] },
        { round: 2, task_id: "t1", verdict: "pass", issues: [] },
      ],
    });
    renderDialog();
    await waitFor(() => expect(mocks.getVerificationTimeline).toHaveBeenCalled());
    // 최신이 pass 이므로 옛 실패 근거가 승인 화면에 남으면 안 된다.
    await waitFor(() => expect(screen.queryByText("이미 고쳐진 결함")).toBeNull());
  });
});
