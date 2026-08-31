import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  formatDataViewCell,
  type DataViewColumn,
  type DataViewDocument,
} from "../../app-core/chat/dataView";
import type { DataViewChartTemplate } from "./dataViewChartTemplate";

type LieflatTemplate = Exclude<DataViewChartTemplate, "mono-fallback">;

type ChartContext = {
  document: DataViewDocument;
  locale?: string;
  dotLegend: (isDateAxis: boolean) => string;
  hairlineLegend: (isDateAxis: boolean) => string;
  rungLegend: (unit: string, approximate: boolean) => string;
};

const WIDTH = 760;
const HEIGHT = 360;
const PLOT_TOP = 38;
const PLOT_BOTTOM = 292;
const PLOT_LEFT = 48;
const PLOT_RIGHT = 730;

export function DataViewLieflatChart({
  document,
  template,
}: {
  document: DataViewDocument;
  template: LieflatTemplate;
}) {
  const { i18n, t } = useTranslation("chat");
  const { figureRef, isRevealed, replay, replayKey } = useChartReveal();
  const chartLabel = t("dataView.chartLabel", { title: document.title, insight: document.insight });
  const context: ChartContext = {
    document,
    locale: i18n.resolvedLanguage,
    dotLegend: (isDateAxis) => t(isDateAxis ? "dataView.dotDateLegend" : "dataView.dotRecordLegend"),
    hairlineLegend: (isDateAxis) => t(isDateAxis ? "dataView.hairlineDateLegend" : "dataView.hairlineRecordLegend"),
    rungLegend: (unit, approximate) => t("dataView.rungScale", {
      relation: approximate ? "≈" : "=",
      value: unit,
    }),
  };

  return (
    <figure
      aria-label={t("dataView.replayChartLabel", { chart: chartLabel })}
      className="react-data-view__chart react-data-view__chart--lieflat"
      data-reveal-state={isRevealed ? "revealed" : "pending"}
      data-template={template}
      onClick={replay}
      onKeyDown={(event) => handleReplayKeyDown(event, replay)}
      ref={figureRef}
      role="button"
      tabIndex={0}
    >
      {isRevealed ? (
        <svg aria-label={chartLabel} key={replayKey} role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
          <title>{chartLabel}</title>
          {renderTemplate(template, context)}
        </svg>
      ) : null}
    </figure>
  );
}

function renderTemplate(template: LieflatTemplate, context: ChartContext): ReactNode {
  switch (template) {
    case "f1-rung-bars": return <RungBars context={context} />;
    case "f2-hairline-line": return <HairlineLine context={context} />;
    case "f3-hairline-area": return <HairlineArea context={context} />;
    case "f5-tick-rows": return <TickRows context={context} />;
    case "f6-paired-rungs": return <PairedRungs context={context} />;
    case "f7-stacked-rungs": return <StackedRungs context={context} />;
    case "f9-rung-waterfall": return <RungWaterfall context={context} />;
    case "l3-barcode-lollipop": return <BarcodeLollipop context={context} />;
  }
}

