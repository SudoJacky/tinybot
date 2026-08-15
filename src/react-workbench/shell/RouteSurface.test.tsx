// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServices } from "../services";
import { RouteSurface } from "./RouteSurface";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RouteSurface", () => {
  it("reports workspace file failures and retries through its public interface", async () => {
    const error = new Error("workspace unavailable");
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const listFiles = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce([{ path: "src/main.ts", size: 512 }]);
    const services = { workspaceStore: { listFiles } } as unknown as AppServices;
    const user = userEvent.setup();

    render(
      <RouteSurface
        chat={{
          createSessionSignal: 0,
          sessionSidebarCollapsed: false,
          onSessionSidebarCollapsedChange: vi.fn(),
          onStopGenerationTargetChange: vi.fn(),
        }}
        route="files"
        services={services}
        onNavigate={vi.fn()}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toContain("workspace unavailable");
    expect(report).toHaveBeenCalledWith("[tinybot-files-route]", expect.objectContaining({
      attempt: 1,
      error,
    }));

    await user.click(screen.getByRole("button", { name: "Retry loading Workspace Files" }));

    expect((await screen.findByText("src/main.ts"))).toBeTruthy();
    expect(screen.getByText("512 B")).toBeTruthy();
    expect(listFiles).toHaveBeenCalledTimes(2);
  });
});
