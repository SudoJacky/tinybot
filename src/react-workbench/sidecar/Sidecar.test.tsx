// @vitest-environment happy-dom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidecar } from "./Sidecar";
import type { SidecarTab } from "./sidecarModel";

afterEach(cleanup);

const tabs: SidecarTab[] = [
  { id: "browser-1", kind: "browser", threadId: "thread-1", title: "Tinybot Docs" },
  { id: "terminal-1", kind: "terminal", shell: "powershell", title: "PowerShell", workspaceId: "D:/code/tinybot" },
  { artifactId: "chart-1", id: "artifact-1", kind: "artifact", threadId: "thread-1", title: "Data View" },
];

function renderSidecar(overrides: Partial<Parameters<typeof Sidecar>[0]> = {}) {
  const props: Parameters<typeof Sidecar>[0] = {
    activeTabId: "terminal-1",
    canCreateBrowser: true,
    canCreateTerminal: true,
    onActivateTab: vi.fn(),
    onCloseTab: vi.fn(),
    onCreateBrowser: vi.fn(),
    onCreateTerminal: vi.fn(),
    onHide: vi.fn(),
    onResize: vi.fn(),
    onToggleExpanded: vi.fn(),
    presentation: "docked",
    renderArtifact: () => <p>Artifact content</p>,
    renderBrowser: (_tab, surfaceVisible) => <p>Browser surface {surfaceVisible ? "visible" : "hidden"}</p>,
    renderTerminal: () => <p>Terminal surface</p>,
    tabs,
    width: 480,
    ...overrides,
  };
  return { props, ...render(<Sidecar {...props} />) };
}

describe("Sidecar", () => {
  it("renders resource tabs and exposes only Browser and Terminal in the New Tab menu", async () => {
    const user = userEvent.setup();
    renderSidecar();

    expect(screen.getAllByRole("tab")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "New Sidecar tab" }));

    const menu = screen.getByRole("menu", { name: "Choose a resource" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(2);
    expect(within(menu).getByRole("menuitem", { name: /Browser/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Terminal/ })).toBeTruthy();
    expect(within(menu).queryByText("Artifacts")).toBeNull();
  });

  it("creates the selected resource and closes the New Tab menu", async () => {
    const user = userEvent.setup();
    const { props } = renderSidecar();

    await user.click(screen.getByRole("button", { name: "New Sidecar tab" }));
    await user.click(screen.getByRole("menuitem", { name: /Terminal/ }));
    await user.click(screen.getByRole("menuitem", { name: "PowerShell" }));

    expect(props.onCreateTerminal).toHaveBeenCalledWith("powershell");
    expect(screen.queryByRole("menu", { name: "Choose a resource" })).toBeNull();
  });

  it("lets the user create a Command Prompt terminal", async () => {
    const user = userEvent.setup();
    const { props } = renderSidecar();

    await user.click(screen.getByRole("button", { name: "New Sidecar tab" }));
    await user.click(screen.getByRole("menuitem", { name: /Terminal/ }));
    await user.click(screen.getByRole("menuitem", { name: "Command Prompt" }));

    expect(props.onCreateTerminal).toHaveBeenCalledWith("cmd");
  });

  it("marks the native browser surface obscured while the New Tab menu is open", async () => {
    const user = userEvent.setup();
    renderSidecar({ activeTabId: "browser-1" });

    expect(screen.getByText("Browser surface visible")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "New Sidecar tab" }));
    expect(screen.getByText("Browser surface hidden")).toBeTruthy();
  });

  it("supports arrow-key tab navigation and Delete to close", async () => {
    const user = userEvent.setup();
    const { props } = renderSidecar();
    const active = screen.getByRole("tab", { name: "PowerShell" });

    active.focus();
    await user.keyboard("{ArrowRight}");
    expect(props.onActivateTab).toHaveBeenCalledWith("artifact-1");

    active.focus();
    await user.keyboard("{Delete}");
    expect(props.onCloseTab).toHaveBeenCalledWith(tabs[1]);
  });

  it("resizes by keyboard and disables the separator when expanded", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderSidecar();
    const separator = screen.getByRole("separator", { name: "Resize Sidecar" });

    separator.focus();
    await user.keyboard("{ArrowLeft}");
    expect(props.onResize).toHaveBeenCalledWith(504, expect.any(Number));

    rerender(<Sidecar {...props} presentation="expanded" />);
    expect(screen.getByRole("separator", { name: "Resize Sidecar" }).getAttribute("aria-disabled")).toBe("true");
  });
});
