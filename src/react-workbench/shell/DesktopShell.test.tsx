// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("opens legacy top menu command lists from the React window frame", async () => {
    const user = userEvent.setup();
    const services = createServices();
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={services} />);

    await user.click(screen.getByRole("button", { name: "App" }));
    const appMenu = screen.getByRole("menu", { name: "Application menu" });
    for (const item of ["New Chat", "Search Sessions", "Command Palette", "Stop Generation", "Toggle Theme", "Toggle Sidebar"]) {
      expect(within(appMenu).getByRole("menuitem", { name: new RegExp(item) })).toBeTruthy();
    }
    expect(within(appMenu).getAllByRole("separator")).toHaveLength(2);
    expect(within(appMenu).getByText("Ctrl+N").classList.contains("react-top-menu__shortcut")).toBe(true);

    await user.click(within(appMenu).getByRole("menuitem", { name: /New Chat/ }));
    await waitFor(() => expect(services.sessionStore.create).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "App" }));
    await user.click(within(screen.getByRole("menu", { name: "Application menu" })).getByRole("menuitem", { name: /Command Palette/ }));
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close command palette" }));

    await user.click(screen.getByRole("button", { name: "Resources" }));
    const resourcesMenu = screen.getByRole("menu", { name: "Resources menu" });
    expect(within(resourcesMenu).getByRole("menuitem", { name: "Chat" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "System" }));
    const systemMenu = screen.getByRole("menu", { name: "System menu" });
    expect(within(systemMenu).getByRole("menuitem", { name: "Settings (Ctrl+,)" })).toBeTruthy();
    expect(within(systemMenu).getByRole("menuitem", { name: "Gateway Status (Ctrl+Shift+G)" })).toBeTruthy();

    await user.click(within(systemMenu).getByRole("menuitem", { name: "Settings (Ctrl+,)" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Help" }));
    const helpMenu = screen.getByRole("menu", { name: "Help menu" });
    expect(within(helpMenu).getByRole("menuitem", { name: "Documentation (F1)" })).toBeTruthy();
    const moreHelp = within(helpMenu).getByRole("menuitem", { name: "More" });
    expect(moreHelp.getAttribute("aria-haspopup")).toBe("menu");

    await user.click(moreHelp);
    const moreHelpMenu = screen.getByRole("menu", { name: "More help options" });
    for (const item of ["Shortcut Help", "Page Help", "Backend Logs", "Open native workbench", "Tinybot repo"]) {
      expect(within(moreHelpMenu).getByRole("menuitem", { name: new RegExp(item) })).toBeTruthy();
    }
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