function RungBars({ context }: { context: ChartContext }) {
  const { document, locale } = context;
  if (document.view.kind !== "cartesian") return null;
  const series = document.view.series[0];
  const xColumn = column(document, document.view.x);
  const valueColumn = column(document, series.field);
  const values = document.dataset.rows.map((row) => Number(row.values[series.field]));
  const maximum = Math.max(1, ...values);
  const scale = rungScale(values);
  const slot = (PLOT_RIGHT - PLOT_LEFT) / values.length;
  const halfWidth = Math.min(28, slot * 0.25);

  return (
    <>
      <line className="lieflat-fade lieflat-grid" x1={PLOT_LEFT - 12} x2={PLOT_RIGHT + 4} y1={PLOT_BOTTOM + 4} y2={PLOT_BOTTOM + 4} />
      {document.dataset.rows.map((row, rowIndex) => {
        const value = values[rowIndex];
        const x = PLOT_LEFT + slot * (rowIndex + 0.5);
        const top = yForPositive(value, maximum);
        const rungs = rungPositions(value, scale.unit);
        return (
          <g key={row.id}>
            {rungs.map((rungValue, rungIndex) => {
              const y = yForPositive(rungValue, maximum);
              const width = halfWidth * (0.9 + deterministic(rowIndex, rungIndex) * 0.2);
              return (
                <g key={rungIndex}>
                  <line
                    className="lieflat-fade lieflat-rung lieflat-tone-0"
                    style={{ animationDelay: `${rowIndex * 100 + rungIndex * 12}ms` }}
                    x1={x - width}
                    x2={x + width}
                    y1={y}
                    y2={y}
                  />
                  {rungIndex % 5 === 4 ? (
                    <circle
                      className="lieflat-fade lieflat-marker"
                      cx={x + halfWidth + 5}
                      cy={y}
                      r={1.2}
                      style={{ animationDelay: `${rowIndex * 100 + rungIndex * 12}ms` }}
                    />
                  ) : null}
                </g>
              );
            })}
            <text className="lieflat-fade lieflat-value" style={{ animationDelay: `${400 + rowIndex * 100}ms` }} textAnchor="middle" x={x} y={Math.max(16, top - 12)}>
              {formatValue(valueColumn, value, locale)}
              <title>{`${axisValue(xColumn, row.values[xColumn.key], locale)} — ${formatValue(valueColumn, value, locale)}`}</title>
            </text>
            <text className="lieflat-fade lieflat-axis" style={{ animationDelay: `${rowIndex * 100}ms` }} textAnchor="middle" x={x} y={PLOT_BOTTOM + 25}>
              {truncate(axisValue(xColumn, row.values[xColumn.key], locale), 13)}
            </text>
          </g>
        );
      })}
      <ChartAnnotation>{context.rungLegend(formatValue(valueColumn, scale.unit, locale), scale.approximate)}</ChartAnnotation>
    </>
  );
}

function TickRows({ context }: { context: ChartContext }) {
  const { document, locale } = context;
  if (document.view.kind !== "cartesian") return null;
  const series = document.view.series[0];
  const xColumn = column(document, document.view.x);
  const valueColumn = column(document, series.field);
  const values = document.dataset.rows.map((row) => Number(row.values[series.field]));
  const maximum = Math.max(1, ...values);
  const scale = rungScale(values);
  const labelEnd = 170;
  const railStart = 192;
  const railEnd = 674;
  const rowStep = 36;
  const firstY = 38 + Math.max(0, (8 - values.length) * 6);

  return (
    <>
      {document.dataset.rows.map((row, rowIndex) => {
        const value = values[rowIndex];
        const y = firstY + rowIndex * rowStep;
        const end = railStart + (value / maximum) * (railEnd - railStart);
        const rungs = rungPositions(value, scale.unit);
        return (
          <g key={row.id}>
            <text className="lieflat-fade lieflat-row-label" style={{ animationDelay: `${rowIndex * 100}ms` }} textAnchor="end" x={labelEnd} y={y + 3}>
              {truncate(axisValue(xColumn, row.values[xColumn.key], locale), 22)}
            </text>
            <line className="lieflat-fade lieflat-grid" style={{ animationDelay: `${rowIndex * 100}ms` }} x1={railStart} x2={railEnd} y1={y + 9} y2={y + 9} />
            {rungs.map((_, rungIndex) => {
              const x = railStart + ((rungIndex + 1) / rungs.length) * (end - railStart);
              const tickHeight = 13 + deterministic(rowIndex, rungIndex) * 7;
              return (
                <g key={rungIndex}>
                  <line
                    className="lieflat-fade lieflat-tick lieflat-tone-0"
                    style={{ animationDelay: `${rowIndex * 100 + rungIndex * 12}ms` }}
                    x1={x}
                    x2={x}
                    y1={y + 9 - tickHeight}
                    y2={y + 9}
                  />
                  {rungIndex % 5 === 4 ? <circle className="lieflat-fade lieflat-marker" cx={x} cy={y + 14} r={1.2} /> : null}
                </g>
              );
            })}
            <text className="lieflat-fade lieflat-value" style={{ animationDelay: `${400 + rowIndex * 100}ms` }} x={Math.min(railEnd + 10, end + 10)} y={y + 3}>
              {formatValue(valueColumn, value, locale)}
              <title>{`${axisValue(xColumn, row.values[xColumn.key], locale)} — ${formatValue(valueColumn, value, locale)}`}</title>
            </text>
          </g>
        );
      })}
      <ChartAnnotation>{context.rungLegend(formatValue(valueColumn, scale.unit, locale), scale.approximate)}</ChartAnnotation>
    </>
  );
}

