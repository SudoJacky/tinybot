import { useState } from "react";
import { FolderPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { pickDesktopWorkspaceDirectory } from "../../app-core/native/desktopNativeWorkspacePicker";
import type { WorkspaceRegistryEntry, WorkspaceRegistryStore } from "../services";

export function AddWorkspaceButton({ store, onAdded, disabled }: {
  store: WorkspaceRegistryStore;
  onAdded(workspace: WorkspaceRegistryEntry): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("chat");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function add() {
    setPending(true); setError("");
    try {
      const path = await pickDesktopWorkspaceDirectory();
      if (path) onAdded(await store.register(path));
    } catch (cause) {
      console.error("[workspace] add failed", cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }
  return <div>
    <button type="button" disabled={disabled || pending} onClick={() => void add()}><FolderPlus size={16} aria-hidden="true" />{t("shell.addWorkspace")}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
