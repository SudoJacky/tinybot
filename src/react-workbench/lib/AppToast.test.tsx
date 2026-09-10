// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppToastViewport, dismissAppToast, showAppToast } from "./AppToast";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); dismissAppToast(); vi.useRealTimers(); });

describe("app notifications", () => {
  it("portals above the app and exits after five seconds", () => {
    const { container } = render(<AppToastViewport />);
    act(() => showAppToast("Download requested"));
    expect(container.textContent).toBe("");
    expect(screen.getByRole("status").textContent).toBe("Download requested");
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByRole("status").parentElement?.dataset.exiting).toBe("true");
    act(() => vi.advanceTimersByTime(220));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps a hovered notification visible and allows manual dismissal", () => {
    render(<AppToastViewport />);
    act(() => showAppToast("Read this notification"));
    fireEvent.mouseEnter(screen.getByRole("status").parentElement!);
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByRole("status").parentElement?.dataset.exiting).toBeUndefined();
    fireEvent.mouseLeave(screen.getByRole("status").parentElement!);
    fireEvent.focus(screen.getByRole("button", { name: "Dismiss notification" }));
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByRole("status").parentElement?.dataset.exiting).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    act(() => vi.advanceTimersByTime(220));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("replaces an exiting notification without its old timer clearing the new one", () => {
    render(<AppToastViewport />);
    act(() => showAppToast("First"));
    act(() => vi.advanceTimersByTime(5000));
    act(() => showAppToast("Second", "error"));
    act(() => vi.advanceTimersByTime(220));
    expect(screen.queryByText("First")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("Second");
    act(() => vi.advanceTimersByTime(7780));
    act(() => vi.advanceTimersByTime(220));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
