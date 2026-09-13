import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AssistantMarkdown } from "../chat/AssistantMarkdown";
import { resolveAssistantFileLink, type AssistantFileLink } from "../chat/assistantFileLinks";
import type { AutomationRun } from "../../app-core/native/desktopNativeAutomations";
import type { AppServices, WorkspaceFileChunk } from "../services";

export function AutomationReport({ run, services }: { run: AutomationRun; services: AppServices }) {
  const { t } = useTranslation("common");
  const [output, setOutput] = useState<string | null>(null);
  const [file, setFile] = useState<WorkspaceFileChunk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load(work: () => Promise<void>) {
    setError(null); setBusy(true);
    try { await work(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  function openFile(link: AssistantFileLink) {
    void load(async () => {
      if (!run.threadId) throw new Error("Run has no owning Thread");
      const target = resolveAssistantFileLink(link.href, run.definition.workspacePath, link.sourcePath);
      const value = await services.workspaceStore.readThreadFile({ path: target.path, threadId: run.threadId });
      setFile(value);
    });
  }
  return <section className="automation-report">
    <button type="button" disabled={busy} onClick={() => { void load(async () => { setOutput(await services.automationStore.output(run.id)); }); }}>{t("automations.viewReport")}</button>
    {error && <p role="alert" className="automation-error">{error}</p>}
    {output !== null && <AssistantMarkdown text={output} streaming={false} onOpenFileLink={openFile} />}
    {file && <section aria-label={file.path} className="automation-card">
      <div className="automation-heading"><h3 className="automation-path">{file.path}</h3><button type="button" onClick={() => setFile(null)}>{t("automations.closePreview")}</button></div>
      {file.contentType === "text" ? <>
        <pre>{file.content}</pre>
        {file.nextCursor && <button type="button" disabled={busy} onClick={() => { void load(async () => {
          const next = await services.workspaceStore.readThreadFile({ path: file.path, threadId: run.threadId!, cursor: file.nextCursor });
          if (next.revision !== file.revision) throw new Error(t("automations.fileChanged"));
          setFile({ ...next, content: (file.content ?? "") + (next.content ?? "") });
        }); }}>{t("automations.loadMore")}</button>}
      </> : <p>{t("automations.openInChat")}</p>}
    </section>}
  </section>;
}