function PairedRungs({ context }: { context: ChartContext }) {
  const { document, locale } = context;
  if (document.view.kind !== "cartesian") return null;
  const xColumn = column(document, document.view.x);
  const columns = document.view.series.map((series) => column(document, series.field));
  const values = document.dataset.rows.flatMap((row) => document.view.kind === "cartesian"
    ? document.view.series.map((series) => Number(row.values[series.field]))
    : []);
  const maximum = Math.max(1, ...values);
  const scale = rungScale(values);
  const slot = (PLOT_RIGHT - PLOT_LEFT) / document.dataset.rows.length;
  const halfWidth = Math.min(17, slot * 0.14);

  return (
    <>
      <SeriesLegend columns={columns} tones={[3, 0]} />
      <line className="lieflat-fade lieflat-grid" x1={PLOT_LEFT - 12} x2={PLOT_RIGHT + 4} y1={PLOT_BOTTOM + 4} y2={PLOT_BOTTOM + 4} />
      {document.dataset.rows.map((row, rowIndex) => {
        const center = PLOT_LEFT + slot * (rowIndex + 0.5);
        return (
          <g key={row.id}>
            {document.view.kind === "cartesian" ? document.view.series.map((series, seriesIndex) => {
              const value = Number(row.values[series.field]);
              const x = center + (seriesIndex === 0 ? -halfWidth - 6 : halfWidth + 6);
              const rungs = rungPositions(value, scale.unit);
              return (
                <g key={series.field}>
                  {rungs.map((rungValue, rungIndex) => (
                    <line
                      className={`lieflat-fade lieflat-rung lieflat-tone-${seriesIndex === 0 ? 3 : 0}`}
                      key={rungIndex}
                      style={{ animationDelay: `${seriesIndex * 150 + rowIndex * 100 + rungIndex * 12}ms` }}
                      x1={x - halfWidth}
                      x2={x + halfWidth}
                      y1={yForPositive(rungValue, maximum)}
                      y2={yForPositive(rungValue, maximum)}
                    />
                  ))}
                  <text className={`lieflat-fade lieflat-value lieflat-fill-tone-${seriesIndex === 0 ? 3 : 0}`} style={{ animationDelay: `${450 + rowIndex * 100}ms` }} textAnchor="middle" x={x} y={Math.max(34, yForPositive(value, maximum) - 10)}>
                    {formatValue(columns[seriesIndex], value, locale)}
                    <title>{`${axisValue(xColumn, row.values[xColumn.key], locale)} · ${columns[seriesIndex].label} — ${formatValue(columns[seriesIndex], value, locale)}`}</title>
                  </text>
                </g>
              );
            }) : null}
            <text className="lieflat-fade lieflat-axis" style={{ animationDelay: `${rowIndex * 100}ms` }} textAnchor="middle" x={center} y={PLOT_BOTTOM + 25}>
              {truncate(axisValue(xColumn, row.values[xColumn.key], locale), 12)}
            </text>
          </g>
        );
      })}
      <ChartAnnotation>{context.rungLegend(formatValue(columns[1], scale.unit, locale), scale.approximate)}</ChartAnnotation>
    </>
  );
}

