// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemorySnapshot, MemoryStore } from "../services";
import { MemoryPage } from "./MemoryPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function snapshot(): MemorySnapshot {
  return {
    currentWorkspacePath: "D:\\Code\\py\\tinybot",
    revision: 3,
    entries: [
      {
        id: 1,
        scope: "user",
        path: null,
        content: "User prefers concise answers.",
        userManaged: false,
      },
      {
        id: 2,
        scope: "workspace",
        path: "D:\\Code\\other",
        content: "This workspace uses pnpm.",
        userManaged: false,
      },
      {
        id: 3,
        scope: "workspace",
        path: "D:\\Code\\py\\tinybot",
        content: "This workspace uses Rust.",
        userManaged: true,
      },
    ],
  };
}
function store(): MemoryStore {
  let current = snapshot();
  return {
    load: vi.fn(async () => current),
    mutate: vi.fn(async ({ mutation, expectedRevision }) => {
      if (expectedRevision !== current.revision) throw new Error("Memory changed. Reload memory.");
      const entries =
        mutation.operation === "delete"
          ? current.entries.filter((entry) => !mutation.ids.includes(entry.id))
          : mutation.operation === "update"
            ? current.entries.map((entry) =>
                entry.id === mutation.id ? { ...entry, ...mutation, userManaged: true } : entry,
              )
            : [...current.entries, { id: 4, ...mutation, userManaged: true }];
      current = { ...current, revision: current.revision + 1, entries };
      return current;
    }),
  };
}

describe("MemoryPage", () => {
  it("dismisses the scope menu before closing the memory editor with Escape", async () => {
    const user = userEvent.setup();
    render(<MemoryPage memoryStore={store()} />);
    await user.click(
      await screen.findByRole("button", { name: "Edit memory: User prefers concise answers." }),
    );
    const trigger = screen.getByRole("button", { name: /^Applies to:/ });
    await user.click(trigger);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("menuitemradio", { name: "All workspaces (user memory)" }),
      ),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("shows grouped memory, protection, and refreshes the canonical snapshot", async () => {
    const memoryStore = store(),
      user = userEvent.setup();
    render(<MemoryPage memoryStore={memoryStore} />);
    expect(await screen.findByText("User prefers concise answers.")).toBeTruthy();
    expect(screen.getByText("This workspace uses Rust.")).toBeTruthy();
    expect(screen.getByText("User-managed")).toBeTruthy();
    expect(screen.getByText(/Existing chats keep the memory snapshot/)).toBeTruthy();
    expect(screen.getByLabelText("Memory summary").textContent).toContain("3 total");
    expect(within(screen.getAllByRole("article")[0]).getByText("Current workspace")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Refresh memory" }));
    await waitFor(() => expect(memoryStore.load).toHaveBeenCalledTimes(2));
  });
  it("adds memory in an empty library with an explicit workspace scope", async () => {
    const current = { ...snapshot(), entries: [] };
    const memoryStore = { load: vi.fn(async () => current), mutate: vi.fn(async () => snapshot()) };
    const user = userEvent.setup();
    render(<MemoryPage memoryStore={memoryStore} />);
    expect(await screen.findByText("No active memory yet")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add memory" }));
    await user.type(screen.getByLabelText("Memory content"), "  Use cargo for builds.  ");
    await user.click(screen.getByRole("button", { name: /^Applies to:/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "One workspace" }));
    await user.click(screen.getByRole("button", { name: "Save memory" }));
    await waitFor(() =>
      expect(memoryStore.mutate).toHaveBeenCalledWith({
        expectedRevision: 3,
        mutation: {
          operation: "create",
          scope: "workspace",
          path: current.currentWorkspacePath,
          content: "Use cargo for builds.",
        },
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("edits the identified entry, changes its scope, and shows user ownership", async () => {
    const memoryStore = store(),
      user = userEvent.setup();
    render(<MemoryPage memoryStore={memoryStore} />);
    await user.click(
      await screen.findByRole("button", { name: "Edit memory: User prefers concise answers." }),
    );
    await user.clear(screen.getByLabelText("Memory content"));
    await user.type(screen.getByLabelText("Memory content"), "Give detailed explanations.");
    await user.click(screen.getByRole("button", { name: /^Applies to:/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "One workspace" }));
    await user.click(screen.getByRole("button", { name: "Save memory" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(memoryStore.mutate).toHaveBeenCalledWith({
      expectedRevision: 3,
      mutation: {
        operation: "update",
        id: 1,
        scope: "workspace",
        path: snapshot().currentWorkspacePath,
        content: "Give detailed explanations.",
      },
    });
    expect(screen.getAllByText("User-managed")).toHaveLength(2);
  });
  it("only batch deletes visible selections and confirms before changing memory", async () => {
    const memoryStore = store(),
      user = userEvent.setup();
    render(<MemoryPage memoryStore={memoryStore} />);
    await screen.findByText("User prefers concise answers.");
    await user.type(screen.getByRole("searchbox"), "uses");
    await user.click(screen.getByRole("button", { name: /^Filter by scope:/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Current workspace" }));
    expect(screen.queryByText("This workspace uses pnpm.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByLabelText("Select visible"));
    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    expect(memoryStore.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").textContent).toContain(
      "Similar memories may be learned again",
    );
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(memoryStore.mutate).toHaveBeenCalledWith({
        expectedRevision: 3,
        mutation: { operation: "delete", ids: [3] },
      }),
    );
    expect(screen.getByLabelText("Memory summary").textContent).toContain("2 total");
  });
  it("preserves the edit draft and original entry when saving fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const memoryStore = store();
    memoryStore.mutate = vi.fn(async () => {
      throw new Error("Memory changed. Reload memory.");
    });
    const user = userEvent.setup();
    render(<MemoryPage memoryStore={memoryStore} />);
    await user.click(
      await screen.findByRole("button", { name: "Edit memory: User prefers concise answers." }),
    );
    await user.type(screen.getByLabelText("Memory content"), " Correction.");
    await user.click(screen.getByRole("button", { name: "Save memory" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Reload memory");
    expect((screen.getByLabelText("Memory content") as HTMLTextAreaElement).value).toContain(
      "Correction.",
    );
    expect(screen.getByText("User prefers concise answers.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("reports load failures and retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const memoryStore = store();
    memoryStore.load = vi
      .fn()
      .mockRejectedValueOnce(new Error("memory database is unavailable"))
      .mockResolvedValueOnce({ ...snapshot(), entries: [] });
    const user = userEvent.setup();
    render(<MemoryPage memoryStore={memoryStore} />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "memory database is unavailable",
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No active memory yet")).toBeTruthy();
  });
});
