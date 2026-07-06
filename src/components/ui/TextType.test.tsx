// @vitest-environment happy-dom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextType } from "./TextType";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TextType", () => {
  it("types to the right and deletes from the right when text changes", async () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <TextType ariaLabel="Plan" deletingSpeed={10} loop={false} pauseDuration={1000} text="Plan" typingSpeed={10} />,
    );
    const visual = screen.getByTestId("text-type-visual");

    await advanceTimers(0);
    expect(visual.textContent).toBe("P");
    await advanceTimers(10);
    expect(visual.textContent).toBe("Pl");
    await advanceTimers(10);
    expect(visual.textContent).toBe("Pla");
    await advanceTimers(10);
    expect(visual.textContent).toBe("Plan");

    rerender(
      <TextType ariaLabel="Task" deletingSpeed={10} loop={false} pauseDuration={1000} text="Task" typingSpeed={10} />,
    );

    await advanceTimers(10);
    expect(visual.textContent).toBe("Pla");

    await advanceTimers(10);
    expect(visual.textContent).toBe("Pl");
    await advanceTimers(10);
    expect(visual.textContent).toBe("P");
    await advanceTimers(10);
    expect(visual.textContent).toBe("");

    await advanceTimers(0);
    expect(visual.textContent).toBe("T");
    await advanceTimers(10);
    expect(visual.textContent).toBe("Ta");
    await advanceTimers(10);
    expect(visual.textContent).toBe("Tas");
    await advanceTimers(10);
    expect(visual.textContent).toBe("Task");
  });
});

async function advanceTimers(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
