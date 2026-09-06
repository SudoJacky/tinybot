// @vitest-environment happy-dom
import { Suspense } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDataViewDocument } from "../../app-core/chat/dataView";
import DataViewChart from "./DataViewChart";

const mocks = vi.hoisted(() => ({
  coreLoaded: vi.fn(),
  init: vi.fn(),
  use: vi.fn(),
  setOption: vi.fn(),
  dispose: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("echarts/core", () => {
  mocks.coreLoaded();
  return { use: mocks.use, init: mocks.init };
});
vi.mock("echarts/charts", () => ({ BarChart: {}, LineChart: {} }));
vi.mock("echarts/components", () => ({
  AriaComponent: {}, DatasetComponent: {}, GridComponent: {}, LegendComponent: {}, TooltipComponent: {},
}));
vi.mock("echarts/renderers", () => ({ SVGRenderer: {} }));
vi.mock("./DataViewLieflatChart", () => ({
  DataViewLieflatChart: ({ template }: { template: string }) => <svg data-testid="svg-chart" data-template={template} />,
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("DataViewChart loading boundary", () => {
  it("renders an SVG template without loading or registering ECharts", () => {
    render(<Suspense fallback={<p>Loading chart</p>}><DataViewChart document={document(false)} /></Suspense>);
    expect(screen.getByTestId("svg-chart").getAttribute("data-template")).toBe("f1-rung-bars");
    expect(mocks.coreLoaded).not.toHaveBeenCalled();
    expect(mocks.use).not.toHaveBeenCalled();
  });

  it("loads ECharts for mixed-series charts and disposes it when returning to SVG", async () => {
    mocks.init.mockReturnValue({ setOption: mocks.setOption, dispose: mocks.dispose, resize: vi.fn() });
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = mocks.disconnect;
    });
    const view = render(<Suspense fallback={<p>Loading chart</p>}><DataViewChart document={document(true)} /></Suspense>);
    await waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
    expect(mocks.coreLoaded).toHaveBeenCalledOnce();
    expect(mocks.setOption).toHaveBeenCalledWith(expect.objectContaining({
      series: [expect.objectContaining({ type: "bar" }), expect.objectContaining({ type: "line" })],
    }), { notMerge: true });
    view.rerender(<Suspense fallback={<p>Loading chart</p>}><DataViewChart document={document(false)} /></Suspense>);
    expect(screen.getByTestId("svg-chart")).toBeTruthy();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });
});

function document(mixed: boolean) {
  return parseDataViewDocument({
    schemaVersion: "tinybot.data_view.v1", title: "Revenue", insight: "Revenue increased.",
    dataset: {
      columns: [
        { key: "period", label: "Period", type: "category" },
        { key: "revenue", label: "Revenue", type: "number" },
        { key: "cost", label: "Cost", type: "number" },
      ],
      rows: [{ id: "fy25", values: { period: "FY2025", revenue: 400, cost: 200 } }],
    },
    view: { kind: "cartesian", x: "period", series: [
      { field: "revenue", mark: "bar" }, ...(mixed ? [{ field: "cost", mark: "line" }] : []),
    ] },
    provenance: { status: "unsourced", sources: [], caveats: [] },
  });
}
