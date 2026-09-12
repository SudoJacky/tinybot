import { useEffect, useState } from "react";
import type { ArtifactRef, LoadedArtifactDetail } from "../../app-core/chat/chatTurnContracts";
import { resolveOfficeArtifactKind, type OfficeArtifactSource } from "../../app-core/chat/officeArtifact";
import { resolveImageArtifactMimeType } from "../../app-core/chat/imageArtifact";
import { logRendererEvent } from "../../app-core/native/rendererLogger";
import type { WorkspaceStore } from "../services";

export const ARTIFACT_REFRESH_INTERVAL_MS = 3000;
export type ArtifactFileState = {
  detail?: LoadedArtifactDetail;
  office?: OfficeArtifactSource;
  revision?: string;
  loading: boolean;
  error?: string;
  truncated?: boolean;
};

// Only the visible local file is observed. Each effect owns its request lifetime;
// closing or switching files prevents late reads from publishing into the next view.
export function useArtifactFile({ artifact, enabled, threadId, workspaceStore, unavailableMessage, binaryMessage, refreshKey }: {
  refreshKey?: number;
  artifact: ArtifactRef;
  enabled: boolean;
  threadId?: string;
  workspaceStore?: Pick<WorkspaceStore, "readThreadFile" | "readThreadFileBytes">;
  unavailableMessage: string;
  binaryMessage: string;
}): ArtifactFileState {
  const [state, setState] = useState<ArtifactFileState>({ loading: true });
  const { fetchPath: path, id, mimeType, title } = artifact;
  const readFile = workspaceStore?.readThreadFile;
  const readBytes = workspaceStore?.readThreadFileBytes;
  useEffect(() => {
    if (!enabled || !threadId || !path) return;
    let disposed = false;
    let inFlight = false;
    let revision: string | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let lastError: string | undefined;
    let imageUrl: string | undefined;
    setState({ loading: true });
    async function refresh() {
      if (disposed || inFlight || document.visibilityState === "hidden") return;
      clearTimeout(timer);
      inFlight = true;
      try {
        if (!readFile) throw new Error(unavailableMessage);
        const file = await readFile({ path: path!, threadId: threadId!, ...(revision ? { knownRevision: revision } : {}) });
        if (disposed) return;
        if (file.contentType === "unchanged" || (revision && file.revision === revision)) {
          if (!revision || file.revision !== revision) throw new Error("Unchanged file response does not match the displayed revision");
          if (lastError) setState((current) => ({ ...current, error: undefined }));
          lastError = undefined;
          return;
        }
        const officeKind = resolveOfficeArtifactKind({ mimeType, path, title });
        const imageMimeType = resolveImageArtifactMimeType({ mimeType, path, title });
        let next: ArtifactFileState;
        if ((officeKind || imageMimeType) && file.contentType === "binary") {
          if (!readBytes) throw new Error(unavailableMessage);
          const bytes = await readBytes({ path: path!, threadId: threadId!, expectedRevision: file.revision });
          if (disposed) return;
          if (imageMimeType) {
            const url = URL.createObjectURL(new Blob([bytes], { type: imageMimeType }));
            if (imageUrl) URL.revokeObjectURL(imageUrl);
            imageUrl = url;
            next = { loading: false, detail: { id, title, mimeType: imageMimeType, imageDataUrl: url }, revision: file.revision };
          } else {
            next = { loading: false, office: { bytes, kind: officeKind!, title }, revision: file.revision };
          }
        } else {
          if (file.contentType !== "text") throw new Error(binaryMessage);
          next = { loading: false, detail: { id, title, mimeType, textContent: file.content ?? "" }, revision: file.revision, truncated: Boolean(file.nextCursor) };
        }
        if (disposed) return;
        logRendererEvent("info", "artifact.workspace_file.loaded", { path, threadId, revision: file.revision, refreshed: Boolean(revision) });
        revision = file.revision;
        lastError = undefined;
        setState(next);
      } catch (cause) {
        if (disposed) return;
        const error = cause instanceof Error ? cause.message : String(cause);
        if (error !== lastError) {
          logRendererEvent("error", "artifact.workspace_file.read.failed", { path, threadId, error: error.slice(0, 512) });
          console.error("[artifact-preview] workspace file read failed", { error: cause, path, sessionId: threadId });
        }
        lastError = error;
        setState((current) => ({ ...current, loading: false, error }));
      } finally {
        inFlight = false;
        if (!disposed) timer = setTimeout(() => void refresh(), ARTIFACT_REFRESH_INTERVAL_MS);
      }
    }
    const wake = () => { void refresh(); };
    wake();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [refreshKey, enabled, threadId, path, id, mimeType, title, readFile, readBytes, unavailableMessage, binaryMessage]);
  return state;
}
