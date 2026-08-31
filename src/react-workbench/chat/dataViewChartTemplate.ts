import type { DataViewDocument } from "../../app-core/chat/dataView";

export type DataViewChartTemplate =
  | "f1-rung-bars"
  | "f2-hairline-line"
  | "f3-hairline-area"
  | "f5-tick-rows"
  | "f6-paired-rungs"
  | "f7-stacked-rungs"
  | "f9-rung-waterfall"
  | "l3-barcode-lollipop"
  | "mono-fallback";

export function selectDataViewChartTemplate(document: DataViewDocument): DataViewChartTemplate {
  if (document.view.kind === "waterfall") {
    return document.dataset.rows.length <= 6 && hasFiniteValues(document, [document.view.value])
      ? "f9-rung-waterfall"
      : "mono-fallback";
  }
  if (document.view.kind !== "cartesian") {
    return "mono-fallback";
  }

  const { rows } = document.dataset;
  const { series, stack, x } = document.view;
  const allBars = series.every((item) => item.mark === "bar");
  const allNonNegative = hasFiniteValues(document, series.map((item) => item.field), true);
  const comparableSeries = shareNumberEncoding(document, series.map((item) => item.field));

  if (stack === "normal" && allBars && allNonNegative && comparableSeries && rows.length <= 4 && series.length <= 3) {
    return "f7-stacked-rungs";
  }
  if (stack !== "normal" && allBars && allNonNegative && comparableSeries && rows.length <= 8 && series.length === 2) {
    return "f6-paired-rungs";
  }
  if (stack !== "normal" && allBars && allNonNegative && rows.length <= 8 && series.length === 1) {
    return prefersHorizontalBars(document, x) ? "f5-tick-rows" : "f1-rung-bars";
  }
  if (series.length !== 1 || series[0].axis === "right") {
    return "mono-fallback";
  }

  const [item] = series;
  if (!hasFiniteValues(document, [item.field])) {
    return "mono-fallback";
  }
  if (item.mark === "line" && rows.length <= 30) {
    return "f2-hairline-line";
  }
  if ((item.mark === "line" || item.mark === "area") && rows.length <= 60) {
    return "f3-hairline-area";
  }
  if ((item.mark === "line" || item.mark === "area") && rows.length <= 180 && isDateAxis(document, x)) {
    return "l3-barcode-lollipop";
  }
  return "mono-fallback";
}

function hasFiniteValues(document: DataViewDocument, fields: string[], nonNegative = false): boolean {
  return document.dataset.rows.every((row) => fields.every((field) => {
    const value = row.values[field];
    return typeof value === "number" && Number.isFinite(value) && (!nonNegative || value >= 0);
  }));
}

function prefersHorizontalBars(document: DataViewDocument, field: string): boolean {
  return document.dataset.rows.length > 6 || document.dataset.rows.some((row) => (
    String(row.values[field] ?? "").length > 11
  ));
}

function isDateAxis(document: DataViewDocument, field: string): boolean {
  const column = document.dataset.columns.find((item) => item.key === field);
  return column?.type === "date" || column?.type === "datetime";
}

function shareNumberEncoding(document: DataViewDocument, fields: string[]): boolean {
  const signatures = fields.map((field) => {
    const item = document.dataset.columns.find((column) => column.key === field)!;
    return [item.format ?? "number", item.currency ?? "", item.unit ?? "", item.fractionDigits ?? ""].join("\u001f");
  });
  return new Set(signatures).size <= 1;
}
