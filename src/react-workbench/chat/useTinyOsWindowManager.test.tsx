// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { TinyOsWindow } from "../../app-core/chat/tinyOsDesktopModel";
import { useTinyOsWindowManager } from "./useTinyOsWindowManager";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const windows: TinyOsWindow[] = [
  { appId: "files", entries: [], id: "files-window", sourceItemIds: [], title: "Files" },
  { appId: "browser", entries: [], id: "browser-window", sourceItemIds: [], title: "Browser" },
];

function WindowManagerHarness({ browserSessionAvailable = false, sessionKey = "session-window-manager-test" }: { browserSessionAvailable?: boolean; sessionKey?: string }) {
  const manager = useTinyOsWindowManager({
    activeAppId: "files",
    browserNeedsUser: false,
    browserSessionAvailable,
    history: false,
    layoutMode: "workspace",
    sessionKey,
    syncKey: browserSessionAvailable ? "browser-ready" : "initial",
    windows,
    workspaceKey: "workspace-window-manager-test",
  });
  return <section ref={manager.desktopRef}>
    <output aria-label="Focused app">{manager.state.focusedAppId}</output>
    <output aria-label="Visible apps">{manager.visibleWindows.map(({ appId }) => appId).join(",")}</output>
    <button type="button" onClick={() => manager.actions.focus("files")}>Focus files</button>
    <button type="button" onClick={() => manager.actions.minimize("files")}>Minimize files</button>
    <button type="button" onClick={() => manager.actions.reset()}>Reset layout</button>
  </section>;
}

describe("TinyOS window manager", () => {
  it("owns focus, minimization, and deterministic reset actions", async () => {
    const user = userEvent.setup();
    render(<WindowManagerHarness />);

    await user.click(screen.getByRole("button", { name: "Focus files" }));
    expect(screen.getByRole("status", { name: "Focused app" }).textContent).toBe("files");
    await user.click(screen.getByRole("button", { name: "Minimize files" }));
    expect(screen.getByRole("status", { name: "Visible apps" }).textContent).toBe("browser");
    await user.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(screen.getByRole("status", { name: "Visible apps" }).textContent).toBe("files,browser");
  });

  it("focuses the browser once when its native session becomes available", async () => {
    const view = render(<WindowManagerHarness sessionKey="session-browser-focus-test" />);
    expect(screen.getByRole("status", { name: "Focused app" }).textContent).toBe("files");

    view.rerender(<WindowManagerHarness browserSessionAvailable sessionKey="session-browser-focus-test" />);
    await waitFor(() => expect(screen.getByRole("status", { name: "Focused app" }).textContent).toBe("browser"));
  });
});
