import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { readTeamArtifact, type TeamArtifactPage, type TeamAttempt } from "../../app-core/native/desktopNativeTeams";
import { AssistantMarkdown } from "../chat/AssistantMarkdown";
import { ResultFilePreview, useResultFilePreview, type PreviewWorkspaceStore } from "../sidecar/ResultFilePreview";

export function TeamMessage({ runId, attempt, workspacePath, workspaceStore }: {
  runId: string; attempt: TeamAttempt; workspacePath: string; workspaceStore: PreviewWorkspaceStore;
}) {
  const { t } = useTranslation("common");
  const preview = useResultFilePreview(workspacePath);
  const message = attempt.message;
  return <div className="team-message">
    <AssistantMarkdown text={message?.summary ?? attempt.output ?? ""} streaming={false} onOpenFileLink={preview.open} />
    {message?.unresolved && <p><strong>{t("teams.unresolved")}: </strong>{message.unresolved}</p>}
    <TeamArtifacts key={attempt.threadId} runId={runId} attempt={attempt} workspacePath={workspacePath} workspaceStore={workspaceStore} sharedPreview={preview} />
  </div>;
}

export function TeamArtifacts({ runId, attempt, workspacePath, workspaceStore, sharedPreview }: {
  runId: string; attempt: TeamAttempt; workspacePath: string; workspaceStore: PreviewWorkspaceStore;
  sharedPreview?: ReturnType<typeof useResultFilePreview>;
}) {
  const { t } = useTranslation("common");
  const [page, setPage] = useState<{ index: number; data: TeamArtifactPage } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const localPreview = useResultFilePreview(workspacePath);
  const preview = sharedPreview ?? localPreview;
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  async function read(index: number, offset = 0) {
    const id = ++request.current;
    setBusy(true); setError(null); setPage(null); preview.close();
    try {
      const data = await readTeamArtifact(runId, attempt.threadId, index, offset);
      if (request.current === id) setPage({ index, data });
    }
    catch (cause) { if (request.current === id) setError(String(cause)); }
    finally { if (request.current === id) setBusy(false); }
  }
  const message = attempt.message;
  return <div className="team-message">
    {!!message?.artifacts.length && <ul className="team-artifacts">
      {message.artifacts.map((artifact, index) => <li key={artifact.path}>
        <button disabled={busy} onClick={() => void read(index)}>{artifact.path}</button>
        <small>{artifact.bytes.toLocaleString()} B</small>
        <button onClick={() => { request.current += 1; setBusy(false); setPage(null); setError(null); preview.open({ href: artifact.path }); }}>{t("resultPreview.currentFile")}</button>
      </li>)}
    </ul>}
    {busy && <p role="status">{t("teams.loading")}</p>}
    {error && <p className="team-error" role="alert">{error}</p>}
    {page && <section className="team-artifact-preview" aria-label={page.data.path}>
      <p>{page.data.path} · {page.data.byteOffset}–{page.data.byteOffset + new TextEncoder().encode(page.data.text).length} / {page.data.totalBytes} B</p>
      <pre>{page.data.text}</pre>
      {page.data.nextByteOffset !== null && <button disabled={busy} onClick={() => void read(page.index, page.data.nextByteOffset!)}>{t("teams.readMore")}</button>}
      <button onClick={() => setPage(null)}>{t("teams.closePreview")}</button>
    </section>}
    <ResultFilePreview preview={preview} threadId={attempt.threadId} workspaceStore={workspaceStore} />
  </div>;
}
