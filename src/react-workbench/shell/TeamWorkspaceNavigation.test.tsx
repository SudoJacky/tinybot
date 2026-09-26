// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { DEFAULT_DESKTOP_PET_PREFERENCES } from "../../app-core/desktop-pet/desktopPetState";
import type { AppServices } from "../services";
import { RouteSurface } from "./RouteSurface";
import { resolveAppRoute } from "./appRoutes";

vi.mock("../chat/ChatPage", () => ({ ChatPage: () => <div>Chat view</div> }));
afterEach(cleanup);

function props(route: ComponentProps<typeof RouteSurface>["route"]): ComponentProps<typeof RouteSurface> {
  return {
    route, onNavigate: vi.fn(), onOpenThread: vi.fn(async () => {}),
    chat: { createSessionSignal: 0, sessionSidebarCollapsed: false, onSessionSidebarCollapsedChange: vi.fn(),
      onMascotMoodChange: vi.fn(), onStopGenerationTargetChange: vi.fn() },
    desktopPet: { preferences: DEFAULT_DESKTOP_PET_PREFERENCES, onPreferencesChange: vi.fn(), onResetPosition: vi.fn() },
    services: { teamStore: { list: vi.fn(), get: vi.fn() } } as unknown as AppServices,
  };
}

it("resolves legacy Teams navigation to Chat without mounting or loading Team data", () => {
  const input = props("teams");
  const view = render(<RouteSurface {...input} />);
  expect(screen.getByText("Chat view")).toBeVisible();
  expect(input.services.teamStore.list).not.toHaveBeenCalled();
  expect(input.services.teamStore.get).not.toHaveBeenCalled();
  expect(view.container.querySelector("[hidden]")).toBeNull();
  expect(resolveAppRoute("teams")).toBe("chat");
});

it("keeps Chat mounted when an old Teams route is restored", () => {
  const input = props("chat");
  const view = render(<RouteSurface {...input} />);
  const chat = screen.getByText("Chat view");
  view.rerender(<RouteSurface {...input} route="teams" />);
  expect(screen.getByText("Chat view")).toBe(chat);
});
