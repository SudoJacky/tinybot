// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { DEFAULT_DESKTOP_PET_PREFERENCES } from "../../app-core/desktop-pet/desktopPetState";
import type { TeamRun } from "../../app-core/native/desktopNativeTeams";
import type { AppServices } from "../services";
import { RouteSurface } from "./RouteSurface";

vi.mock("../chat/ChatPage", () => ({ ChatPage: () => <div>Chat view</div> }));
vi.mock("../settings/SettingsRoute", () => ({ default: () => <div>Settings view</div> }));
vi.mock("../chat/AssistantMarkdown", () => ({ AssistantMarkdown: ({ text }: { text: string }) => <p>{text}</p> }));
afterEach(cleanup);

function props(running = false): ComponentProps<typeof RouteSurface> {
  const run: TeamRun = {
    schemaVersion: 2, id: "team", revision: 1, status: running ? "running" : "planned",
    spec: { goal: "Navigation audit", workspacePath: "D:/project", maxConcurrency: 1,
      members: [{ id: "a", displayName: "Researcher", instructions: "Research" }] },
    finalTaskId: "task", createdAt: "2026-09-16", updatedAt: "2026-09-16", error: null,
    tasks: [{ task: { id: "task", title: "Gather evidence", memberId: "a", instructions: "Find primary sources", dependencies: [] },
      status: running ? "running" : "pending",
      attempts: running ? [{ threadId: "record", turnId: "turn", status: "running", startedAt: new Date().toISOString(), finishedAt: null, error: null, output: null }] : [] }],
  };
  return {
    route: "teams", onNavigate: vi.fn(), onOpenThread: vi.fn(async () => {}),
    chat: { createSessionSignal: 0, sessionSidebarCollapsed: false, onSessionSidebarCollapsedChange: vi.fn(), onMascotMoodChange: vi.fn(), onStopGenerationTargetChange: vi.fn() },
    desktopPet: { preferences: DEFAULT_DESKTOP_PET_PREFERENCES, onPreferencesChange: vi.fn(), onResetPosition: vi.fn() },
    services: {
      teamStore: { list: vi.fn(async () => [run]), get: vi.fn(async () => run), prepare: vi.fn(), revise: vi.fn(), execute: vi.fn(), control: vi.fn() },
      workspaceRegistryStore: { list: vi.fn(async () => [{ path: "D:/project", name: "Project", exists: true }]) },
    } as unknown as AppServices,
  };
}

it("preserves an unsaved plan when shell navigation hides and restores Teams", async () => {
  const input = props();
  const view = render(<RouteSurface {...input} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /Navigation audit/ }));
  await user.click(screen.getByRole("button", { name: "Edit plan" }));
  await user.clear(screen.getByLabelText("Task title"));
  await user.type(screen.getByLabelText("Task title"), "Unsaved title");
  view.rerender(<RouteSurface {...input} route="settings" />);
  await screen.findByText("Settings view");
  expect(screen.queryByRole("textbox", { name: "Task title" })).toBeNull();
  view.rerender(<RouteSurface {...input} route="teams" />);
  expect(await screen.findByRole("textbox", { name: "Task title" })).toHaveValue("Unsaved title");
  expect(screen.getByRole("button", { name: "Save plan" })).toBeVisible();
  expect(input.services.teamStore.list).toHaveBeenCalledTimes(1);
});

it("returns from an execution record to the same task and scroll position", async () => {
  const input = props(true);
  const view = render(<RouteSurface {...input} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /Navigation audit/ }));
  const detail = screen.getByRole("complementary", { name: "Task details" });
  detail.scrollTop = 120;
  await user.click(screen.getByRole("button", { name: "View live activity" }));
  expect(input.onOpenThread).toHaveBeenCalledWith("record");
  view.rerender(<RouteSurface {...input} route="chat" />);
  expect(screen.getByText("Chat view")).toBeVisible();
  view.rerender(<RouteSurface {...input} route="teams" />);
  await waitFor(() => expect(screen.getByRole("heading", { name: "Gather evidence" })).toBeVisible());
  expect(screen.getByRole("complementary", { name: "Task details" })).toBe(detail);
  expect(detail.scrollTop).toBe(120);
});
