import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceStore } from "../services";
import type { ArtifactRef } from "../../app-core/chat/chatTurnContracts";
import { assistantFileArtifact, resolveAssistantFileLink, type AssistantFileLink } from "../chat/assistantFileLinks";
import { ArtifactDetails } from "./ArtifactDetails";
import "./Sidecar.css";

export type PreviewWorkspaceStore = Pick<WorkspaceStore, "readThreadFile" | "readThreadFileBytes">;

export function useResultFilePreview(workspacePath: string) {
  const [artifact, setArtifact] = useState<ArtifactRef | null>(null);
  const [error, setError] = useState("");
  function open(link: AssistantFileLink) {
    setError("");
    try { setArtifact(assistantFileArtifact(resolveAssistantFileLink(link.href, workspacePath, link.sourcePath))); }
    catch (cause) {
      console.error("[result-preview] resolve failed", cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return { artifact, error, open, close: () => { setArtifact(null); setError(""); } };
}

export function ResultFilePreview({ preview, threadId, workspaceStore }: {
  preview: ReturnType<typeof useResultFilePreview>;
  threadId: string;
  workspaceStore: PreviewWorkspaceStore;
}) {
  const { t } = useTranslation("common");
  return <>
    {preview.error && <p role="alert">{preview.error}</p>}
    {preview.artifact && <section className="result-file-preview" aria-label={preview.artifact.title}>
      <header><strong>{preview.artifact.title}</strong><button type="button" onClick={preview.close}>{t("automations.closePreview")}</button></header>
      <ArtifactDetails key={threadId + ":" + preview.artifact.id} artifact={preview.artifact}
        loading={false} localThreadId={threadId} workspaceStore={{ readThreadFile: workspaceStore.readThreadFile, readThreadFileBytes: workspaceStore.readThreadFileBytes }}
        reviewEpoch={0} responding={false} observeFile onOpenFileLink={preview.open} />
    </section>}
  </>;
}
