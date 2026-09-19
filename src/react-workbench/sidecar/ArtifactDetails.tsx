import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceStore } from "../services";
import type { ArtifactRef, LoadedArtifactDetail } from "../../app-core/chat/chatTurnContracts";
import type { OfficeArtifactSource, SpreadsheetCellChangeRequest } from "../../app-core/chat/officeArtifact";
import { resolveCodeArtifactLanguage } from "../../app-core/chat/codeArtifact";
import type { AgentInputReference } from "../../app-core/chat/agentInputReference";
import { officeContentReference } from "../../app-core/chat/officeContentReference";
import { useArtifactFile } from "../chat/useArtifactFile";
import { DataViewCard } from "../chat/DataViewCard";
import { AssistantMarkdown } from "../chat/AssistantMarkdown";
import { ArtifactReviewPanel } from "./ArtifactReviewPanel";
import { DelimitedTextPreview } from "./DelimitedTextPreview";
import { artifactDelimiter } from "./delimitedText";
import { OfficeArtifactPreview } from "./OfficeArtifactPreview";
import { ImageArtifactPreview } from "./ImageArtifactPreview";
import { CodeArtifactPreview } from "./CodeArtifactPreview";
import type { AssistantFileLink } from "../chat/assistantFileLinks";

export function ArtifactDetails({
  artifact,
  detail: storedDetail,
  error: storedError,
  loading: storedLoading,
  notice: storedNotice,
  office: storedOffice,
  localThreadId,
  reviewEpoch,
  responding,
  observeFile,
  workspaceStore,
  onReference,
  onAskForSpreadsheetChange,
  onOpenFileLink,
}: {
  artifact: ArtifactRef;
  detail?: LoadedArtifactDetail;
  error?: string;
  loading: boolean;
  notice?: string;
  office?: OfficeArtifactSource;
  localThreadId?: string;
  reviewEpoch: number;
  responding: boolean;
  observeFile: boolean;
  workspaceStore?: Pick<WorkspaceStore, "readThreadFile" | "readThreadFileBytes" | "artifactReviews">;
  onReference?: (reference: AgentInputReference) => void;
  onAskForSpreadsheetChange?: (artifact: ArtifactRef, request: SpreadsheetCellChangeRequest, revision?: string) => void;
  onOpenFileLink: (link: AssistantFileLink) => void;
}) {
  const { t } = useTranslation("chat");
  const [refreshKey, setRefreshKey] = useState(0);
  const file = useArtifactFile({
    refreshKey,
    artifact, enabled: Boolean(localThreadId) && observeFile, threadId: localThreadId, workspaceStore,
    unavailableMessage: t("details.filePreviewUnavailable"), binaryMessage: t("details.binaryFilePreviewUnsupported"),
  });
  const { detail, error, loading, office } = localThreadId ? file : { detail: storedDetail, error: storedError, loading: storedLoading, office: storedOffice };
  const notice = localThreadId ? (file.truncated ? t("details.filePreviewTruncated") : undefined) : storedNotice;
  function referenceArtifact() {
    const text = detail?.dataView ? JSON.stringify(detail.dataView) : detail?.textContent;
    const excerpt = text && text.length > 12000 ? text.slice(0, 12000) + "\n[Preview excerpt truncated]" : text;
    onReference?.({
      kind: "reference", title: artifact.title, detail: t("details.artifactReference"),
      ...(localThreadId ? { referenceKind: "file", sourcePath: artifact.fetchPath, scope: localThreadId, revision: file.revision } as const : {}),
      sourceText: [
        `Artifact: ${artifact.title}`, `Artifact ID: ${artifact.id}`,
        ...(localThreadId ? [`File: ${artifact.fetchPath}`, `Viewed revision: ${file.revision}`, "Verify the current file before editing; this reference describes the viewed revision."] : []),
        ...(excerpt ? [excerpt] : []),
      ].join("\n"),
    });
  }
  const markdown = isMarkdownArtifact(artifact, detail);
  const delimiter = !markdown && !office && !detail?.dataView && !detail?.imageDataUrl
    ? artifactDelimiter(artifact.fetchPath || artifact.title, detail?.mimeType || artifact.mimeType) : undefined;
  const delimited = delimiter !== undefined && detail?.textContent !== undefined;
  const codeLanguage = resolveCodeArtifactLanguage({ path: artifact.fetchPath, title: artifact.title, mimeType: detail?.mimeType || artifact.mimeType });
  const referenceAction = onReference ? <button disabled={loading || Boolean(error)} onClick={referenceArtifact} type="button">{t("details.referenceInChat")}</button> : null;
  const markdownContent = detail?.textContent && markdown
    ? { text: detail.textContent, title: detail.title }
    : undefined;
  return (
    <div className="react-artifact-detail" data-content={markdown || office?.kind === "document" ? "document" : "preview"}>
      {!delimited ? <div className="react-artifact-detail__toolbar">
        {localThreadId ? <span role="status">{t("details.fileAutoUpdates")}</span> : null}
        <div className="react-artifact-detail__actions">{referenceAction}</div>
      </div> : null}
      {localThreadId && artifact.fetchPath && workspaceStore?.artifactReviews ? (
        <ArtifactReviewPanel store={workspaceStore.artifactReviews} path={artifact.fetchPath} threadId={localThreadId}
          revision={error ? undefined : file.revision} epoch={reviewEpoch} responding={responding}
          kind={office?.kind} title={artifact.title} onRestored={() => setRefreshKey((value) => value + 1)} />
      ) : null}

      {loading ? <p aria-live="polite">{t("details.loadingArtifact")}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p className="react-artifact-detail__notice">{notice}</p> : null}
      {localThreadId && file.loadMore ? <button type="button" disabled={file.loadingMore} onClick={file.loadMore}>{t("automations.loadMore", { ns: "common" })}</button> : null}
      {detail?.imageDataUrl ? <ImageArtifactPreview key={detail.imageDataUrl} src={detail.imageDataUrl} title={detail.title} path={artifact.fetchPath} /> : null}
      {detail?.dataView ? <DataViewCard artifact={{ ...artifact, dataView: detail.dataView }} expanded /> : null}
      {office ? (
        <OfficeArtifactPreview
          onAskForContentChange={onReference && !error && localThreadId && file.revision && artifact.fetchPath ? (request) => {
            const position = request.start === request.end ? String(request.start) : `${request.start}–${request.end}`;
            onReference?.(officeContentReference({ request, path: artifact.fetchPath!, title: artifact.title, threadId: localThreadId, revision: file.revision!,
              label: t(request.kind === "document" ? "details.officeParagraphSelection" : "details.officeSlideSelection", { position }),
            }));
          } : undefined}
          onAskForChange={error || !onAskForSpreadsheetChange ? undefined : (selection) => onAskForSpreadsheetChange(artifact, selection, file.revision)}
          source={office}
        />
      ) : null}
      {delimited ? <DelimitedTextPreview actions={referenceAction} delimiter={delimiter} key={artifact.id} text={detail.textContent!} title={artifact.title} truncated={Boolean(notice)} /> : markdownContent ? (
        <article aria-label={markdownContent.title} className="react-artifact-detail__document" role="document">
          <AssistantMarkdown
            onOpenFileLink={(link) => onOpenFileLink({ ...link, sourcePath: localThreadId ? artifact.fetchPath : undefined })}
            streaming={false}
            text={markdownContent.text}
          />
        </article>
      ) : detail?.textContent ? codeLanguage
        ? <CodeArtifactPreview text={detail.textContent} language={codeLanguage} />
        : <pre className="react-artifact-detail__text">{detail.textContent}</pre> : null}
      {!markdown && !office ? <details className="react-artifact-detail__metadata">
        <summary>{t("details.fileDetails")}</summary>
        <dl>
          <div><dt>{t("details.id")}</dt><dd>{artifact.id}</dd></div>
          {detail?.mimeType || artifact.mimeType ? <div><dt>{t("details.type")}</dt><dd>{detail?.mimeType || artifact.mimeType}</dd></div> : null}
          {localThreadId ? <div><dt>{t("details.status")}</dt><dd>{t("details.fileAutoUpdates")}</dd></div> : null}
        </dl>
      </details> : null}
      {!loading && !error && !office && !delimited && !detail?.dataView && !detail?.imageDataUrl && !detail?.textContent ? <p>{t("details.noPreview")}</p> : null}
    </div>
  );
}

function isMarkdownArtifact(artifact: ArtifactRef, detail?: LoadedArtifactDetail): boolean {
  const mimeType = (detail?.mimeType || artifact.mimeType || "").split(";", 1)[0].trim().toLowerCase();
  return artifact.kind.toLowerCase() === "markdown" || mimeType === "text/markdown";
}
