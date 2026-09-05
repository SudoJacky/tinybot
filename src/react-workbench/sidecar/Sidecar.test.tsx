// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidecar } from "./Sidecar";
import type { SidecarTab } from "./sidecarModel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tabs: SidecarTab[] = [
  { id: "browser-1", kind: "browser", threadId: "thread-1", title: "Tinybot Docs" },
  { id: "terminal-1", kind: "terminal", shell: "powershell", title: "PowerShell", workspaceId: "D:/code/tinybot" },
  { artifactId: "chart-1", id: "artifact-1", kind: "artifact", threadId: "thread-1", title: "Data View" },
];

function renderSidecar(overrides: Partial<Parameters<typeof Sidecar>[0]> = {}) {
  const props: Parameters<typeof Sidecar>[0] = {
    scopeKey: "thread-1",
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

function mockWorkspaceWidth(readWidth: () => number) {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getBoundingClientRect(this: HTMLElement) {
    const width = this.firstElementChild?.classList.contains("react-sidecar") ? readWidth() : 0;
    return {
      bottom: 0,
      height: 0,
      left: 0,
      right: width,
      toJSON: () => ({}),
      top: 0,
      width,
      x: 0,
      y: 0,
    };
  });
}

describe("Sidecar", () => {
  it("retains closing browser chrome while hiding its native surface and cancels stale exits", async () => {
    const { props, rerender } = renderSidecar({ activeTabId: "browser-1" });
    const aside = screen.getByLabelText("Sidecar");
    let finish!: () => void;
    const animation = {
      transitionProperty: "transform",
      playState: "running",
      finished: new Promise<void>((resolve) => { finish = resolve; }),
    };
    Object.defineProperty(aside, "getAnimations", { value: () => [animation], configurable: true });
    rerender(<Sidecar {...props} presentation="closed" />);
    expect(aside.hasAttribute("inert")).toBe(true);
    expect(screen.getByText("Browser surface hidden")).toBeTruthy();
    rerender(<Sidecar {...props} />);
    await act(async () => { animation.playState = "finished"; finish(); });
    expect(screen.getByText("Browser surface visible")).toBeTruthy();
    rerender(<Sidecar {...props} presentation="closed" />);
    expect(screen.queryByText(/Browser surface/)).toBeNull();
    expect(props.onCloseTab).not.toHaveBeenCalled();
  });

  it("waits for the desktop grid exit, but removes incompatible content on scope changes", async () => {
    const { props, rerender } = renderSidecar({ presentation: "expanded" });
    const aside = screen.getByLabelText("Sidecar");
    let finish!: () => void;
    const animation = {
      transitionProperty: "grid-template-columns",
      playState: "running",
      finished: new Promise<void>((resolve) => { finish = resolve; }),
    };
    Object.defineProperty(aside.parentElement, "getAnimations", { value: () => [animation], configurable: true });
    rerender(<Sidecar {...props} presentation="closed" />);
    expect(aside.dataset.presentation).toBe("expanded");
    expect(screen.getByText("Terminal surface")).toBeTruthy();
    rerender(<Sidecar {...props} presentation="closed" scopeKey="different-thread" />);
    expect(aside.dataset.presentation).toBe("closed");
    expect(screen.queryByText("Terminal surface")).toBeNull();
    await act(async () => { animation.playState = "finished"; finish(); });
    expect(props.onCloseTab).not.toHaveBeenCalled();
  });

  it("keeps a non-interactive shell mounted while closed", () => {
    const renderTerminal = vi.fn(() => <p>Terminal surface</p>);
    const { container } = renderSidecar({ presentation: "closed", renderTerminal });
    const sidecar = container.querySelector<HTMLElement>(".react-sidecar");

    expect(sidecar?.dataset.hidden).toBe("true");
    expect(sidecar?.getAttribute("aria-hidden")).toBe("true");
    expect(sidecar?.hasAttribute("inert")).toBe(true);
    expect(screen.queryByLabelText("Sidecar")).toBeNull();
    expect(renderTerminal).not.toHaveBeenCalled();
  });

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

  it("uses the actual workspace width while dragging", () => {
    vi.stubGlobal("innerWidth", 1116);
    mockWorkspaceWidth(() => 840);
    const { props } = renderSidecar();
    const separator = screen.getByRole("separator", { name: "Resize Sidecar" });

    fireEvent.pointerDown(separator, { button: 0, clientX: 600 });
    fireEvent.pointerMove(window, { clientX: 0 });
    fireEvent.pointerUp(window);

    expect(props.onResize).toHaveBeenLastCalledWith(1080, 520);
  });

  it("reclamps a restored width when the workspace mounts or narrows", () => {
    vi.stubGlobal("innerWidth", 1116);
    let workspaceWidth = 840;
    mockWorkspaceWidth(() => workspaceWidth);
    const { props, rerender } = renderSidecar({ width: 900 });

    expect(props.onResize).toHaveBeenCalledWith(900, 520);

    vi.mocked(props.onResize).mockClear();
    rerender(<Sidecar {...props} width={520} />);
    workspaceWidth = 700;
    fireEvent(window, new Event("resize"));

    expect(props.onResize).toHaveBeenCalledWith(520, 380);
  });
});
