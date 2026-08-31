// @vitest-environment happy-dom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDataViewDocument } from "../../app-core/chat/dataView";
import "../i18n";
import { DataViewLieflatChart } from "./DataViewLieflatChart";

const observerCallbacks: IntersectionObserverCallback[] = [];

beforeEach(() => {
  observerCallbacks.length = 0;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) {
      observerCallbacks.push(callback);
    }
    disconnect() {}
    observe() {}
    takeRecords() { return []; }
    unobserve() {}
    root = null;
    rootMargin = "0px";
    thresholds = [0.3];
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DataViewLieflatChart", () => {
  it("waits for the chart to enter the viewport before drawing the selected template", () => {
    const { container } = render(<DataViewLieflatChart document={barDocument()} template="f1-rung-bars" />);

    expect(screen.getByRole("button").getAttribute("data-reveal-state")).toBe("pending");
    expect(container.querySelector("svg")).toBeNull();

    act(() => observerCallbacks[0]([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));

    expect(screen.getByRole("button").getAttribute("data-template")).toBe("f1-rung-bars");
    expect(screen.getByRole("img")).toBeTruthy();
    expect(container.querySelectorAll(".lieflat-rung").length).toBeGreaterThan(0);
  });
});

function barDocument() {
  return parseDataViewDocument({
    schemaVersion: "tinybot.data_view.v1",
    title: "Revenue",
    insight: "Pro leads.",
    dataset: {
      columns: [
        { key: "plan", label: "Plan", type: "category" },
        { key: "revenue", label: "Revenue", type: "number", format: "integer", unit: "k" },
      ],
      rows: [
        { id: "free", values: { plan: "Free", revenue: 18 } },
        { id: "pro", values: { plan: "Pro", revenue: 27 } },
      ],
    },
    view: { kind: "cartesian", x: "plan", series: [{ field: "revenue", mark: "bar" }] },
    provenance: { status: "user_provided", sources: [], caveats: [] },
  });
}
