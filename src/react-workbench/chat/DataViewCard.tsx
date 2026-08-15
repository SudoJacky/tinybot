import { lazy, Suspense, useEffect, useState } from "react";
import { BarChart3, Download, Maximize2, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  dataViewToCsv,
  formatDataViewCell,
  type DataViewDocument,
  type DataViewRow,
} from "../../app-core/chat/dataView";
import type { ArtifactRef } from "../../app-core/chat/chatTurnModel";

const DataViewChart = lazy(() => import("./DataViewChart"));

export function DataViewCard({
  artifact,
  expanded = false,
  onOpen,
}: {
  artifact: ArtifactRef;
  expanded?: boolean;
  onOpen?: (artifact: ArtifactRef) => void;
}) {
  const { i18n, t } = useTranslation("chat");
  const document = artifact.dataView;
  const chartAvailable = document ? document.view.kind === "cartesian" || document.view.kind === "waterfall" : false;
  const [activeTab, setActiveTab] = useState<"chart" | "data">(chartAvailable ? "chart" : "data");

  useEffect(() => {
    setActiveTab(chartAvailable ? "chart" : "data");
  }, [artifact.id, chartAvailable]);

  if (!document) {
    return (
      <section aria-label={artifact.title} className="react-data-view" data-state="invalid" role="alert">
        <header className="react-data-view__header">
          <span className="react-data-view__icon"><ShieldAlert aria-hidden="true" size={17} /></span>
          <div><h3>{artifact.title}</h3><p>{t("dataView.invalid")}</p></div>
        </header>
        {artifact.dataViewError ? <p className="react-data-view__error">{artifact.dataViewError}</p> : null}
      </section>
    );
  }

  const locale = i18n.resolvedLanguage;
  return (
    <section aria-label={document.title} className="react-data-view" data-expanded={expanded ? "true" : undefined}>
      <header className="react-data-view__header">
        <span className="react-data-view__icon"><BarChart3 aria-hidden="true" size={17} /></span>
        <div>
          <h3>{document.title}</h3>
          <p>{document.insight}</p>
        </div>
        <div aria-label={t("dataView.actions")} className="react-data-view__actions">
          {!expanded && onOpen ? (
            <button aria-label={t("dataView.expand", { title: document.title })} title={t("dataView.expandAction")} type="button" onClick={() => onOpen(artifact)}>
              <Maximize2 aria-hidden="true" size={15} />
            </button>
          ) : null}
          <button aria-label={t("dataView.download", { title: document.title })} title={t("dataView.downloadAction")} type="button" onClick={() => downloadCsv(document)}>
            <Download aria-hidden="true" size={15} />
          </button>
        </div>
      </header>

      {chartAvailable ? (
        <div aria-label={t("dataView.views")} className="react-data-view__tabs" role="tablist">
          <button aria-selected={activeTab === "chart"} role="tab" type="button" onClick={() => setActiveTab("chart")}>{t("dataView.chart")}</button>
          <button aria-selected={activeTab === "data"} role="tab" type="button" onClick={() => setActiveTab("data")}>{t("dataView.data")}</button>
        </div>
      ) : null}

      <div className="react-data-view__body">
        {activeTab === "chart" && chartAvailable ? (
          <Suspense
            fallback={(
              <div
                aria-busy="true"
                aria-label={t("dataView.chartLabel", { title: document.title, insight: document.insight })}
                className="react-data-view__chart"
                role="img"
              />
            )}
          >
            <DataViewChart document={document} />
          </Suspense>
        ) : document.view.kind === "metrics" ? (
          <DataViewMetrics document={document} locale={locale} />
        ) : (
          <DataViewTable document={document} locale={locale} />
        )}
      </div>

      <footer className="react-data-view__footer">
        <span data-status={document.provenance.status}>
          {document.provenance.status === "sourced"
            ? t("dataView.sourced")
            : document.provenance.status === "user_provided"
              ? t("dataView.userProvided")
              : t("dataView.unsourced")}
        </span>
        {document.provenance.asOf ? <span>{t("dataView.asOf", { date: document.provenance.asOf })}</span> : null}
        <span>{t("dataView.dimensions", { rows: document.dataset.rows.length, columns: document.dataset.columns.length })}</span>
      </footer>

      {expanded ? <DataViewProvenance document={document} /> : null}
    </section>
  );
}

function DataViewMetrics({ document, locale }: { document: DataViewDocument; locale?: string }) {
  if (document.view.kind !== "metrics") {
    return null;
  }
  const row = document.dataset.rows[document.dataset.rows.length - 1];
  const columns = new Map(document.dataset.columns.map((column) => [column.key, column]));
  return (
    <dl className="react-data-view__metrics">
      {document.view.items.map((item) => {
        const column = columns.get(item.field)!;
        const comparison = item.comparisonField ? columns.get(item.comparisonField) : undefined;
        return (
          <div key={item.field}>
            <dt>{column.label}</dt>
            <dd>{formatDataViewCell(column, row.values[item.field], locale)}</dd>
            {comparison ? <small>{comparison.label}: {formatDataViewCell(comparison, row.values[comparison.key], locale)}</small> : null}
          </div>
        );
      })}
    </dl>
  );
}

function DataViewTable({ document, locale }: { document: DataViewDocument; locale?: string }) {
  const fields = document.view.kind === "table" && document.view.fields?.length
    ? document.view.fields
    : document.dataset.columns.map((column) => column.key);
  const columns = fields.map((field) => document.dataset.columns.find((column) => column.key === field)!).filter(Boolean);
  const rows = sortedRows(document.dataset.rows, document);
  return (
    <div className="react-data-view__table-wrap">
      <table className="react-data-view__table">
        <thead><tr>{columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>{columns.map((column) => <td key={column.key}>{formatDataViewCell(column, row.values[column.key], locale)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function sortedRows(rows: DataViewRow[], document: DataViewDocument): DataViewRow[] {
  if (document.view.kind !== "table" || !document.view.defaultSort) {
    return rows;
  }
  const { field, direction } = document.view.defaultSort;
  return [...rows].sort((left, right) => {
    const a = left.values[field];
    const b = right.values[field];
    const order = typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a ?? "").localeCompare(String(b ?? ""));
    return direction === "desc" ? -order : order;
  });
}

function DataViewProvenance({ document }: { document: DataViewDocument }) {
  const { t } = useTranslation("chat");
  return (
    <section className="react-data-view__provenance">
      <h4>{t("dataView.provenance")}</h4>
      {document.provenance.methodology ? <p>{document.provenance.methodology}</p> : null}
      {document.provenance.sources.length ? (
        <ul>
          {document.provenance.sources.map((source) => (
            <li key={source.id}>
              {source.kind === "url" && source.uri ? <a href={source.uri} rel="noreferrer" target="_blank">{source.title}</a> : <span>{source.title}</span>}
              {source.locator ? <small>{source.locator}</small> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {document.provenance.caveats.length ? (
        <><h4>{t("dataView.caveats")}</h4><ul>{document.provenance.caveats.map((caveat, index) => <li key={`${caveat}:${index}`}>{caveat}</li>)}</ul></>
      ) : null}
    </section>
  );
}

function downloadCsv(document: DataViewDocument) {
  const blob = new Blob([dataViewToCsv(document)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFileName(document.title)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function safeFileName(value: string): string {
  const safe = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").slice(0, 96);
  return safe || "data-view";
}
