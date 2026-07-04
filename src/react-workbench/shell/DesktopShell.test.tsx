// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopShell } from "./DesktopShell";
import type { AppServices } from "../services";

afterEach(() => cleanup());

function createServices(): AppServices & {
  workspaceStore: { listFiles: ReturnType<typeof vi.fn> };
  knowledgeStore: { listDocuments: ReturnType<typeof vi.fn>; stats: ReturnType<typeof vi.fn> };
  toolsStore: { listSkills: ReturnType<typeof vi.fn> };
  settingsStore: { load: ReturnType<typeof vi.fn> };
} {
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
    workspaceStore: {
      listFiles: vi.fn(async () => [
        { path: "src/main.ts", size: 512 },
        { path: "docs/notes.md", size: 2048 },
      ]),
    },
    knowledgeStore: {
      listDocuments: vi.fn(async () => [
        { id: "doc-1", title: "Project Plan", source: "docs/plan.md" },
      ]),
      stats: vi.fn(async () => [{ label: "Documents", value: "1" }]),
    },
    toolsStore: {
      listSkills: vi.fn(async () => [
        { name: "review-code", description: "Review current changes" },
      ]),
    },
    settingsStore: {
      load: vi.fn(async () => [{ label: "Default model", value: "tinybot" }]),
    },
  };
}

describe("DesktopShell", () => {
  it("keeps the React window frame draggable and top menus compact", () => {
    const controls = {
      startDragging: vi.fn(async () => undefined),
      toggleMaximize: vi.fn(async () => undefined),
    };
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={createServices()} windowControls={controls} />);

    const frame = document.querySelector(".react-window-frame");
    expect(frame?.getAttribute("data-tauri-drag-region")).toBe("");

    const appMenuButton = screen.getByRole("button", { name: "App" });
    expect(appMenuButton.querySelector(".react-top-menu__icon")).toBeTruthy();
    expect(appMenuButton.querySelector(".react-top-menu__label")?.textContent).toBe("App");

    fireEvent.pointerDown(frame as Element);
    expect(controls.startDragging).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(appMenuButton);
    expect(controls.startDragging).toHaveBeenCalledTimes(1);

    fireEvent.doubleClick(frame as Element);
    expect(controls.toggleMaximize).toHaveBeenCalledTimes(1);

    fireEvent.doubleClick(appMenuButton);
    expect(controls.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("renders native-style top menus and functional secondary pages", async () => {
    const user = userEvent.setup();
    const services = createServices();
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={services} />);

    for (const menu of ["App", "Resources", "System", "Help"]) {
      expect(screen.getByRole("button", { name: menu })).toBeTruthy();
    }

    await user.click(screen.getByRole("button", { name: "Files" }));
    expect(await screen.findByRole("heading", { name: "Workspace Files" })).toBeTruthy();
    expect(screen.getByText("src/main.ts")).toBeTruthy();
    expect(services.workspaceStore.listFiles).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Knowledge" }));
    expect(await screen.findByRole("heading", { name: "Knowledge" })).toBeTruthy();
    expect(screen.getByText("Project Plan")).toBeTruthy();
    expect(screen.getByText("Documents")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Tools" }));
    expect(await screen.findByRole("heading", { name: "Tools & Skills" })).toBeTruthy();
    expect(screen.getByText("review-code")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByText("Default model")).toBeTruthy();

    expect(screen.queryByText(/placeholder/i)).toBeNull();
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

  it("runs route commands from the command palette", async () => {
    const user = userEvent.setup();
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={createServices()} />);

    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("textbox", { name: "Search commands" }), "files");
    await user.click(screen.getByRole("button", { name: "Open Files" }));

    expect(await screen.findByRole("heading", { name: "Workspace Files" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });
});