function StackedRungs({ context }: { context: ChartContext }) {
  const { document, locale } = context;
  if (document.view.kind !== "cartesian") return null;
  const xColumn = column(document, document.view.x);
  const columns = document.view.series.map((series) => column(document, series.field));
  const rowTotals = document.dataset.rows.map((row) => document.view.kind === "cartesian"
    ? document.view.series.reduce((sum, series) => sum + Number(row.values[series.field]), 0)
    : 0);
  const values = document.dataset.rows.flatMap((row) => document.view.kind === "cartesian"
    ? document.view.series.map((series) => Number(row.values[series.field]))
    : []);
  const maximum = Math.max(1, ...rowTotals);
  const scale = rungScale(values);
  const slot = (PLOT_RIGHT - PLOT_LEFT) / document.dataset.rows.length;
  const halfWidth = Math.min(30, slot * 0.2);
  const tones = [0, 2, 3];

  return (
    <>
      <SeriesLegend columns={columns} tones={tones} />
      <line className="lieflat-fade lieflat-grid" x1={PLOT_LEFT - 12} x2={PLOT_RIGHT + 4} y1={PLOT_BOTTOM + 4} y2={PLOT_BOTTOM + 4} />
      {document.dataset.rows.map((row, rowIndex) => {
        const x = PLOT_LEFT + slot * (rowIndex + 0.5);
        let cumulative = 0;
        return (
          <g key={row.id}>
            {document.view.kind === "cartesian" ? document.view.series.map((series, seriesIndex) => {
              const value = Number(row.values[series.field]);
              const start = cumulative;
              cumulative += value;
              const rungs = rungPositions(value, scale.unit);
              return (
                <g key={series.field}>
                  {rungs.map((rungValue, rungIndex) => {
                    const level = start + rungValue;
                    return (
                      <line
                        className={`lieflat-fade lieflat-rung lieflat-tone-${tones[seriesIndex]}`}
                        key={rungIndex}
                        style={{ animationDelay: `${rowIndex * 100 + seriesIndex * 80 + rungIndex * 12}ms` }}
                        x1={x - halfWidth}
                        x2={x + halfWidth}
                        y1={yForPositive(level, maximum)}
                        y2={yForPositive(level, maximum)}
                      />
                    );
                  })}
                  {value / maximum > 0.08 ? (
                    <text className={`lieflat-fade lieflat-segment-value lieflat-fill-tone-${tones[seriesIndex]}`} textAnchor="start" x={x + halfWidth + 7} y={yForPositive(start + value / 2, maximum) + 3}>
                      {formatValue(columns[seriesIndex], value, locale)}
                    </text>
                  ) : null}
                </g>
              );
            }) : null}
            <text className="lieflat-fade lieflat-value" style={{ animationDelay: `${600 + rowIndex * 100}ms` }} textAnchor="middle" x={x} y={Math.max(34, yForPositive(rowTotals[rowIndex], maximum) - 12)}>
              {formatCompactNumber(rowTotals[rowIndex], locale)}
              <title>{`${axisValue(xColumn, row.values[xColumn.key], locale)} — ${formatCompactNumber(rowTotals[rowIndex], locale)}`}</title>
            </text>
            <text className="lieflat-fade lieflat-axis" style={{ animationDelay: `${rowIndex * 100}ms` }} textAnchor="middle" x={x} y={PLOT_BOTTOM + 25}>
              {truncate(axisValue(xColumn, row.values[xColumn.key], locale), 13)}
            </text>
          </g>
        );
      })}
      <ChartAnnotation>{context.rungLegend(formatValue(columns[0], scale.unit, locale), scale.approximate)}</ChartAnnotation>
    </>
  );
}

