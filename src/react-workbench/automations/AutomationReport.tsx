import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AssistantMarkdown } from "../chat/AssistantMarkdown";
import type { AutomationRun } from "../../app-core/native/desktopNativeAutomations";
import type { AppServices } from "../services";
import { ResultFilePreview, useResultFilePreview } from "../sidecar/ResultFilePreview";

export function AutomationReport({ run, services }: { run: AutomationRun; services: AppServices }) {
  const { t } = useTranslation("common");
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useResultFilePreview(run.definition.workspacePath);
  async function load() {
    setError(null); setBusy(true);
    try { setOutput(await services.automationStore.output(run.id)); }
    catch (cause) { console.error("[automation-report] load failed", cause); setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="automation-report">
    <button type="button" disabled={busy} onClick={() => void load()}>{t("automations.viewReport")}</button>
    {error && <p role="alert" className="automation-error">{error}</p>}
    {output !== null && <AssistantMarkdown text={output} streaming={false} onOpenFileLink={preview.open} />}
    {run.threadId && <ResultFilePreview preview={preview} threadId={run.threadId} workspaceStore={services.workspaceStore} />}
  </section>;
}
