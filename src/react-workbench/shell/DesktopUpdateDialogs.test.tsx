// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopUpdateClient, DesktopUpdateSnapshot } from "../../app-core/native/desktopNativeUpdate";
import { DESKTOP_UPDATE_NOTES_STORAGE_KEY } from "../../app-core/native/desktopUpdateNotes";
import { DesktopUpdateDialogs } from "./DesktopUpdateDialogs";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const availableUpdate: DesktopUpdateSnapshot = {
  currentVersion: "0.1.3",
  availableVersion: "0.2.0",
  releaseNotes: "Faster browser startup and a repaired update flow.",
  displayNotes: "Save active work before installing.",
  publishedAt: "2026-08-02T12:00:00Z",
  phase: "available",
  progressPercent: null,
  error: null,
};

function createClient(snapshot: DesktopUpdateSnapshot): DesktopUpdateClient & {
  install: ReturnType<typeof vi.fn>;
} {
  return {
    status: vi.fn(async () => snapshot),
    check: vi.fn(async () => snapshot),
    install: vi.fn(async (_expectedVersion: string): Promise<DesktopUpdateSnapshot> => ({
      ...snapshot,
      phase: "installing",
      progressPercent: 100,
    })),
    listen: vi.fn(async () => () => undefined),
  };
}

describe("DesktopUpdateDialogs", () => {
  it("opens the startup update prompt without starting a download", async () => {
    const client = createClient(availableUpdate);
    render(<DesktopUpdateDialogs aboutOpenSignal={0} updateClient={client} whatsNewOpenSignal={0} />);

    const dialog = await screen.findByRole("dialog", { name: "Tinybot update available" });
    expect(within(dialog).getByText("Faster browser startup and a repaired update flow.")).toBeTruthy();
    expect(within(dialog).getByText("Save active work before installing.")).toBeTruthy();
    expect(client.install).not.toHaveBeenCalled();
  });

  it("renders custom update and display notes as Markdown", async () => {
    const client = createClient({
      ...availableUpdate,
      releaseNotes: "## Highlights\n\n- Reference another workspace conversation\n- Manage **subagents** directly",
      displayNotes: "Save **active work** before installing.",
    });
    render(<DesktopUpdateDialogs aboutOpenSignal={0} updateClient={client} whatsNewOpenSignal={0} />);

    const dialog = await screen.findByRole("dialog", { name: "Tinybot update available" });
    expect(within(dialog).getByRole("heading", { name: "Highlights" })).toBeTruthy();
    expect(within(dialog).getByRole("list")).toBeTruthy();
    expect(within(dialog).getByText("subagents", { selector: "strong" })).toBeTruthy();
    expect(within(dialog).getByText("active work", { selector: "strong" })).toBeTruthy();
  });

  it("downloads and installs only after explicit confirmation", async () => {
    const user = userEvent.setup();
    const client = createClient(availableUpdate);
    render(<DesktopUpdateDialogs aboutOpenSignal={0} updateClient={client} whatsNewOpenSignal={0} />);

    const dialog = await screen.findByRole("dialog", { name: "Tinybot update available" });
    await user.click(within(dialog).getByRole("button", { name: "Download and install" }));

    expect(client.install).toHaveBeenCalledWith("0.2.0");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Installing…" })).toBeTruthy());
  });

  it("lets the user defer an update for the current app session", async () => {
    const user = userEvent.setup();
    const listeners: Array<(snapshot: DesktopUpdateSnapshot) => void> = [];
    const client = createClient(availableUpdate);
    client.listen = vi.fn(async (next) => {
      listeners.push(next);
      return () => undefined;
    });
    render(<DesktopUpdateDialogs aboutOpenSignal={0} updateClient={client} whatsNewOpenSignal={0} />);

    const dialog = await screen.findByRole("dialog", { name: "Tinybot update available" });
    await user.click(within(dialog).getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("dialog", { name: "Tinybot update available" })).toBeNull();

    listeners[0]?.(availableUpdate);
    await Promise.resolve();
    expect(screen.queryByRole("dialog", { name: "Tinybot update available" })).toBeNull();
  });

  it("reopens the latest custom notes after the updated app restarts", async () => {
    const initial = render(
      <DesktopUpdateDialogs
        aboutOpenSignal={0}
        updateClient={createClient(availableUpdate)}
        whatsNewOpenSignal={0}
      />,
    );
    await screen.findByRole("dialog", { name: "Tinybot update available" });
    initial.unmount();

    const currentSnapshot: DesktopUpdateSnapshot = {
      currentVersion: "0.2.0",
      availableVersion: null,
      releaseNotes: null,
      displayNotes: null,
      publishedAt: null,
      phase: "up_to_date",
      progressPercent: null,
      error: null,
    };
    const client = createClient(currentSnapshot);
    const current = render(
      <DesktopUpdateDialogs aboutOpenSignal={0} updateClient={client} whatsNewOpenSignal={0} />,
    );
    await waitFor(() => expect(client.status).toHaveBeenCalled());

    current.rerender(
      <DesktopUpdateDialogs aboutOpenSignal={0} updateClient={client} whatsNewOpenSignal={1} />,
    );
    const dialog = await screen.findByRole("dialog", { name: "Tinybot What's New" });
    expect(within(dialog).getByRole("heading", { name: "What's new in Tinybot 0.2.0" })).toBeTruthy();
    expect(within(dialog).getByText("Faster browser startup and a repaired update flow.")).toBeTruthy();
    expect(within(dialog).getByText("Save active work before installing.")).toBeTruthy();
  });

  it("surfaces and logs an unreadable persisted update record", async () => {
    window.localStorage.setItem(DESKTOP_UPDATE_NOTES_STORAGE_KEY, "{");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const current = render(
      <DesktopUpdateDialogs aboutOpenSignal={0} updateClient={null} whatsNewOpenSignal={0} />,
    );

    current.rerender(
      <DesktopUpdateDialogs aboutOpenSignal={0} updateClient={null} whatsNewOpenSignal={1} />,
    );
    const dialog = await screen.findByRole("dialog", { name: "Tinybot What's New" });
    expect(within(dialog).getByRole("alert").textContent).toContain("Update notes could not be loaded");
    expect(consoleError).toHaveBeenCalledWith(
      "[tinybot-updater] Failed to load the latest update notes.",
      expect.any(SyntaxError),
    );
  });
});
