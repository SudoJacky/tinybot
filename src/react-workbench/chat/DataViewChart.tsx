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
import { SVGRenderer } from "echarts/renderers";
import type { EChartsCoreOption, EChartsType } from "echarts/core";
import {
  formatDataViewCell,
  type DataViewColumn,
  type DataViewDocument,
} from "../../app-core/chat/dataView";
import { DataViewLieflatChart } from "./DataViewLieflatChart";
import { selectDataViewChartTemplate } from "./dataViewChartTemplate";

echarts.use([
  AriaComponent,
  BarChart,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  LineChart,
  SVGRenderer,
  TooltipComponent,
]);

export default function DataViewChart({ document }: { document: DataViewDocument }) {
  const template = useMemo(() => selectDataViewChartTemplate(document), [document]);
  if (template !== "mono-fallback") {
    return <DataViewLieflatChart document={document} template={template} />;
  }
  return <FallbackChart document={document} />;
}

function FallbackChart({ document }: { document: DataViewDocument }) {
  const { i18n, t } = useTranslation("chat");
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstanceRef = useRef<EChartsType | null>(null);
  const option = useMemo(() => chartOption(document, i18n.resolvedLanguage), [document, i18n.resolvedLanguage]);

  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    const chart = echarts.init(element, undefined, { renderer: "svg" });
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
      className="react-data-view__chart react-data-view__chart--fallback"
      data-template="mono-fallback"
      ref={chartRef}
      role="img"
    />
  );
}

function chartOption(document: DataViewDocument, locale?: string): EChartsCoreOption {
  const style = getComputedStyle(window.document.documentElement);
  const background = cssValue(style, "--lieflat-porcelain-bg", "#f7f2eb");
  const text = cssValue(style, "--lieflat-porcelain-text", "#081f5c");
  const muted = cssValue(style, "--lieflat-porcelain-muted", "rgba(8, 31, 92, 0.6)");
  const faint = cssValue(style, "--lieflat-porcelain-faint", "rgba(8, 31, 92, 0.32)");
  const grid = cssValue(style, "--lieflat-porcelain-grid", "rgba(8, 31, 92, 0.16)");
  const data = cssValue(style, "--lieflat-porcelain-data", "#334eac");
  const data2 = cssValue(style, "--lieflat-porcelain-data-2", "#7096d1");
  const faintData = cssValue(style, "--lieflat-porcelain-faint-data", "#bad6eb");
  const paleData = cssValue(style, "--lieflat-porcelain-ramp-pale", "#d0e3ff");
  const hero = cssValue(style, "--lieflat-porcelain-hero", "#081f5c");
  const animation = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ladder = [data, hero, data2, faintData, paleData];
  const base: EChartsCoreOption = {
    animation,
    animationDuration: 900,
    animationDurationUpdate: 600,
    animationEasing: "quarticOut",
    animationEasingUpdate: "quarticOut",
    aria: {
      enabled: true,
      decal: { show: true },
      label: { description: `${document.title}. ${document.insight}` },
    },
    color: ladder,
    grid: { left: 16, right: 24, top: 48, bottom: 16, containLabel: true },
    legend: {
      top: 5,
      itemHeight: 7,
      itemWidth: 22,
      textStyle: { color: muted, fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, fontWeight: 600 },
    },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: hero,
      borderWidth: 0,
      borderRadius: 12,
      padding: [10, 14],
      textStyle: { color: background, fontFamily: "Inter, system-ui, sans-serif", fontSize: 12 },
      axisPointer: { lineStyle: { color: faint, type: "dashed", width: 1 } },
    },
    textStyle: { color: text, fontFamily: "Inter, system-ui, sans-serif" },
  };
  if (document.view.kind === "cartesian") {
    const columns = new Map(document.dataset.columns.map((column) => [column.key, column]));
    const usesRightAxis = document.view.series.some((series) => series.axis === "right");
    return {
      ...base,
      dataset: { source: document.dataset.rows.map((row) => row.values) },
      xAxis: {
        type: "category",
        axisLine: { lineStyle: { color: grid, width: 1 } },
        axisTick: { alignWithLabel: true, lineStyle: { color: faint } },
        axisLabel: { color: muted, fontSize: 10, fontWeight: 600, hideOverlap: true },
      },
      yAxis: [
        valueAxis(columns, document.view.series.find((series) => series.axis !== "right")?.field, locale, muted, grid),
        ...(usesRightAxis ? [valueAxis(columns, document.view.series.find((series) => series.axis === "right")?.field, locale, muted, grid)] : []),
      ],
      series: document.view.series.map((series, index) => ({
        type: series.mark === "bar" ? "bar" : "line",
        name: columns.get(series.field)?.label ?? series.field,
        encode: { x: document.view.kind === "cartesian" ? document.view.x : "", y: series.field },
        yAxisIndex: series.axis === "right" ? 1 : 0,
        animationDelay: (dataIndex: number) => dataIndex * 12 + index * 100,
        itemStyle: series.mark === "bar"
          ? { color: ladder[index % ladder.length], borderRadius: [6, 6, 0, 0] }
          : { color: ladder[index % ladder.length] },
        ...(series.mark !== "bar" ? {
          lineStyle: { color: ladder[index % ladder.length], width: 2.16 },
          showSymbol: document.dataset.rows.length <= 60,
          symbolSize: 6,
        } : {}),
        ...(series.mark === "area" ? { areaStyle: { color: faintData, opacity: 1 } } : {}),
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
        axisLine: { lineStyle: { color: grid, width: 1 } },
        axisTick: { alignWithLabel: true, lineStyle: { color: faint } },
        axisLabel: { color: muted, fontSize: 10, fontWeight: 600, hideOverlap: true },
      },
      yAxis: valueAxis(new Map([[valueColumn.key, valueColumn]]), valueColumn.key, locale, muted, grid),
      series: [
        { type: "bar", stack: "waterfall", silent: true, itemStyle: { color: "transparent" }, data: waterfall.base },
        { type: "bar", stack: "waterfall", name: "Increase", itemStyle: { color: data, borderRadius: [5, 5, 0, 0] }, data: waterfall.positive },
        { type: "bar", stack: "waterfall", name: "Decrease", itemStyle: { color: "transparent", borderColor: data2, borderType: "dashed", borderWidth: 2.7 }, data: waterfall.negative },
        { type: "bar", stack: "waterfall", name: "Total", itemStyle: { color: hero, borderRadius: [5, 5, 0, 0] }, data: waterfall.total },
      ],
    };
  }
  return base;
}

function valueAxis(
  columns: Map<string, DataViewColumn>,
  field: string | undefined,
  locale: string | undefined,
  color: string,
  splitColor: string,
) {
  const valueColumn = field ? columns.get(field) : undefined;
  return {
    type: "value" as const,
    name: [valueColumn?.currency, valueColumn?.unit].filter(Boolean).join(" · "),
    nameTextStyle: { color, fontSize: 10, fontWeight: 600 },
    axisLabel: {
      color,
      fontSize: 10,
      fontWeight: 600,
      formatter: valueColumn ? (value: number) => formatDataViewCell(valueColumn, value, locale) : undefined,
    },
    splitLine: { lineStyle: { color: splitColor, type: "dashed" as const, width: 1 } },
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

function cssValue(style: CSSStyleDeclaration, property: string, fallback: string): string {
  return style.getPropertyValue(property).trim() || fallback;
}