function HairlineLine({ context }: { context: ChartContext }) {
  const data = singleSeriesData(context.document);
  const { rows, values, xColumn, valueColumn } = data;
  const x = xScale(values.length);
  const y = valueScale(values, PLOT_TOP, PLOT_BOTTOM - 14);
  const points = values.map((value, index) => `${x(index)} ${y(value)}`).join(" L ");
  const peaks = peakIndexes(values, 2, 5);
  const isDate = xColumn.type === "date" || xColumn.type === "datetime";

  return (
    <>
      <line className="lieflat-fade lieflat-grid" x1={PLOT_LEFT - 12} x2={PLOT_RIGHT + 4} y1={PLOT_BOTTOM + 4} y2={PLOT_BOTTOM + 4} />
      {values.map((_, index) => (
        <line className="lieflat-fade lieflat-calendar-tick" key={`tick-${rows[index].id}`} style={{ animationDelay: `${index * 8}ms` }} x1={x(index)} x2={x(index)} y1={PLOT_BOTTOM + 4} y2={PLOT_BOTTOM + 12} />
      ))}
      <path className="lieflat-draw lieflat-series-line lieflat-tone-0" d={`M${points}`} pathLength={1} />
      {values.map((value, index) => {
        const weekend = isWeekend(xColumn, rows[index].values[xColumn.key]);
        const peak = peaks.includes(index);
        const tone = peak ? 1 : 0;
        return (
          <g key={rows[index].id}>
            <circle
              className="lieflat-pop lieflat-series-dot"
              cx={x(index)}
              cy={y(value)}
              fill={weekend ? "var(--lieflat-paper)" : toneColor(tone)}
              r={peak ? 4.8 : 2.6}
              stroke={toneColor(tone)}
              strokeWidth={weekend ? 2.16 : 0}
              style={{ animationDelay: `${200 + index * 12}ms` }}
            >
              <title>{`${axisValue(xColumn, rows[index].values[xColumn.key], context.locale)} — ${formatValue(valueColumn, value, context.locale)}`}</title>
            </circle>
            {peak ? (
              <text className="lieflat-fade lieflat-peak" style={{ animationDelay: `${850 + index * 8}ms` }} textAnchor="middle" x={x(index)} y={Math.max(17, y(value) - 12)}>
                {formatValue(valueColumn, value, context.locale)}
              </text>
            ) : null}
          </g>
        );
      })}
      <AxisDateLabels rows={rows} column={xColumn} locale={context.locale} x={x} />
      <ChartAnnotation>{context.dotLegend(isDate)}</ChartAnnotation>
    </>
  );
}

function HairlineArea({ context }: { context: ChartContext }) {
  const data = singleSeriesData(context.document);
  const { rows, values, xColumn, valueColumn } = data;
  const x = xScale(values.length);
  const y = valueScale(values, PLOT_TOP, PLOT_BOTTOM - 14);
  const points = values.map((value, index) => `${x(index)} ${y(value)}`).join(" L ");
  const peak = peakIndexes(values, 1, 0)[0];
  const isDate = xColumn.type === "date" || xColumn.type === "datetime";

  return (
    <>
      <line className="lieflat-fade lieflat-grid" x1={PLOT_LEFT - 12} x2={PLOT_RIGHT + 4} y1={PLOT_BOTTOM + 4} y2={PLOT_BOTTOM + 4} />
      {values.map((value, index) => (
        <line
          className={`lieflat-fade lieflat-area-hairline ${index === peak ? "lieflat-tone-1" : "lieflat-tone-3"}`}
          key={rows[index].id}
          style={{ animationDelay: `${index * 12}ms` }}
          x1={x(index)}
          x2={x(index)}
          y1={PLOT_BOTTOM}
          y2={y(value)}
        >
          <title>{`${axisValue(xColumn, rows[index].values[xColumn.key], context.locale)} — ${formatValue(valueColumn, value, context.locale)}`}</title>
        </line>
      ))}
      <path className="lieflat-draw lieflat-series-line lieflat-tone-0" d={`M${points}`} pathLength={1} style={{ animationDelay: "300ms" }} />
      <circle className="lieflat-pop lieflat-series-dot" cx={x(peak)} cy={y(values[peak])} fill="var(--lieflat-tone-1)" r={4.8} style={{ animationDelay: "950ms" }} />
      <text className="lieflat-fade lieflat-peak" style={{ animationDelay: "1000ms" }} textAnchor="middle" x={x(peak)} y={Math.max(17, y(values[peak]) - 12)}>
        {formatValue(valueColumn, values[peak], context.locale)}
      </text>
      <AxisDateLabels rows={rows} column={xColumn} locale={context.locale} x={x} />
      <ChartAnnotation>{context.hairlineLegend(isDate)}</ChartAnnotation>
    </>
  );
}

