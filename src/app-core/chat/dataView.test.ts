import { describe, expect, test } from "vitest";
import { dataViewToCsv, formatDataViewCell, parseDataViewDocument } from "./dataView";

function validView() {
  return {
    schemaVersion: "tinybot.data_view.v1",
    title: "Revenue and growth",
    insight: "Revenue rose while growth slowed.",
    dataset: {
      columns: [
        { key: "period", label: "Period", type: "category" },
        { key: "revenue", label: "Revenue", type: "number", format: "currency", currency: "USD", unit: "million", fractionDigits: 0 },
        { key: "growth", label: "Growth", type: "number", format: "percent", fractionDigits: 1 },
      ],
      rows: [
        { id: "fy24", values: { period: "FY2024", revenue: 391035, growth: 9.4 }, sourceIds: ["filing"] },
        { id: "fy25", values: { period: "FY2025", revenue: 403155, growth: 3.1 }, sourceIds: ["filing"] },
      ],
    },
    view: {
      kind: "cartesian",
      x: "period",
      series: [
        { field: "revenue", mark: "bar", axis: "left" },
        { field: "growth", mark: "line", axis: "right" },
      ],
      stack: "none",
    },
    provenance: {
      status: "sourced",
      asOf: "2025-09-27",
      sources: [{ id: "filing", kind: "url", title: "FY2025 Form 10-K", uri: "https://example.com/filing" }],
      methodology: "Reported annual revenue.",
      caveats: [],
    },
  };
}

describe("data view contract", () => {
  test("parses a mixed chart and exports raw rows in declared column order", () => {
    const document = parseDataViewDocument(validView());

    expect(document.view.kind).toBe("cartesian");
    expect(dataViewToCsv(document)).toBe(
      "\uFEFFPeriod,Revenue,Growth\r\nFY2024,391035,9.4\r\nFY2025,403155,3.1",
    );
    expect(formatDataViewCell(document.dataset.columns[2], 3.1, "en-US")).toBe("3.1%");
  });

  test("neutralizes spreadsheet formulas in CSV text while preserving negative numbers", () => {
    const input = validView();
    input.dataset.columns[0].label = "=Formula";
    input.dataset.rows = ["=1+1", "+SUM(A1:A2)", "-42", "@cmd", "\t=cmd", "\r=cmd"].map((period, index) => ({
      id: `row${index}`,
      values: { period, revenue: -100 - index, growth: 0 },
      sourceIds: ["filing"],
    }));

    const csv = dataViewToCsv(parseDataViewDocument(input));

    expect(csv).toContain("\uFEFF'=Formula,Revenue,Growth\r\n");
    expect(csv).toContain("'=1+1,-100,0");
    expect(csv).toContain("'+SUM(A1:A2),-101,0");
    expect(csv).toContain("'-42,-102,0");
    expect(csv).toContain("'@cmd,-103,0");
    expect(csv).toContain("'\t=cmd,-104,0");
    expect(csv).toContain("\"'\r=cmd\",-105,0");
    expect(csv).not.toContain("'-100");
  });

  test("parses persisted artifacts whose absent optional fields were serialized as null", () => {
    const document = parseDataViewDocument({
      schemaVersion: "tinybot.data_view.v1",
      title: "Channel share",
      insight: "Online leads the sample mix.",
      dataset: {
        columns: [
          { key: "channel", label: "Channel", type: "category", format: null, currency: null, unit: null, fractionDigits: null },
          { key: "share", label: "Share", type: "number", format: "percent", currency: null, unit: null, fractionDigits: 1 },
        ],
        rows: [{ id: "online", sourceIds: [], values: { channel: "Online", share: 38 } }],
      },
      view: {
        kind: "metrics",
        items: [{ field: "share", comparisonField: null, direction: null }],
      },
      provenance: {
        status: "unsourced",
        asOf: null,
        sources: [],
        methodology: null,
        caveats: [],
      },
    });

    expect(document).toMatchObject({
      title: "Channel share",
      view: { kind: "metrics", items: [{ field: "share" }] },
    });
    expect(document.dataset.columns[0]).toEqual({ key: "channel", label: "Channel", type: "category" });
  });

  test("rejects persisted content with unknown row fields", () => {
    const input = validView();
    (input.dataset.rows[0].values as Record<string, unknown>).invented = 42;

    expect(() => parseDataViewDocument(input)).toThrow("unknown field invented");
  });

  test("rejects unsafe source schemes", () => {
    const input = validView();
    input.provenance.sources[0].uri = "javascript:alert(1)";

    expect(() => parseDataViewDocument(input)).toThrow("http or https");
  });
});
