// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SettingsStore } from "../services";
import { ProfileSettingsPage } from "./ProfileSettingsPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProfileSettingsPage", () => {
  test("renders charts and filters daily usage by provider and model", async () => {
    const observerCallbacks: IntersectionObserverCallback[] = [];
    const observerDisconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) {
        observerCallbacks.push(callback);
      }

      disconnect() {
        observerDisconnect();
      }

      observe() {}

      takeRecords() {
        return [];
      }

      unobserve() {}
    });
    const settingsStore = createSettingsStore();

    const { container } = render(<ProfileSettingsPage settingsStore={settingsStore} />);

    const summary = await screen.findByRole("region", { name: "Total tokens" });
    expect(within(summary).getByText("17,000")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Daily token usage peaked/ })).toBeTruthy();
    expect(screen.getByRole("img", { name: /openai \/ gpt-5 ranks first/ })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Token usage by provider and model" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Daily token usage" })).toBeTruthy();
    expect(container.querySelector(".react-profile-chart-card figcaption p")).toBeNull();
    expect(container.querySelector(".react-profile-chart-card__source")).toBeNull();
    expect(container.querySelector(".react-profile-usage-note")).toBeNull();

    const chartCards = [...container.querySelectorAll<HTMLElement>(".react-profile-chart-card")];
    expect(chartCards).toHaveLength(2);
    expect(chartCards.every((card) => card.dataset.revealState === "pending")).toBe(true);
    const completions = chartCards.map(mockChartAnimations);
    await waitFor(() => expect(observerCallbacks).toHaveLength(2));

    act(() => {
      for (const callback of observerCallbacks) {
        callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      }
    });

    expect(chartCards.every((card) => card.dataset.revealState === "revealing")).toBe(true);
    expect(observerDisconnect).toHaveBeenCalled();

    const dailyChart = chartCards[0].querySelector("svg");
    fireEvent.click(chartCards[0]);
    expect(chartCards[0].querySelector("svg")).not.toBe(dailyChart);

    const modelChart = chartCards[1].querySelector("svg");
    fireEvent.keyDown(chartCards[1], { key: "Enter" });
    expect(chartCards[1].querySelector("svg")).not.toBe(modelChart);
    await act(async () => completions.forEach((runs) => runs[0]()));
    expect(chartCards.every((card) => card.dataset.revealState === "revealing")).toBe(true);

    const currentCharts = chartCards.map((card) => card.querySelector("svg"));
    selectProvider("anthropic");

    expect(within(summary).getByText("5,000")).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "anthropic" })).toBeTruthy();
    expect(screen.queryByRole("rowheader", { name: "openai" })).toBeNull();
    expect(chartCards.every((card) => card.dataset.revealState === "settled")).toBe(true);
    chartCards.forEach((card, index) => expect(card.querySelector("svg")).toBe(currentCharts[index]));

    const anthropicTick = chartCards[1].querySelector(".react-profile-chart__model-tick");
    selectProvider("All providers");
    expect(chartCards.every((card) => card.dataset.revealState === "settled")).toBe(true);
    expect(chartCards[1].querySelector(".react-profile-chart__model-tick")).not.toBe(anthropicTick);
    chartCards.forEach((card, index) => expect(card.querySelector("svg")).toBe(currentCharts[index]));

    fireEvent.keyDown(chartCards[0], { key: " " });
    expect(chartCards[0].dataset.revealState).toBe("revealing");
    await act(async () => completions.forEach((runs) => runs[1]()));
    expect(chartCards[0].dataset.revealState).toBe("revealing");
    await act(async () => completions[0][2]());
    expect(chartCards[0].dataset.revealState).toBe("settled");

    selectProvider("anthropic");
    fireEvent.click(screen.getByRole("button", { name: /Filter token usage by model/ }));
    expect(screen.getByRole("menuitemradio", { name: "claude-sonnet" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "Aug 31, 2026" })).toBeTruthy();
  });

  test("settles a filter change before viewport entry and ignores stale observer callbacks", async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
      observe() {}
      disconnect() {}
    });
    const { container } = render(<ProfileSettingsPage settingsStore={createSettingsStore()} />);
    await screen.findByRole("region", { name: "Total tokens" });
    const cards = [...container.querySelectorAll<HTMLElement>(".react-profile-chart-card")];
    expect(cards.every((card) => card.dataset.revealState === "pending")).toBe(true);
    selectProvider("openai");
    expect(cards.every((card) => card.dataset.revealState === "settled")).toBe(true);
    act(() => callbacks.forEach((callback) => callback(
      [{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver,
    )));
    expect(cards.every((card) => card.dataset.revealState === "settled")).toBe(true);
    selectProvider("All providers");
    expect(cards.every((card) => card.dataset.revealState === "settled")).toBe(true);
  });

  test("keeps reduced-motion charts settled before entry and when replay is requested", async () => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    Object.defineProperty(preference, "matches", { configurable: true, value: true });
    vi.spyOn(window, "matchMedia").mockReturnValue(preference);
    const { container } = render(<ProfileSettingsPage settingsStore={createSettingsStore()} />);
    await screen.findByRole("region", { name: "Total tokens" });
    const cards = [...container.querySelectorAll<HTMLElement>(".react-profile-chart-card")];
    expect(cards.every((card) => card.dataset.revealState === "settled")).toBe(true);
    fireEvent.click(cards[0]);
    fireEvent.keyDown(cards[1], { key: "Enter" });
    expect(cards.every((card) => card.dataset.revealState === "settled")).toBe(true);
  });

  test("observes newly populated charts and preserves settled history across empty data", async () => {
    const observed: HTMLElement[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      observe(figure: HTMLElement) { observed.push(figure); }
      disconnect() {}
    });
    const settingsStore = createSettingsStore();
    const snapshot = await settingsStore.loadTokenUsage!();
    const initialDays = snapshot.days;
    const initialModels = snapshot.modelDays;
    snapshot.days = [];
    snapshot.modelDays = [];
    settingsStore.loadTokenUsage = vi.fn(async () => snapshot);
    const { container, rerender } = render(<ProfileSettingsPage settingsStore={settingsStore} />);
    await screen.findByRole("region", { name: "Total tokens" });
    expect(container.querySelectorAll(".react-profile-chart-card")).toHaveLength(0);
    expect(observed).toHaveLength(0);

    snapshot.days = initialDays;
    snapshot.modelDays = initialModels;
    rerender(<ProfileSettingsPage settingsStore={settingsStore} />);
    expect(observed).toHaveLength(2);
    expect(observed.every((card) => card.dataset.revealState === "pending")).toBe(true);
    selectProvider("anthropic");
    expect(observed.every((card) => card.dataset.revealState === "settled")).toBe(true);
    selectProvider("All providers");

    snapshot.days = [];
    snapshot.modelDays = [];
    rerender(<ProfileSettingsPage settingsStore={settingsStore} />);
    expect(container.querySelectorAll(".react-profile-chart-card")).toHaveLength(0);
    snapshot.days = initialDays;
    snapshot.modelDays = initialModels;
    rerender(<ProfileSettingsPage settingsStore={settingsStore} />);
    const cards = [...container.querySelectorAll<HTMLElement>(".react-profile-chart-card")];
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => card.dataset.revealState === "settled")).toBe(true);
    expect(observed).toHaveLength(2);
  });

  test("settles an active reveal when reduced motion is enabled", async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    vi.spyOn(window, "matchMedia").mockReturnValue(preference);
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
      observe() {}
      disconnect() {}
    });
    const { container } = render(<ProfileSettingsPage settingsStore={createSettingsStore()} />);
    await screen.findByRole("region", { name: "Total tokens" });
    const card = container.querySelector<HTMLElement>(".react-profile-chart-card")!;
    const runs = mockChartAnimations(card);
    await waitFor(() => expect(callbacks).toHaveLength(2));
    expect(card.dataset.revealState).toBe("pending");
    act(() => callbacks[0](
      [{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver,
    ));
    expect(card.dataset.revealState).toBe("revealing");
    Object.defineProperty(preference, "matches", { configurable: true, value: true });
    act(() => preference.dispatchEvent(new Event("change")));
    expect(card.dataset.revealState).toBe("settled");
    await act(async () => runs[0]());
    expect(card.dataset.revealState).toBe("settled");
  });

  test("settles charts without viewport observation or browser animations", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container } = render(<ProfileSettingsPage settingsStore={createSettingsStore()} />);
    await screen.findByRole("region", { name: "Total tokens" });
    await waitFor(() => {
      const cards = [...container.querySelectorAll<HTMLElement>(".react-profile-chart-card")];
      expect(cards).toHaveLength(2);
      expect(cards.every((card) => card.dataset.revealState === "settled")).toBe(true);
    });
  });
});