function BarcodeLollipop({ context }: { context: ChartContext }) {
  const data = singleSeriesData(context.document);
  const { rows, values, xColumn, valueColumn } = data;
  const x = xScale(values.length);
  const y = valueScale(values, PLOT_TOP, PLOT_BOTTOM - 14);
  const peaks = peakIndexes(values, 3, Math.max(6, Math.floor(values.length / 15)));
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);

  return (
    <>
      {values.map((value, index) => {
        const weekend = isWeekend(xColumn, rows[index].values[xColumn.key]);
        const peak = peaks.includes(index);
        const tone = peak ? 1 : porcelainValueTone(value, minimum, maximum);
        return (
          <g key={rows[index].id}>
            <line className="lieflat-fade lieflat-barcode-grid" style={{ animationDelay: `${index * 8}ms` }} x1={x(index)} x2={x(index)} y1={PLOT_TOP - 8} y2={PLOT_BOTTOM} />
            <line className={`lieflat-fade lieflat-lollipop-stem lieflat-tone-${tone}`} style={{ animationDelay: `${250 + index * 8}ms` }} x1={x(index)} x2={x(index)} y1={y(value)} y2={Math.min(PLOT_BOTTOM, y(value) + 18 + deterministic(index, 9) * 24)} />
            <circle
              className="lieflat-pop lieflat-series-dot"
              cx={x(index)}
              cy={y(value)}
              fill={weekend ? "var(--lieflat-paper)" : toneColor(tone)}
              r={peak ? 4.6 : 2.4}
              stroke={toneColor(tone)}
              strokeWidth={weekend ? 1.98 : 0}
              style={{ animationDelay: `${300 + index * 8}ms` }}
            >
              <title>{`${axisValue(xColumn, rows[index].values[xColumn.key], context.locale)} — ${formatValue(valueColumn, value, context.locale)}`}</title>
            </circle>
            {peak ? (
              <text className="lieflat-fade lieflat-peak" style={{ animationDelay: `${900 + index * 4}ms` }} textAnchor="middle" x={x(index)} y={Math.max(17, y(value) - 11)}>
                {formatValue(valueColumn, value, context.locale)}
              </text>
            ) : null}
          </g>
        );
      })}
      <AxisDateLabels rows={rows} column={xColumn} locale={context.locale} x={x} />
      <ChartAnnotation>{context.dotLegend(true)}</ChartAnnotation>
    </>
  );
}

function RungWaterfall({ context }: { context: ChartContext }) {
  const { document, locale } = context;
  if (document.view.kind !== "waterfall") return null;
  const categoryColumn = column(document, document.view.category);
  const valueColumn = column(document, document.view.value);
  let running = 0;
  const steps = document.dataset.rows.map((row) => {
    const value = Number(row.values[document.view.kind === "waterfall" ? document.view.value : ""]);
    const total = document.view.kind === "waterfall" && document.view.totalField
      ? row.values[document.view.totalField] === true
      : false;
    const from = total ? 0 : running;
    const to = total ? value : running + value;
    running = to;
    return { row, value, total, from, to };
  });
  const extent = steps.flatMap((step) => [step.from, step.to, 0]);
  const minimum = Math.min(...extent);
  const maximum = Math.max(...extent);
  const y = extentScale(minimum, maximum, PLOT_TOP, PLOT_BOTTOM);
  const slot = (PLOT_RIGHT - PLOT_LEFT) / steps.length;
  const halfWidth = Math.min(27, slot * 0.2);
  const scale = rungScale(steps.map((step) => Math.abs(step.to - step.from)));

  return (
    <>
      <line className="lieflat-fade lieflat-grid" x1={PLOT_LEFT - 12} x2={PLOT_RIGHT + 4} y1={y(0)} y2={y(0)} />
      {steps.map((step, stepIndex) => {
        const x = PLOT_LEFT + slot * (stepIndex + 0.5);
        const direction = step.to >= step.from ? 1 : -1;
        const rungs = rungPositions(Math.abs(step.to - step.from), scale.unit);
        const negative = !step.total && step.value < 0;
        const tone = step.total ? 1 : negative ? 2 : 0;
        const top = Math.min(y(step.from), y(step.to));
        const next = steps[stepIndex + 1];
        const nextLevel = next?.total ? next.to : next?.from;
        return (
          <g key={step.row.id}>
            {rungs.map((rungValue, rungIndex) => {
              const level = step.from + direction * rungValue;
              const width = halfWidth * (0.9 + deterministic(stepIndex, rungIndex) * 0.2);
              return (
                <line
                  className={`lieflat-fade lieflat-rung ${negative ? "lieflat-rung--negative" : ""} lieflat-tone-${tone}`}
                  key={rungIndex}
                  style={{ animationDelay: `${stepIndex * 120 + rungIndex * 12}ms` }}
                  x1={x - width}
                  x2={x + width}
                  y1={y(level)}
                  y2={y(level)}
                />
              );
            })}
            {next && nextLevel !== undefined ? (
              <line
                className="lieflat-fade lieflat-waterfall-connector"
                style={{ animationDelay: `${300 + stepIndex * 120}ms` }}
                x1={x + halfWidth + 3}
                x2={PLOT_LEFT + slot * (stepIndex + 1.5) - halfWidth - 3}
                y1={y(step.to)}
                y2={y(nextLevel)}
              />
            ) : null}
            <text className={`lieflat-fade lieflat-value ${negative || step.total ? `lieflat-fill-tone-${tone}` : ""}`} style={{ animationDelay: `${450 + stepIndex * 120}ms` }} textAnchor="middle" x={x} y={Math.max(17, top - 11)}>
              {formatValue(valueColumn, step.value, locale)}
              <title>{`${axisValue(categoryColumn, step.row.values[categoryColumn.key], locale)} — ${formatValue(valueColumn, step.value, locale)}`}</title>
            </text>
            <text className="lieflat-fade lieflat-axis" style={{ animationDelay: `${stepIndex * 120}ms` }} textAnchor="middle" x={x} y={PLOT_BOTTOM + 25}>
              {truncate(axisValue(categoryColumn, step.row.values[categoryColumn.key], locale), 13)}
            </text>
          </g>
        );
      })}
      <ChartAnnotation>{context.rungLegend(formatValue(valueColumn, scale.unit, locale), scale.approximate)}</ChartAnnotation>
    </>
  );
}

