import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import {
  AriaComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption, EChartsType } from "echarts/core";
import type { DataViewColumn, DataViewDocument } from "../../app-core/chat/dataView";

echarts.use([
  AriaComponent,
  BarChart,
  CanvasRenderer,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  LineChart,
  TooltipComponent,
]);

export default function DataViewChart({ document }: { document: DataViewDocument }) {
  const { t } = useTranslation("chat");
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstanceRef = useRef<EChartsType | null>(null);
  const option = useMemo(() => chartOption(document), [document]);

  useEffect(() => {
    const element = chartRef.current;
    if (!element) {
      return;
    }
    const chart = echarts.init(element, undefined, { renderer: "canvas" });
    chartInstanceRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartInstanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartInstanceRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return (
    <div
      aria-label={t("dataView.chartLabel", { title: document.title, insight: document.insight })}
      className="react-data-view__chart"
      ref={chartRef}
      role="img"
    />
  );
}

function chartOption(document: DataViewDocument): EChartsCoreOption {
  const style = getComputedStyle(window.document.documentElement);
  const ink = style.getPropertyValue("--color-ink").trim() || "#141413";
  const muted = style.getPropertyValue("--color-muted").trim() || "#6c6a64";
  const hairline = style.getPropertyValue("--color-hairline").trim() || "#e6dfd8";
  const primary = style.getPropertyValue("--color-primary").trim() || "#cc785c";
  const success = style.getPropertyValue("--color-success").trim() || "#5db872";
  const error = style.getPropertyValue("--color-error").trim() || "#c64545";
  const animation = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const base: EChartsCoreOption = {
    animation,
    aria: { enabled: true, decal: { show: true }, label: { description: `${document.title}. ${document.insight}` } },
    color: [primary, "#5577a8", success, "#9772b7", "#d09b3e", "#4c9494"],
    grid: { left: 10, right: 18, top: 42, bottom: 8, containLabel: true },
    legend: { top: 4, textStyle: { color: muted, fontSize: 11 } },
    tooltip: { trigger: "axis", confine: true },
    textStyle: { color: ink, fontFamily: "Inter, system-ui, sans-serif" },
  };
  if (document.view.kind === "cartesian") {
    const columns = new Map(document.dataset.columns.map((column) => [column.key, column]));
    const usesRightAxis = document.view.series.some((series) => series.axis === "right");
    return {
      ...base,
      dataset: { source: document.dataset.rows.map((row) => row.values) },
      xAxis: {
        type: "category",
        axisLine: { lineStyle: { color: hairline } },
        axisLabel: { color: muted, hideOverlap: true },
      },
      yAxis: [
        valueAxis(columns, document.view.series.find((series) => series.axis !== "right")?.field, muted, hairline),
        ...(usesRightAxis ? [valueAxis(columns, document.view.series.find((series) => series.axis === "right")?.field, muted, hairline)] : []),
      ],
      series: document.view.series.map((series) => ({
        type: series.mark === "bar" ? "bar" : "line",
        name: columns.get(series.field)?.label ?? series.field,
        encode: { x: document.view.kind === "cartesian" ? document.view.x : "", y: series.field },
        yAxisIndex: series.axis === "right" ? 1 : 0,
        ...(series.mark === "area" ? { areaStyle: { opacity: 0.2 }, showSymbol: true } : {}),
        ...(document.view.kind === "cartesian" && document.view.stack === "normal" ? { stack: "total" } : {}),
      })),
    };
  }
  if (document.view.kind === "waterfall") {
    const view = document.view;
    const categoryColumn = document.dataset.columns.find((column) => column.key === view.category)!;
    const valueColumn = document.dataset.columns.find((column) => column.key === view.value)!;
    const waterfall = waterfallSeries(document);
    return {
      ...base,
      xAxis: {
        type: "category",
        data: document.dataset.rows.map((row) => String(row.values[categoryColumn.key] ?? "")),
        axisLine: { lineStyle: { color: hairline } },
        axisLabel: { color: muted, hideOverlap: true },
      },
      yAxis: valueAxis(new Map([[valueColumn.key, valueColumn]]), valueColumn.key, muted, hairline),
      series: [
        { type: "bar", stack: "waterfall", silent: true, itemStyle: { color: "transparent" }, data: waterfall.base },
        { type: "bar", stack: "waterfall", name: "Increase", itemStyle: { color: success }, data: waterfall.positive },
        { type: "bar", stack: "waterfall", name: "Decrease", itemStyle: { color: error }, data: waterfall.negative },
        { type: "bar", stack: "waterfall", name: "Total", itemStyle: { color: primary }, data: waterfall.total },
      ],
    };
  }
  return base;
}

function valueAxis(columns: Map<string, DataViewColumn>, field: string | undefined, color: string, splitColor: string) {
  const column = field ? columns.get(field) : undefined;
  return {
    type: "value" as const,
    name: [column?.currency, column?.unit].filter(Boolean).join(" · "),
    nameTextStyle: { color, fontSize: 10 },
    axisLabel: { color },
    splitLine: { lineStyle: { color: splitColor, type: "dashed" as const } },
  };
}

function waterfallSeries(document: DataViewDocument) {
  if (document.view.kind !== "waterfall") {
    return { base: [], positive: [], negative: [], total: [] };
  }
  const base: Array<number | "-"> = [];
  const positive: Array<number | "-"> = [];
  const negative: Array<number | "-"> = [];
  const total: Array<number | "-"> = [];
  let running = 0;
  for (const row of document.dataset.rows) {
    const value = Number(row.values[document.view.value] ?? 0);
    const isTotal = document.view.totalField ? row.values[document.view.totalField] === true : false;
    if (isTotal) {
      base.push(0); positive.push("-"); negative.push("-"); total.push(value); running = value;
    } else if (value >= 0) {
      base.push(running); positive.push(value); negative.push("-"); total.push("-"); running += value;
    } else {
      running += value; base.push(running); positive.push("-"); negative.push(-value); total.push("-");
    }
  }
  return { base, positive, negative, total };
}
