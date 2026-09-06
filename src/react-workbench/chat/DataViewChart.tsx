import { lazy, useMemo } from "react";
import type { DataViewDocument } from "../../app-core/chat/dataView";
import { DataViewLieflatChart } from "./DataViewLieflatChart";
import { selectDataViewChartTemplate } from "./dataViewChartTemplate";

const DataViewECharts = lazy(() => import("./DataViewECharts"));

export default function DataViewChart({ document }: { document: DataViewDocument }) {
  const template = useMemo(() => selectDataViewChartTemplate(document), [document]);
  if (template !== "mono-fallback") {
    return <DataViewLieflatChart document={document} template={template} />;
  }
  // DataViewCard owns the loading placeholder and the app error boundary owns failures.
  return <DataViewECharts document={document} />;
}