function SeriesLegend({ columns, tones }: { columns: DataViewColumn[]; tones: number[] }) {
  const itemWidth = (PLOT_RIGHT - PLOT_LEFT) / columns.length;
  return (
    <g>
      {columns.map((item, index) => {
        const x = PLOT_LEFT + index * itemWidth;
        return (
          <g className="lieflat-fade" key={item.key} style={{ animationDelay: `${index * 100}ms` }}>
            <line className={`lieflat-rung lieflat-tone-${tones[index]}`} x1={x} x2={x + 22} y1={18} y2={18} />
            <text className="lieflat-legend" x={x + 30} y={21}>{truncate(item.label, 22)}</text>
          </g>
        );
      })}
    </g>
  );
}

function AxisDateLabels({
  rows,
  column: xColumn,
  locale,
  x,
}: {
  rows: DataViewDocument["dataset"]["rows"];
  column: DataViewColumn;
  locale?: string;
  x: (index: number) => number;
}) {
  const indexes = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
  return (
    <>
      {indexes.map((index, labelIndex) => (
        <text
          className="lieflat-fade lieflat-axis"
          key={rows[index].id}
          style={{ animationDelay: `${120 + labelIndex * 100}ms` }}
          textAnchor={index === 0 ? "start" : index === rows.length - 1 ? "end" : "middle"}
          x={x(index)}
          y={PLOT_BOTTOM + 25}
        >
          {truncate(axisValue(xColumn, rows[index].values[xColumn.key], locale), 18)}
        </text>
      ))}
    </>
  );
}

function ChartAnnotation({ children }: { children: ReactNode }) {
  return <text className="lieflat-fade lieflat-annotation" style={{ animationDelay: "900ms" }} textAnchor="middle" x={WIDTH / 2} y={HEIGHT - 7}>{children}</text>;
}

function singleSeriesData(document: DataViewDocument) {
  if (document.view.kind !== "cartesian") {
    throw new Error("A cartesian data view is required.");
  }
  const series = document.view.series[0];
  return {
    rows: document.dataset.rows,
    values: document.dataset.rows.map((row) => Number(row.values[series.field])),
    xColumn: column(document, document.view.x),
    valueColumn: column(document, series.field),
  };
}

function column(document: DataViewDocument, key: string): DataViewColumn {
  return document.dataset.columns.find((item) => item.key === key)!;
}

function formatValue(column: DataViewColumn, value: number, locale?: string): string {
  return formatDataViewCell(column, value, locale);
}

function formatCompactNumber(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2, notation: "compact" }).format(value);
}

