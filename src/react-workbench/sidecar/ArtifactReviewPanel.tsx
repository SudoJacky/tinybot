import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OfficeArtifactKind } from "../../app-core/chat/officeArtifact";
import type { ArtifactComparison, ArtifactReview, ArtifactReviewStore } from "../../app-core/workspace/artifactReview";
import { logRendererEvent } from "../../app-core/native/rendererLogger";
import { OfficeArtifactPreview } from "./OfficeArtifactPreview";
import { readSpreadsheetComparison, type SpreadsheetComparison } from "./spreadsheetComparison";
import "./ArtifactReviewPanel.css";

export function ArtifactReviewPanel({ store, path, threadId, revision, epoch, responding, kind, title, onRestored }: {
  store: ArtifactReviewStore;
  path: string;
  threadId: string;
  revision?: string;
  epoch: number;
  responding: boolean;
  kind?: OfficeArtifactKind;
  title: string;
  onRestored: () => void;
}) {
  const { t } = useTranslation("chat");
  const [review, setReview] = useState<ArtifactReview | null>(null);
  const [comparison, setComparison] = useState<{ value: ArtifactComparison; revision: string; epoch: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const mounted = useRef(false);
  const generation = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let disposed = false;
    const current = ++generation.current;
    void store.load({ path, threadId }).then((saved) => {
      if (!disposed && current === generation.current) setReview(saved);
    }).catch((cause: unknown) => {
      if (!disposed && current === generation.current) setError(reportFailure("load", cause));
    });
    return () => { disposed = true; };
  }, [store, path, threadId, revision, epoch, reload]);

  const displayed = comparison && comparison.revision === revision && comparison.epoch === epoch && comparison.value.review.id === review?.id ? comparison.value : undefined;
  async function compare() {
    if (!revision || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const value = await store.compare({ path, threadId, expectedRevision: revision });
      if (!mounted.current) return;
      setReview(value.review);
      setComparison({ value, revision, epoch });
    } catch (cause) {
      if (mounted.current) { setComparison(undefined); setError(reportFailure("compare", cause)); }
    } finally { if (mounted.current) setBusy(false); }
  }
  async function resolve(action: "accept" | "restore") {
    if (!displayed || busy || responding) return;
    setBusy(true);
    setError(undefined);
    // A pending status read must not overwrite the resolved state.
    generation.current++;
    try {
      const saved = await store.resolve({ path, threadId, action, reviewId: displayed.review.id, expectedHash: displayed.currentHash });
      if (!mounted.current) return;
      generation.current++;
      setReview(saved);
      setComparison(undefined);
      if (action === "restore") onRestored();
    } catch (cause) {
      if (mounted.current) { setComparison(undefined); setError(reportFailure(action, cause)); setReload((value) => value + 1); }
    } finally { if (mounted.current) setBusy(false); }
  }
  if (!review && !error) return null;
  return <section className="react-artifact-review" aria-label={t("artifactReview.title")}>
    <div className="react-artifact-review__toolbar">
      <strong>{t("artifactReview.title")}</strong>
      {review?.state === "pending" ? <button type="button" disabled={!revision || busy} onClick={() => void compare()}>{t(busy ? "artifactReview.working" : "artifactReview.compare")}</button> : null}
    </div>
    {review ? <p role="status">{t(`artifactReview.${review.state}`)}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {!review && error ? <button type="button" onClick={() => { setError(undefined); setReload((value) => value + 1); }}>{t("artifactReview.retry")}</button> : null}
    {displayed ? <>
      {displayed.changed ? <ComparisonContent comparison={displayed} kind={kind} title={title} /> : <p>{t("artifactReview.unchanged")}</p>}
      {review?.state === "pending" ? <>
        <p>{t("artifactReview.liveFile")}</p>
        {responding ? <p>{t("artifactReview.waitForAgent")}</p> : null}
        <div className="react-artifact-review__actions">
          <button type="button" disabled={busy || responding || !revision} onClick={() => void resolve("accept")}>{t("artifactReview.accept")}</button>
          <button type="button" disabled={busy || responding || !revision || !displayed.changed} onClick={() => void resolve("restore")}>{t("artifactReview.restore")}</button>
        </div>
      </> : null}
    </> : null}
  </section>;
}

function ComparisonContent({ comparison, kind, title }: { comparison: ArtifactComparison; kind?: OfficeArtifactKind; title: string }) {
  const { t } = useTranslation("chat");
  const [sheetDiff, setSheetDiff] = useState<SpreadsheetComparison>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    setSheetDiff(undefined);
    setError(undefined);
    if (kind === "spreadsheet") void readSpreadsheetComparison(comparison.before, comparison.after)
      .then((value) => { if (!disposed) setSheetDiff(value); })
      .catch((cause: unknown) => { if (!disposed) setError(reportFailure("parse-comparison", cause)); });
    return () => { disposed = true; };
  }, [comparison, kind]);
  if (kind === "spreadsheet") return <>
    <p>{t("artifactReview.valuesOnly")}</p>
    {error ? <p role="alert">{error}</p> : !sheetDiff ? <p role="status">{t("artifactReview.working")}</p> : <>
      {sheetDiff.addedSheets.length ? <p>{t("artifactReview.addedSheets", { names: sheetDiff.addedSheets.join(", ") })}</p> : null}
      {sheetDiff.removedSheets.length ? <p>{t("artifactReview.removedSheets", { names: sheetDiff.removedSheets.join(", ") })}</p> : null}
      <p>{sheetDiff.total ? t("artifactReview.cellCount", { count: sheetDiff.total, shown: sheetDiff.changes.length }) : t("artifactReview.noValueChanges")}</p>
      {sheetDiff.changes.length ? <div className="react-artifact-review__table"><table>
        <thead><tr><th scope="col">{t("artifactReview.cell")}</th><th scope="col">{t("artifactReview.before")}</th><th scope="col">{t("artifactReview.after")}</th></tr></thead>
        <tbody>{sheetDiff.changes.map((cell) => <tr key={cell.address}><th scope="row">{cell.address}</th><td>{cell.before || t("details.officeCellEmpty")}</td><td>{cell.after || t("details.officeCellEmpty")}</td></tr>)}</tbody>
      </table></div> : null}
    </>}
  </>;
  return <>
    {kind ? <p>{t("artifactReview.previewOnly")}</p> : null}
    <div className="react-artifact-review__versions">{(["before", "after"] as const).map((side) => <div key={side}>
      <h4>{t(`artifactReview.${side}`)}</h4>
      {kind ? <OfficeArtifactPreview source={{ bytes: comparison[side], kind, title }} /> : <TextVersion bytes={comparison[side]} />}
    </div>)}</div>
  </>;
}

function TextVersion({ bytes }: { bytes: Uint8Array }) {
  const { t } = useTranslation("chat");
  const text = new TextDecoder().decode(bytes.subarray(0, 32_000));
  return <><pre>{text}</pre>{bytes.length > 32_000 ? <p>{t("artifactReview.textTruncated")}</p> : null}</>;
}
function reportFailure(action: string, cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  logRendererEvent("error", "artifact.review.failed", { action, error: message.slice(0, 512) });
  return message;
}
