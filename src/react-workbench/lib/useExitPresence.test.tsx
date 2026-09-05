// @vitest-environment happy-dom

import { act, cleanup, render, screen } from "@testing-library/react";
import { useCallback, useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { elementTransitions, useExitPresence } from "./useExitPresence";

afterEach(cleanup);

function pendingTransition(transitionProperty = "opacity") {
  let finish!: () => void;
  let cancel!: () => void;
  const animation = {
    transitionProperty,
    playState: "running",
    finished: new Promise<void>((resolve, reject) => {
      finish = () => { animation.playState = "finished"; resolve(); };
      cancel = () => { animation.playState = "idle"; reject(new DOMException("Cancelled", "AbortError")); };
    }),
  };
  return { animation, finish, cancel };
}

function Panel({ value, scope = "a" }: { value: string | null; scope?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const read = useCallback(() => elementTransitions(ref.current, ["opacity", "transform"]), []);
  const content = useExitPresence(value, scope, read);
  return content === null ? null : <div ref={ref} data-testid="panel" inert={value === null}>{content}</div>;
}

describe("exit presence", () => {
  it("releases immediately without transitions, including reduced motion", () => {
    const { rerender } = render(<Panel value="detail" />);
    rerender(<Panel value={null} />);
    expect(screen.queryByTestId("panel")).toBeNull();
  });

  it("does not remove a reopened panel when an earlier transition completes", async () => {
    const { rerender } = render(<Panel value="first" />);
    const panel = screen.getByTestId("panel");
    const transition = pendingTransition();
    Object.defineProperty(panel, "getAnimations", { value: () => [transition.animation] });
    rerender(<Panel value={null} />);
    expect(panel.hasAttribute("inert")).toBe(true);
    rerender(<Panel value="second" />);
    await act(async () => transition.finish());
    expect(screen.getByTestId("panel")).toBe(panel);
    expect(panel.textContent).toBe("second");
    expect(panel.hasAttribute("inert")).toBe(false);
  });

  it("rechecks replacement transitions after cancellation and ignores unrelated animations", async () => {
    const { rerender } = render(<Panel value="detail" />);
    const panel = screen.getByTestId("panel");
    const first = pendingTransition();
    const replacement = pendingTransition("transform");
    let animations = [first.animation];
    Object.defineProperty(panel, "getAnimations", { value: () => [
      ...animations,
      { playState: "running", finished: new Promise(() => {}), animationName: "cursor" },
    ] });
    rerender(<Panel value={null} />);
    await act(async () => { animations = [replacement.animation]; first.cancel(); });
    expect(screen.getByTestId("panel")).toBe(panel);
    await act(async () => replacement.finish());
    expect(screen.queryByTestId("panel")).toBeNull();
  });

  it("clears retained content immediately across owner scope changes", async () => {
    const { rerender } = render(<Panel value="old thread" />);
    const panel = screen.getByTestId("panel");
    const transition = pendingTransition();
    Object.defineProperty(panel, "getAnimations", { value: () => [transition.animation] });
    rerender(<Panel value={null} />);
    rerender(<Panel value={null} scope="b" />);
    expect(screen.queryByTestId("panel")).toBeNull();
    await act(async () => transition.finish());
  });
});
