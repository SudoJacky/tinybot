// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopShell } from "./DesktopShell";
import type { AppServices } from "../services";

afterEach(() => cleanup());

function createServices(): AppServices {
  return {
    sessionStore: {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: "s1", chatId: "chat-1", title: "New session", updatedAtMs: Date.now() })),
      delete: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      pin: vi.fn(async () => undefined),
      archive: vi.fn(async () => undefined),
    },
    chatStore: {
      load: vi.fn(async () => []),
      send: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      branchFromMessage: vi.fn(async () => ({ id: "s1", chatId: "chat-1", title: "Branch", updatedAtMs: Date.now() })),
      copyMarkdown: vi.fn(async () => ""),
      subscribe: vi.fn(() => () => undefined),
    },
  };
}

describe("DesktopShell", () => {
  it("renders native-style top menus and React-only navigation placeholders", async () => {
    const user = userEvent.setup();
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={createServices()} />);

    for (const menu of ["App", "Resources", "System", "Help"]) {
      expect(screen.getByRole("button", { name: menu })).toBeTruthy();
    }

    await user.click(screen.getByRole("button", { name: "Knowledge" }));
    expect(screen.getByRole("heading", { name: "Knowledge" })).toBeTruthy();
    expect(screen.getByText(/placeholder/i)).toBeTruthy();
    expect(screen.queryByText(/Vue/i)).toBeNull();
  });

  it("opens and closes the command palette from the keyboard", async () => {
    const user = userEvent.setup();
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={createServices()} />);

    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });
});
