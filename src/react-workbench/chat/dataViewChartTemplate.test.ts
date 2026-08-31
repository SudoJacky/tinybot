import { describe, expect, it } from "vitest";
import type { DataViewDocument, DataViewSeries } from "../../app-core/chat/dataView";
import { selectDataViewChartTemplate } from "./dataViewChartTemplate";

describe("selectDataViewChartTemplate", () => {
  it("routes compact and long-label bar comparisons to the matching Basics templates", () => {
    expect(selectDataViewChartTemplate(cartesian(["Free", "Pro"], [{ field: "value", mark: "bar" }]))).toBe("f1-rung-bars");
    expect(selectDataViewChartTemplate(cartesian(["Enterprise platform", "Developer experience"], [{ field: "value", mark: "bar" }]))).toBe("f5-tick-rows");
  });

  it("uses the three hairline templates according to time-series density", () => {
    expect(selectDataViewChartTemplate(cartesian(dates(30), [{ field: "value", mark: "line" }]))).toBe("f2-hairline-line");
    expect(selectDataViewChartTemplate(cartesian(dates(45), [{ field: "value", mark: "area" }]))).toBe("f3-hairline-area");
    expect(selectDataViewChartTemplate(cartesian(dates(90), [{ field: "value", mark: "line" }]))).toBe("l3-barcode-lollipop");
  });

  it("selects paired and stacked rung templates only inside their honest data limits", () => {
    const pair = [{ field: "value", mark: "bar" }, { field: "other", mark: "bar" }] satisfies DataViewSeries[];
    expect(selectDataViewChartTemplate(cartesian(["Free", "Pro"], pair))).toBe("f6-paired-rungs");
    expect(selectDataViewChartTemplate(cartesian(["NA", "EU"], pair, "normal"))).toBe("f7-stacked-rungs");
    expect(selectDataViewChartTemplate(cartesian(dates(10), pair))).toBe("mono-fallback");
    const incompatible = cartesian(["Free", "Pro"], pair);
    incompatible.dataset.columns.find((column) => column.key === "other")!.unit = "seconds";
    expect(selectDataViewChartTemplate(incompatible)).toBe("mono-fallback");
  });

  it("uses the rung waterfall for at most six complete steps", () => {
    const document = cartesian(["Gross", "Costs", "Net"], [{ field: "value", mark: "bar" }]);
    document.dataset.columns.push({ key: "total", label: "Total", type: "boolean" });
    document.dataset.rows.forEach((row, index) => { row.values.total = index === 2; });
    document.view = { kind: "waterfall", category: "period", value: "value", totalField: "total" };
    expect(selectDataViewChartTemplate(document)).toBe("f9-rung-waterfall");
  });
});

function cartesian(
  labels: string[],
  series: DataViewSeries[],
  stack?: "none" | "normal",
): DataViewDocument {
  return {
    schemaVersion: "tinybot.data_view.v1",
    title: "Usage",
    insight: "Usage changed over time.",
    dataset: {
      columns: [
        { key: "period", label: "Period", type: labels.every((label) => /^\d{4}-\d{2}-\d{2}$/.test(label)) ? "date" : "category" },
        { key: "value", label: "Value", type: "number", format: "integer" },
        { key: "other", label: "Other", type: "number", format: "integer" },
      ],
      rows: labels.map((label, index) => ({
        id: `row_${index}`,
        values: { period: label, value: index + 1, other: index + 2 },
      })),
    },
    view: { kind: "cartesian", x: "period", series, ...(stack ? { stack } : {}) },
    provenance: { status: "user_provided", sources: [], caveats: [] },
  };
}

function dates(count: number): string[] {
  return Array.from({ length: count }, (_, index) => (
    new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10)
  ));
}
