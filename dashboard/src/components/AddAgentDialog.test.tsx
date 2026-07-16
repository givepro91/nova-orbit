// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.hoisted(() => {
  const storage = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => storage.clear(),
  };
});

const mocks = vi.hoisted(() => ({
  presets: vi.fn(),
  scanProject: vi.fn(),
  teamPreview: vi.fn(),
  applyTeamPreview: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: { agents: mocks },
}));

import "../i18n";
import { AddAgentDialog } from "./AddAgentDialog";

beforeEach(() => {
  localStorage.setItem("crewdeck-language", "en");
  mocks.presets.mockResolvedValue([]);
  mocks.scanProject.mockResolvedValue({ agents: [] });
  mocks.teamPreview.mockResolvedValue({
    projectId: "p1",
    goal: { id: "g1", title: "Repair evidence freshness", description: "Reject stale data", hasPlan: true, taskCount: 2 },
    existingAgents: [{ id: "reviewer1", name: "Reviewer", role: "reviewer" }],
    preservedExisting: 1,
    additions: 1,
    updates: 1,
    conflicts: 0,
    candidates: [
      {
        key: "backend", matchedAgentId: null, name: "Freshness Backend", role: "backend",
        reason: "Own timestamp validation", systemPrompt: "Implement freshness validation.", source: "ai",
        model: "sonnet", provider: null, action: "add", warnings: [],
      },
      {
        key: "reviewer", matchedAgentId: "reviewer1", name: "Reviewer", role: "reviewer",
        reason: "Independent evidence review", systemPrompt: "Review freshness adversarially.", source: "ai",
        model: "opus", provider: null, action: "update", warnings: ["configuration_diff"],
      },
      {
        key: "kept", matchedAgentId: "qa1", name: "QA", role: "qa",
        reason: "Already staffed", systemPrompt: "Run tests.", source: "project-agents",
        model: null, provider: null, action: "keep", warnings: ["already_exists"],
      },
    ],
  });
  mocks.applyTeamPreview.mockResolvedValue({
    goalId: "g1",
    preserved: 1,
    created: [{ id: "backend1", name: "Freshness Backend" }],
    updated: [{ id: "reviewer1", name: "Reviewer" }],
    skipped: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AddAgentDialog goal-aware smart team", () => {
  it("previews the selected goal diff, allows provider/prompt edits, and applies only after confirmation", async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(
      <AddAgentDialog
        projectId="p1"
        mission="Ship reliable evidence"
        goal={{ id: "g1", title: "Repair evidence freshness" }}
        initialSmart
        existingAgents={[{ id: "reviewer1", name: "Reviewer", role: "reviewer" }]}
        onCreated={onCreated}
        onClose={onClose}
      />,
    );

    expect(await screen.findByRole("dialog", { name: /Smart Team Setup/i })).toBeTruthy();
    expect(await screen.findByText("Repair evidence freshness")).toBeTruthy();
    expect(screen.getByText(/Keep 1 · add 1 · update 1/)).toBeTruthy();
    expect(mocks.applyTeamPreview).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Select changes for QA" })).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByRole("combobox", { name: "Provider for Freshness Backend" }), { target: { value: "codex" } });
    fireEvent.click(screen.getAllByText("Review or edit role instructions")[0]);
    fireEvent.change(screen.getByRole("textbox", { name: "Role instructions for Freshness Backend" }), {
      target: { value: "Implement and test signed timestamp freshness." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply selected changes" }));

    await waitFor(() => expect(mocks.applyTeamPreview).toHaveBeenCalledTimes(1));
    expect(mocks.applyTeamPreview).toHaveBeenCalledWith("p1", "g1", expect.arrayContaining([
      expect.objectContaining({ name: "Freshness Backend", provider: "codex", systemPrompt: "Implement and test signed timestamp freshness." }),
      expect.objectContaining({ name: "Reviewer", matchedAgentId: "reviewer1" }),
    ]));
    expect(onCreated).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalled();
  });
});
