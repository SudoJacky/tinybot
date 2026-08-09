// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryStore } from "../services";
import { MemoryPage } from "./MemoryPage";

afterEach(() => cleanup());

describe("MemoryPage", () => {
  it("shows active user and workspace memory and refreshes it", async () => {
    const load = vi.fn(async () => ({
      currentWorkspacePath: "D:\\Code\\py\\tinybot",
      userMemories: ["User prefers concise answers."],
      workspaces: [
        {
          current: false,
          path: "D:\\Code\\other",
          memories: ["This workspace uses pnpm."],
        },
        {
          current: true,
          path: "D:\\Code\\py\\tinybot",
          memories: ["This workspace uses Rust."],
        },
      ],
    }));
    const user = userEvent.setup();
    render(<MemoryPage memoryStore={{ load }} />);

    expect(await screen.findByText("User prefers concise answers.")).toBeTruthy();
    expect(screen.getByText("This workspace uses Rust.")).toBeTruthy();
    expect(screen.getByText("Current workspace")).toBeTruthy();
    expect(screen.getByText(/Existing chats keep the memory snapshot/)).toBeTruthy();
    expect(screen.getByLabelText("Memory summary").textContent).toContain("3 total");
    expect(within(screen.getAllByRole("article")[0]).getByText("Current workspace")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Refresh memory" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("shows a meaningful empty state", async () => {
    const memoryStore: MemoryStore = {
      load: vi.fn(async () => ({
        currentWorkspacePath: "D:\\Code\\py\\tinybot",
        userMemories: [],
        workspaces: [{ current: true, path: "D:\\Code\\py\\tinybot", memories: [] }],
      })),
    };
    render(<MemoryPage memoryStore={memoryStore} />);

    expect(await screen.findByText("No active memory yet")).toBeTruthy();
  });

  it("reports load failures and retries", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("memory database is unavailable"))
      .mockResolvedValueOnce({ currentWorkspacePath: "D:\\Code\\py\\tinybot", userMemories: [], workspaces: [] });
    const user = userEvent.setup();
    render(<MemoryPage memoryStore={{ load }} />);

    expect((await screen.findByRole("alert")).textContent).toContain("memory database is unavailable");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No active memory yet")).toBeTruthy();
  });
});
