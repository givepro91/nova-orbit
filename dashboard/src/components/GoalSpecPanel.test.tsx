// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GoalSpecVersionSnapshot } from "../../../shared/types";
import { ApiError, type GoalSpecState } from "../lib/api";

// hoisted — 정적 import(api.ts / i18n index 최상단 localStorage·navigator 접근)보다 먼저 실행된다.
// jsdom 은 기본적으로 localStorage 를 노출하지 않으므로 최소 구현을 심는다.
const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
  };
  return {
    getSpec: vi.fn(),
    getSpecGenerationState: vi.fn(),
    saveSpec: vi.fn(),
    approveSpec: vi.fn(),
    generateSpec: vi.fn(),
  };
});

// api.goals 만 mock — ApiError·parseGoalSpecState 등 나머지는 실제 구현을 쓴다.
vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      goals: {
        getSpec: mocks.getSpec,
        getSpecGenerationState: mocks.getSpecGenerationState,
        saveSpec: mocks.saveSpec,
        approveSpec: mocks.approveSpec,
        generateSpec: mocks.generateSpec,
      },
    },
  };
});

// 실제 i18n 인스턴스를 초기화한다(영어). react-i18next 를 mock 하지 않고 안정적인 `t` 를 얻어,
// useTranslation 이 매 렌더마다 새 t 를 반환해 useEffect 의존성이 흔들리는 문제를 피한다.
import "../i18n";
import GoalSpecPanel, { GoalSpecEmptyState, GoalSpecFieldError } from "./GoalSpecPanel";
import { useGoalSpecStore } from "../stores/goalSpecs";

const GOAL_ID = "g1";

function makeVersion(over: Partial<GoalSpecVersionSnapshot> & { id: string; version: number }): GoalSpecVersionSnapshot {
  return {
    state: "draft",
    scope: `scope-${over.version}`,
    out_of_scope: `out-${over.version}`,
    acceptance_criteria: [`ac-${over.version}`],
    expected_tasks: [`task-${over.version}`],
    verification_methods: [`vm-${over.version}`],
    created_at: "2026-07-12T00:00:00.000Z",
    approved_at: null,
    ...over,
  };
}

function makeState(over?: Partial<GoalSpecState>): GoalSpecState {
  const v1 = makeVersion({ id: "v1", version: 1, state: "approved", scope: "scope-approved", acceptance_criteria: ["ac-shared", "ac-only-v1"], approved_at: "2026-07-12T00:00:00.000Z" });
  const v2 = makeVersion({ id: "v2", version: 2, state: "draft", scope: "scope-draft", acceptance_criteria: ["ac-shared", "ac-only-v2"] });
  return {
    goal_id: GOAL_ID,
    status: "changes_pending",
    execution_spec_version_id: "v1",
    versions: [v1, v2],
    legacy_spec: null,
    ...over,
  };
}

function resetStore() {
  useGoalSpecStore.setState({
    byGoalId: {},
    loadingByGoalId: {},
    savingByGoalId: {},
    approvingByGoalId: {},
    errorByGoalId: {},
  });
}

beforeEach(() => {
  resetStore();
  mocks.getSpec.mockReset();
  mocks.getSpecGenerationState.mockReset();
  mocks.saveSpec.mockReset();
  mocks.approveSpec.mockReset();
  mocks.generateSpec.mockReset();
  mocks.getSpecGenerationState.mockResolvedValue({ generation_status: "idle", generation_error: null });
});

afterEach(() => {
  cleanup();
});

async function renderPanel(state: GoalSpecState, onClose = vi.fn()) {
  mocks.getSpec.mockResolvedValue(state);
  render(<GoalSpecPanel goalId={GOAL_ID} onClose={onClose} />);
  // loadSpec(setTimeout 0) 완료 대기 — Loading… 이 사라지고 편집 폼이 뜬다
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  await waitFor(() => expect(screen.queryByText("Loading...")).toBeNull());
  return { onClose };
}

