// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// i18n reads localStorage at import time — stub it before that import runs.
vi.hoisted(() => {
  const storage = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => storage.clear(),
  };
});

import "../i18n";
import { AddGoalDialog } from "./ProjectHome";

type Suggestion = { title: string; description: string; priority: string; reason: string };
const suggestion = (title: string): Suggestion => ({
  title,
  description: `${title} description`,
  priority: "medium",
  reason: `${title} reason`,
});

const baseProps = {
  onCreateWithSpec: () => {},
  onCancel: () => {},
  suggestLoading: false,
  suggestError: "",
  suggestErrorDetail: "",
  onStartSuggest: () => {},
  onDismissSuggestions: () => {},
};

afterEach(cleanup);

describe("AddGoalDialog multi-select add", () => {
  // Regression: parallel multi-project use. The `suggestions` prop is reactive and
  // can swap/shrink (project switch, re-suggest) while the internal selection still
  // holds an index into the OLD array. Before the fix, that stale index resolved to
  // `undefined` and `.title` threw at the top of the loop — aborting the whole batch
  // and silently losing EVERY selected goal (the reported "proof goal 유실").
  it("creates every still-valid selection when a selected index has gone stale", async () => {
    const created: string[] = [];
    const onCreateDirect = vi.fn(async (title: string) => { created.push(title); });

    const { rerender } = render(
      <AddGoalDialog
        {...baseProps}
        onCreateDirect={onCreateDirect}
        suggestions={[suggestion("Alpha"), suggestion("Beta"), suggestion("Gamma")]}
      />,
    );

    // Select the item that will go stale FIRST, then two that survive — so a throw
    // on the stale entry would abort before Alpha/Beta ever get created.
    fireEvent.click(screen.getByText("Gamma"));
    fireEvent.click(screen.getByText("Alpha"));
    fireEvent.click(screen.getByText("Beta"));

    // Suggestions shrink under us; index 2 (Gamma) is now out of range.
    rerender(
      <AddGoalDialog
        {...baseProps}
        onCreateDirect={onCreateDirect}
        suggestions={[suggestion("Alpha"), suggestion("Beta")]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Add Selected Goals/ }));

    await vi.waitFor(() => expect(onCreateDirect).toHaveBeenCalledTimes(2));
    expect([...created].sort()).toEqual(["Alpha", "Beta"]);
  });

  it("resets submitting so the dialog is not wedged after a create rejects", async () => {
    const onCreateDirect = vi.fn(async () => { throw new Error("create failed"); });

    render(
      <AddGoalDialog
        {...baseProps}
        onCreateDirect={onCreateDirect}
        suggestions={[suggestion("Alpha")]}
      />,
    );

    fireEvent.click(screen.getByText("Alpha"));
    const addButton = screen.getByRole("button", { name: /Add Selected Goals/ }) as HTMLButtonElement;
    fireEvent.click(addButton);

    // finally{} must re-enable the button (submitting=false) instead of leaving it
    // stuck disabled after the rejection.
    await vi.waitFor(() => expect(addButton.disabled).toBe(false));
  });
});
