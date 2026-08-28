// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeferredSurface } from "./DeferredSurface";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DeferredSurface", () => {
  it("renders the loaded surface through its public interface", async () => {
    const load = vi.fn(async () => ({
      default: ({ label }: { label: string }) => <h1>{label}</h1>,
    }));

    render(<DeferredSurface load={load} name="Settings" surfaceProps={{ label: "Provider settings" }} />);

    expect(screen.getByRole("status").textContent).toContain("Loading Settings");
    expect((await screen.findByRole("heading", { name: "Provider settings" }))).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("makes load failures observable and retries the same surface", async () => {
    const error = new Error("chunk unavailable");
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ default: () => <h1>Tools ready</h1> });
    const user = userEvent.setup();

    render(<DeferredSurface load={load} name="Tools" surfaceProps={{}} />);

    expect((await screen.findByRole("alert")).textContent).toContain("chunk unavailable");
    expect(report).toHaveBeenCalledWith("[tinybot-deferred-surface]", expect.objectContaining({
      attempt: 1,
      error,
      name: "Tools",
    }));

    await user.click(screen.getByRole("button", { name: "Retry loading Tools" }));

    expect((await screen.findByRole("heading", { name: "Tools ready" }))).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
