// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDataViewDocument } from "../../app-core/chat/dataView";
import type { ArtifactRef } from "../../app-core/chat/chatTurnContracts";
import { DataViewCard } from "./DataViewCard";

const mocks = vi.hoisted(() => ({
  chartRender: vi.fn(),
}));

vi.mock("./DataViewChart", () => ({
  default: ({ document }: { document: { title: string } }) => {
    mocks.chartRender(document.title);
    return <div data-testid="data-view-chart">{document.title}</div>;
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DataViewCard", () => {
  it("loads the chart renderer for a chart view", async () => {
    render(<DataViewCard artifact={chartArtifact()} />);

    expect((await screen.findByTestId("data-view-chart")).textContent).toBe("Revenue");
    expect(mocks.chartRender).toHaveBeenCalledWith("Revenue");
  });

  it("renders metrics without invoking the chart renderer", () => {
    render(<DataViewCard artifact={metricsArtifact()} />);

    expect(screen.getByText("38%")).toBeTruthy();
    expect(mocks.chartRender).not.toHaveBeenCalled();
  });
});

function chartArtifact(): ArtifactRef {
  return {
    id: "revenue-chart",
    kind: "data_view",
    title: "Revenue",
    dataView: parseDataViewDocument({
      schemaVersion: "tinybot.data_view.v1",
      title: "Revenue",
      insight: "Revenue increased.",
      dataset: {
        columns: [
          { key: "period", label: "Period", type: "category" },
          { key: "revenue", label: "Revenue", type: "number" },
        ],
        rows: [{ id: "fy25", values: { period: "FY2025", revenue: 403155 } }],
      },
      view: { kind: "cartesian", x: "period", series: [{ field: "revenue", mark: "bar" }] },
      provenance: { status: "unsourced", sources: [], caveats: [] },
    }),
  };
}

function metricsArtifact(): ArtifactRef {
  return {
    id: "share-metric",
    kind: "data_view",
    title: "Share",
    dataView: parseDataViewDocument({
      schemaVersion: "tinybot.data_view.v1",
      title: "Share",
      insight: "Online leads.",
      dataset: {
        columns: [{ key: "share", label: "Share", type: "number", format: "percent", fractionDigits: 1 }],
        rows: [{ id: "online", values: { share: 38 } }],
      },
      view: { kind: "metrics", items: [{ field: "share" }] },
      provenance: { status: "unsourced", sources: [], caveats: [] },
    }),
  };
}
