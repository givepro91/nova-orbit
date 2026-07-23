// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { CalibrationStats } from "../../../shared/types";

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
  calibration: vi.fn(),
}));

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      verifications: { ...actual.api.verifications, calibration: mocks.calibration },
    },
  };
});

import "../i18n";
import { CalibrationPanel } from "./CalibrationPanel";

const stats: CalibrationStats = {
  total: 100,
  passed: 40,
  conditional: 10,
  failed: 50,
  failRate: 50,
  baselineFailRate: 48,
  failRateDelta: 2,
  causes: [
    { category: "functionality", count: 20, ratio: 0.4 },
    { category: "dataFlow", count: 15, ratio: 0.3 },
    { category: "craft", count: 10, ratio: 0.2 },
    { category: "edgeCases", count: 5, ratio: 0.1 },
  ],
  labels: { total: 6, falsePositive: 3, falseNegative: 2, correct: 1 },
};

beforeEach(() => {
  mocks.calibration.mockResolvedValue(stats);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CalibrationPanel", () => {
  it("shows the fail rate against the baseline and only the top 3 causes", async () => {
    render(<CalibrationPanel projectId="p1" />);

    expect(await screen.findByText("50%")).toBeTruthy();
    expect(mocks.calibration).toHaveBeenCalledWith("p1");
    expect(screen.getByText("기준선 48% 대비 +2%p")).toBeTruthy();

    expect(screen.getByText("기능 동작")).toBeTruthy();
    expect(screen.getByText("데이터 흐름")).toBeTruthy();
    expect(screen.getByText("구현 완성도")).toBeTruthy();
    // 4번째 원인은 상위 3개 밖이라 보이지 않는다.
    expect(screen.queryByText("예외 상황")).toBeNull();

    expect(screen.getByText("20건")).toBeTruthy();
    expect(screen.getByText("40%")).toBeTruthy();
  });

  it("shows human label counts", async () => {
    render(<CalibrationPanel projectId="p1" />);

    expect(await screen.findByText("오탐(통과했어야 함) 3")).toBeTruthy();
    expect(screen.getByText("미탐(문제 있는데 통과) 2")).toBeTruthy();
    expect(screen.getByText("정확 1")).toBeTruthy();
  });

  it("marks a fail rate below the baseline as a negative delta", async () => {
    mocks.calibration.mockResolvedValue({ ...stats, failRate: 30, failRateDelta: -18 });
    render(<CalibrationPanel projectId="p1" />);

    expect(await screen.findByText("기준선 48% 대비 -18%p")).toBeTruthy();
  });

  it("shows an empty state instead of crashing when no cause is classified", async () => {
    mocks.calibration.mockResolvedValue({
      ...stats,
      causes: [],
      labels: { total: 0, falsePositive: 0, falseNegative: 0, correct: 0 },
    });
    render(<CalibrationPanel projectId="p1" />);

    expect(await screen.findByText("아직 분류된 실패 원인이 없습니다")).toBeTruthy();
    expect(screen.getByText("아직 사람이 검토한 판정이 없습니다")).toBeTruthy();
  });

  it("shows an empty state when the project has no verification record", async () => {
    mocks.calibration.mockResolvedValue({
      total: 0, passed: 0, conditional: 0, failed: 0,
      failRate: null, baselineFailRate: 48, failRateDelta: null,
      causes: [],
      labels: { total: 0, falsePositive: 0, falseNegative: 0, correct: 0 },
    } satisfies CalibrationStats);
    render(<CalibrationPanel projectId="p-empty" />);

    expect(await screen.findByText("아직 검증 기록이 없어 정확도를 계산할 수 없습니다")).toBeTruthy();
    expect(screen.queryByText("주요 실패 원인")).toBeNull();
  });

  it("refreshes the label counts when a verdict is labeled", async () => {
    render(<CalibrationPanel projectId="p1" />);
    expect(await screen.findByText("오탐(통과했어야 함) 3")).toBeTruthy();

    mocks.calibration.mockResolvedValue({
      ...stats,
      labels: { total: 7, falsePositive: 4, falseNegative: 2, correct: 1 },
    });
    act(() => {
      window.dispatchEvent(new CustomEvent("crewdeck:verification-labeled", { detail: { verification_id: "v1" } }));
    });

    expect(await screen.findByText("오탐(통과했어야 함) 4")).toBeTruthy();
  });

  it("hides the panel instead of breaking the verification log when the request fails", async () => {
    mocks.calibration.mockRejectedValue(new Error("offline"));
    const { container } = render(<CalibrationPanel projectId="p-error" />);

    await vi.waitFor(() => expect(mocks.calibration).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
