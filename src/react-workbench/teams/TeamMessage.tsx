import { useState } from "react";
import { useTranslation } from "react-i18next";
import { readTeamArtifact, type TeamArtifactPage, type TeamAttempt } from "../../app-core/native/desktopNativeTeams";
import { AssistantMarkdown } from "../chat/AssistantMarkdown";

export function TeamMessage({ runId, attempt, onOpenThread }: {
  runId: string; attempt: TeamAttempt; onOpenThread(id: string): void;
}) {
  const { t } = useTranslation("common");
  const [page, setPage] = useState<{ index: number; data: TeamArtifactPage } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function read(index: number, offset = 0) {
    setBusy(true); setError(null); setPage(null);
    try { setPage({ index, data: await readTeamArtifact(runId, attempt.threadId, index, offset) }); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  const message = attempt.message;
  return <div className="team-message">
    <AssistantMarkdown text={message?.summary ?? attempt.output ?? ""} streaming={false}
      onOpenFileLink={() => onOpenThread(attempt.threadId)} />
    {message?.unresolved && <p><strong>{t("teams.unresolved")}: </strong>{message.unresolved}</p>}
    {!!message?.artifacts.length && <ul className="team-artifacts">
      {message.artifacts.map((artifact, index) => <li key={artifact.path}>
        <button disabled={busy} onClick={() => void read(index)}>{artifact.path}</button>
        <small>{artifact.bytes.toLocaleString()} B</small>
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
  </div>;
}