describe("GoalSpecPanel — full render + interaction", () => {
  it("renders the version list and the latest version fields after load", async () => {
    await renderPanel(makeState());
    await waitFor(() => expect(screen.getByText("v2")).toBeTruthy());
    // 두 버전이 모두 목록에 노출된다
    expect(screen.getByText("v1")).toBeTruthy();
    expect(screen.getByText("v2")).toBeTruthy();
    // 최신(v2, draft) 스냅샷이 기본 문서 보기에 표시된다
    expect(screen.getByText("scope-draft")).toBeTruthy();
  });

  it("marks the execution-basis version and shows the pin in the detail header when selected", async () => {
    await renderPanel(makeState({ execution_spec_version_id: "v1" }));
    // 실행 기준 배지(nav) — execution_spec_version_id 와 일치하는 버전에만
    expect(screen.getAllByText("Execution basis").length).toBeGreaterThanOrEqual(1);
    // v1(실행 기준)을 선택하면 상세 헤더에도 실행 기준 표지가 뜬다
    fireEvent.click(screen.getByText("v1"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Structured Blueprint" })).toBeTruthy());
    const header = screen.getByRole("heading", { name: "Structured Blueprint" }).parentElement as HTMLElement;
    expect(within(header).getByText(/Execution basis/)).toBeTruthy();
  });

  it("switches versions and locks the approved snapshot read-only", async () => {
    await renderPanel(makeState());
    fireEvent.click(screen.getByText("v1"));
    // 승인된 v1 은 문서 보기로만 표시된다(폼 없음)
    await waitFor(() => expect(screen.getByText("scope-approved")).toBeTruthy());
    expect(screen.getByText(/approved version is locked/)).toBeTruthy();
    // read-only 버전은 저장 버튼도, 편집 토글도 없다
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("exposes an Approve action for the latest draft and calls the approve API", async () => {
    const state = makeState();
    await renderPanel(state);
    const approved = { ...state, status: "approved" as const, execution_spec_version_id: "v2", versions: [state.versions[0], { ...state.versions[1], state: "approved" as const, approved_at: "2026-07-12T01:00:00.000Z" }] };
    mocks.approveSpec.mockResolvedValue(approved);
    const approveBtn = await screen.findByRole("button", { name: "Approve" });
    fireEvent.click(approveBtn);
    await waitFor(() => expect(mocks.approveSpec).toHaveBeenCalledWith(GOAL_ID, "v2"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("dialog")));
  });

  it("shows an approval validation message at the backend-identified field", async () => {
    await renderPanel(makeState());
    mocks.approveSpec.mockRejectedValue(new ApiError(
      "scope is required",
      400,
      "invalid_spec",
      "scope",
    ));

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("scope is required");
    expect(alert.textContent).not.toContain("invalid_spec");
    const scope = screen.getAllByRole("textbox")[0];
    expect(scope.getAttribute("aria-invalid")).toBe("true");
    expect(scope.getAttribute("aria-describedby")).toBe("spec-scope-error");
  });

  it("exposes the newly saved version after a save", async () => {
    const state = makeState();
    await renderPanel(state);
    const v3 = makeVersion({ id: "v3", version: 3, state: "draft", scope: "scope-3" });
    mocks.saveSpec.mockResolvedValue({ ...state, versions: [...state.versions, v3] });
    // 편집 모드로 전환해야 폼이 노출된다(기본 = 문서 보기)
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const scope = screen.getAllByRole("textbox")[0] as HTMLTextAreaElement;
    fireEvent.change(scope, { target: { value: "edited scope" } });
    const saveBtn = await screen.findByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);
    await waitFor(() => expect(mocks.saveSpec).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("v3")).toBeTruthy());
  });

  it("compares two versions with a field diff and exits back to the document", async () => {
    await renderPanel(makeState());
    fireEvent.click(screen.getByRole("button", { name: "Compare versions" }));
    // 비교 뷰: 기준/비교 version selector 두 개 (키보드 접근 가능한 <select>)
    const base = (await screen.findByLabelText("Base version")) as HTMLSelectElement;
    const target = screen.getByLabelText("Compare version") as HTMLSelectElement;
    expect(base).toBeTruthy();
    expect(target).toBeTruthy();
    // scope 가 다르므로 변경 표지가 뜬다
    expect(screen.getAllByText("Changed").length).toBeGreaterThanOrEqual(1);
    // 삭제·추가 diff (acceptance_criteria: ac-only-v1 → ac-only-v2)
    expect(screen.getByText("− ac-only-v1")).toBeTruthy();
    expect(screen.getByText("+ ac-only-v2")).toBeTruthy();
    // 기준 version 을 키보드/셀렉트로 바꿀 수 있다
    fireEvent.change(base, { target: { value: "v2" } });
    expect(base.value).toBe("v2");
    // 비교 종료 → 문서 보기(기본) 복귀
    fireEvent.click(screen.getByRole("button", { name: "Exit compare" }));
    await waitFor(() => expect(screen.queryByTestId("spec-compare-view")).toBeNull());
    expect(screen.getByText("scope-draft")).toBeTruthy();
  });

  it("is an accessible dialog: initial focus is trapped inside and Escape closes it", async () => {
    const { onClose } = await renderPanel(makeState());
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("goal-spec-title");
    // 열릴 때 첫 의미 있는 컨트롤로 포커스가 모달 내부에 놓인다
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    // Escape 로 닫힌다 (busy 아님)
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

// 정적 헬퍼 컴포넌트 — DOM 없이도 검증 가능한 회귀 가드
describe("GoalSpecPanel empty state", () => {
  it("renders create actions without reading a missing snapshot", () => {
    const html = renderToStaticMarkup(<GoalSpecEmptyState title="No blueprint yet" hint="Create one before execution" createLabel="New draft" generateLabel="Generate Blueprint" error={null} disabled={false} onCreate={() => {}} onGenerate={() => {}} />);
    expect(html).toContain("No blueprint yet");
    expect(html).toContain("New draft");
    expect(html).toContain("Generate Blueprint");
    expect(html).not.toContain("textarea");
  });
});

describe("GoalSpecPanel validation errors", () => {
  it("renders the backend message only at the field identified by location", () => {
    const scopeHtml = renderToStaticMarkup(<GoalSpecFieldError field="scope" location="scope" message="scope is required" />);
    const otherFieldHtml = renderToStaticMarkup(<GoalSpecFieldError field="out_of_scope" location="scope" message="scope is required" />);

    expect(scopeHtml).toContain('id="spec-scope-error"');
    expect(scopeHtml).toContain('role="alert"');
    expect(scopeHtml).toContain("scope is required");
    expect(otherFieldHtml).toBe("");
  });
});
