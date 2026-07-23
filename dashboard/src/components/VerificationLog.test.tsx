// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// jsdom 은 localStorage 를 기본 노출하지 않는다. i18n 이 import 시점에 언어를 정하므로 ko 로 고정한다.
const mocks = vi.hoisted(() => {
  const store = new Map<string, string>([["crewdeck-lang", "ko"]]);
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
  };
  return { list: vi.fn(), label: vi.fn(), createFixTask: vi.fn() };
});

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      verifications: {
        ...actual.api.verifications,
        list: mocks.list,
        label: mocks.label,
        createFixTask: mocks.createFixTask,
      },
    },
  };
});

import "../i18n";
import { VerificationLog } from "./VerificationLog";
import { useToast } from "../stores/useToast";

const FALSE_POSITIVE = "오탐(통과했어야 함)";
const FALSE_NEGATIVE = "미탐(문제 있는데 통과)";

const row = (over: Record<string, unknown> = {}) => ({
  id: "v-fail",
  task_id: "t1",
  task_title: "라벨 UI 추가",
  verdict: "fail",
  scope: "standard",
  severity: "hard-block",
  dimensions: {},
  issues: [],
  created_at: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  mocks.list.mockResolvedValue([row()]);
  mocks.label.mockImplementation(async (id: string, body: { label: string; note?: string | null }) => ({
    id: "l1",
    verification_id: id,
    label: body.label,
    cause_category: null,
    note: body.note ?? null,
    labeled_at: "2026-07-22 10:00:00",
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("VerificationLog 라벨 컨트롤", () => {
  it("판정별로 지적 가능한 라벨만 노출한다 (fail=오탐, pass=미탐, conditional=없음)", async () => {
    mocks.list.mockResolvedValue([
      row({ id: "v-fail", verdict: "fail" }),
      row({ id: "v-pass", verdict: "pass" }),
      row({ id: "v-cond", verdict: "conditional" }),
    ]);
    render(<VerificationLog projectId="p1" />);

    expect(await screen.findByRole("button", { name: FALSE_POSITIVE })).toBeTruthy();
    expect(screen.getByRole("button", { name: FALSE_NEGATIVE })).toBeTruthy();
    // 라벨 버튼은 fail/pass 두 행에만 — conditional 행은 지적 대상이 아니다.
    expect(screen.queryAllByRole("button", { name: FALSE_POSITIVE }).length).toBe(1);
    expect(screen.queryAllByRole("button", { name: FALSE_NEGATIVE }).length).toBe(1);
  });

  it("사유를 입력해 저장하면 label API를 호출하고 그 행이 라벨 칩으로 바뀐다", async () => {
    render(<VerificationLog projectId="p1" />);

    fireEvent.click(await screen.findByRole("button", { name: FALSE_POSITIVE }));
    // window.prompt 가 아니라 InputDialog 가 열린다.
    const input = await screen.findByPlaceholderText("판단 근거를 한 줄로 적어주세요");
    fireEvent.change(input, { target: { value: "테스트는 실제로 통과했다" } });
    fireEvent.click(screen.getByRole("button", { name: "확인" }));

    await waitFor(() =>
      expect(mocks.label).toHaveBeenCalledWith("v-fail", {
        label: "false_positive",
        note: "테스트는 실제로 통과했다",
      }),
    );
    // Toast 는 전역 스토어에 넣고 ToastContainer(앱 루트)가 그린다 — 컴포넌트 단독 렌더에는 DOM 이 없다.
    await waitFor(() =>
      expect(useToast.getState().toasts.some((x) => x.message === "검토 내용을 저장했습니다")).toBe(true),
    );
    // 목록 재조회 없이 해당 행만 갱신된다.
    expect(mocks.list).toHaveBeenCalledTimes(1);
    const chip = screen.getByRole("button", { name: FALSE_POSITIVE });
    expect(chip.getAttribute("title")).toBe("테스트는 실제로 통과했다");
  });

  it("이미 라벨된 행은 최초 조회 결과만으로 현재 라벨 칩을 표시한다", async () => {
    mocks.list.mockResolvedValue([
      row({ id: "v-pass", verdict: "pass", label: "false_negative", label_note: "누락된 예외 처리" }),
    ]);
    render(<VerificationLog projectId="p1" />);

    const chip = await screen.findByRole("button", { name: FALSE_NEGATIVE });
    expect(chip.getAttribute("title")).toBe("누락된 예외 처리");
  });

  it("verification:labeled 이벤트를 받으면 재조회 없이 칩이 나타난다", async () => {
    render(<VerificationLog projectId="p1" />);
    await screen.findByRole("button", { name: FALSE_POSITIVE });

    act(() => {
      window.dispatchEvent(
        new CustomEvent("crewdeck:verification-labeled", {
          detail: {
            id: "l9",
            verification_id: "v-fail",
            label: "false_positive",
            cause_category: null,
            note: "다른 창에서 라벨함",
            labeled_at: "2026-07-22 10:00:00",
          },
        }),
      );
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: FALSE_POSITIVE }).getAttribute("title")).toBe("다른 창에서 라벨함"),
    );
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
});
