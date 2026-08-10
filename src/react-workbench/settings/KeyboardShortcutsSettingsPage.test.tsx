// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SHORTCUTS_STORAGE_KEY } from "../../app-core/settings/appShortcuts";
import { AppShortcutProvider } from "./AppShortcutContext";
import { KeyboardShortcutsSettingsPage } from "./KeyboardShortcutsSettingsPage";

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe("KeyboardShortcutsSettingsPage", () => {
  test("records and persists a reassigned shortcut", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Edit New chat shortcut" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Record shortcut for New chat" }), {
      code: "KeyN",
      ctrlKey: true,
      key: "N",
      shiftKey: true,
    });

    expect(screen.getByText("Ctrl+Shift+N")).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY) ?? "{}")["new-chat"])
      .toBe("Ctrl+Shift+N");
  });

  test("keeps the recorder active and reports a conflicting global binding", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Edit Documentation shortcut" }));
    const recorder = screen.getByRole("button", { name: "Record shortcut for Documentation" });
    fireEvent.keyDown(recorder, { code: "KeyB", ctrlKey: true, key: "b" });

    expect(screen.getByRole("alert").textContent).toContain("Toggle sidebar");
    expect(recorder).toBeTruthy();
  });

  test("filters commands and clears a binding", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByRole("searchbox", { name: "Search shortcuts" }), "theme");
    const list = screen.getByText("Toggle theme").closest(".react-shortcuts-list");
    expect(list).toBeTruthy();
    expect(within(list as HTMLElement).queryByText("New chat")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Clear Toggle theme shortcut" }));
    expect(screen.getByText("Unassigned")).toBeTruthy();
  });
});

function renderPage() {
  return render(
    <AppShortcutProvider>
      <KeyboardShortcutsSettingsPage />
    </AppShortcutProvider>,
  );
}
