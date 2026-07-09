import { describe, it, expect } from "vitest";
import { resolveArtifactPath } from "../api/routes/goals.js";

describe("resolveArtifactPath", () => {
  it("resolves a safe name inside the dir", () => {
    const p = resolveArtifactPath("/data/artifacts/goals/g1", "cc-shots-after.png");
    expect(p).toBe("/data/artifacts/goals/g1/cc-shots-after.png");
  });
  it("rejects traversal and nested paths", () => {
    expect(resolveArtifactPath("/data/artifacts/goals/g1", "../../secret")).toBeNull();
    expect(resolveArtifactPath("/data/artifacts/goals/g1", "a/b.png")).toBeNull();
    expect(resolveArtifactPath("/data/artifacts/goals/g1", "..")).toBeNull();
  });
});