function mockChartAnimations(card: HTMLElement): Array<() => void> {
  const completions: Array<() => void> = [];
  card.getAnimations = vi.fn(() => [{
    finished: new Promise<Animation>((resolve) => completions.push(() => resolve({} as Animation))),
  } as Animation]);
  return completions;
}

function selectProvider(name: string) {
  fireEvent.click(screen.getByRole("button", { name: /Filter token usage by provider/ }));
  fireEvent.click(screen.getByRole("menuitemradio", { name }));
}

function createSettingsStore(): SettingsStore {
  return {
      load: vi.fn(async () => []),
      loadTokenUsage: vi.fn(async () => ({
        schemaVersion: "tinybot.token_usage.v2" as const,
        totals: usage(14_000, 8_000, 3_000, 1_200, 17_000),
        days: [
          { date: "2026-08-31", ...usage(12_000, 7_000, 3_000, 1_200, 15_000) },
          { date: "2026-08-30", ...usage(2_000, 1_000, 0, 0, 2_000) },
        ],
        modelDays: [
          {
            date: "2026-08-31",
            providerId: "openai",
            modelId: "gpt-5",
            ...usage(8_000, 5_000, 2_000, 800, 10_000),
          },
          {
            date: "2026-08-31",
            providerId: "anthropic",
            modelId: "claude-sonnet",
            ...usage(4_000, 2_000, 1_000, 400, 5_000),
          },
          {
            date: "2026-08-30",
            providerId: "openai",
            modelId: "gpt-5",
            ...usage(2_000, 1_000, 0, 0, 2_000),
          },
        ],
      })),
  };
}

function usage(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  reasoningOutputTokens: number,
  totalTokens: number,
) {
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}