function axisValue(column: DataViewColumn, value: unknown, locale?: string): string {
  if (typeof value !== "string") return String(value ?? "—");
  if (column.type !== "date" && column.type !== "datetime") return value;
  const parsed = column.type === "date" ? new Date(`${value}T00:00:00`) : new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(parsed);
}

function isWeekend(column: DataViewColumn, value: unknown): boolean {
  if (typeof value !== "string" || (column.type !== "date" && column.type !== "datetime")) return false;
  const parsed = column.type === "date" ? new Date(`${value}T00:00:00`) : new Date(value);
  return !Number.isNaN(parsed.getTime()) && (parsed.getDay() === 0 || parsed.getDay() === 6);
}

function porcelainValueTone(value: number, minimum: number, maximum: number): number {
  if (maximum <= minimum) return 0;
  const band = Math.min(3, Math.floor(((value - minimum) / (maximum - minimum)) * 4));
  return [4, 3, 2, 0][band];
}

function toneColor(tone: number): string {
  return `var(--lieflat-tone-${tone})`;
}

function truncate(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

function rungScale(values: number[]): { unit: number; approximate: boolean } {
  const maximum = Math.max(0, ...values.filter((value) => Number.isFinite(value)));
  if (maximum === 0) return { unit: 1, approximate: false };
  const allSmallIntegers = maximum <= 32 && values.every(Number.isInteger);
  const unit = allSmallIntegers ? 1 : niceUnit(maximum / 28);
  const approximate = !values.every((value) => nearlyInteger(value / unit));
  return { unit, approximate };
}

function rungPositions(value: number, unit: number): number[] {
  if (value <= 0) return [];
  const count = Math.max(1, Math.ceil(value / unit));
  return Array.from({ length: count }, (_, index) => ((index + 1) / count) * value);
}

function niceUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function nearlyInteger(value: number): boolean {
  return Math.abs(value - Math.round(value)) < 1e-9;
}

function yForPositive(value: number, maximum: number): number {
  return PLOT_BOTTOM - (value / maximum) * (PLOT_BOTTOM - PLOT_TOP - 16);
}

function xScale(count: number): (index: number) => number {
  if (count <= 1) return () => (PLOT_LEFT + PLOT_RIGHT) / 2;
  return (index) => PLOT_LEFT + (index / (count - 1)) * (PLOT_RIGHT - PLOT_LEFT);
}

function valueScale(values: number[], top: number, bottom: number): (value: number) => number {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return extentScale(minimum, maximum, top, bottom);
}

function extentScale(minimum: number, maximum: number, top: number, bottom: number): (value: number) => number {
  const span = Math.max(Math.abs(maximum - minimum), Math.abs(maximum) * 0.08, 1);
  const paddedMinimum = minimum - span * 0.08;
  const paddedMaximum = maximum + span * 0.08;
  return (value) => top + ((paddedMaximum - value) / (paddedMaximum - paddedMinimum)) * (bottom - top);
}

function peakIndexes(values: number[], count: number, minimumGap: number): number[] {
  const peaks: number[] = [];
  for (const index of values.map((_, itemIndex) => itemIndex).sort((left, right) => values[right] - values[left])) {
    if (peaks.every((peak) => Math.abs(peak - index) >= minimumGap)) peaks.push(index);
    if (peaks.length === count) break;
  }
  return peaks;
}

function deterministic(first: number, second: number): number {
  return Math.abs(((first + 1) * 73856093 ^ (second + 1) * 19349663) % 1000) / 1000;
}

function useChartReveal() {
  const figureRef = useRef<HTMLElement | null>(null);
  const [isRevealed, setIsRevealed] = useState(false);
  const [replayKey, setReplayKey] = useState(0);

  useEffect(() => {
    const figure = figureRef.current;
    if (!figure) return;
    if (typeof IntersectionObserver === "undefined") {
      setIsRevealed(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setIsRevealed(true);
      observer.disconnect();
    }, { threshold: 0.3 });
    observer.observe(figure);
    return () => observer.disconnect();
  }, []);

  const replay = () => {
    if (isRevealed) setReplayKey((value) => value + 1);
  };
  return { figureRef, isRevealed, replay, replayKey };
}

function handleReplayKeyDown(event: ReactKeyboardEvent<HTMLElement>, replay: () => void): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  replay();
}
