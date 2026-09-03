import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  Loader2,
  MessagesSquare,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WorkspaceRegistryEntry } from "../services";
import { normalizedWorkspacePathKey, sessionWorkspaceName } from "./sessionWorkspaces";

export function EmptyChatStart({
  availableWorkspaces,
  onAddWorkspace,
  onSelectPrompt,
  onSelectWorkspace,
  selectedWorkspacePath,
  workspaceError,
  workspacePickerPending,
  workspaceSelectionEnabled,
}: {
  availableWorkspaces: readonly WorkspaceRegistryEntry[];
  onAddWorkspace: () => Promise<string | undefined>;
  onSelectPrompt: (prompt: string) => void;
  onSelectWorkspace: (workingDirectory?: string) => void;
  selectedWorkspacePath?: string;
  workspaceError: string;
  workspacePickerPending: boolean;
  workspaceSelectionEnabled: boolean;
}) {
  const { t } = useTranslation("chat");
  const prompts = t("prompts", { returnObjects: true }) as readonly string[];
  const selectedWorkspace = useMemo(() => {
    const selectedKey = normalizedWorkspacePathKey(selectedWorkspacePath ?? "");
    return selectedKey
      ? availableWorkspaces.find((workspace) => normalizedWorkspacePathKey(workspace.path) === selectedKey)
      : undefined;
  }, [availableWorkspaces, selectedWorkspacePath]);
  const selectedWorkspaceLabel = selectedWorkspace?.name
    ?? (selectedWorkspacePath ? sessionWorkspaceName(selectedWorkspacePath) : t("shell.generalSessions"));

  return (
    <section aria-label={t("search.start")} className="react-empty-chat-start" data-empty-session="true">
      {workspaceSelectionEnabled ? (
        <h2
          aria-label={t("empty.titleWithWorkspace", { workspace: selectedWorkspaceLabel })}
          className="react-empty-chat-start__workspace-title"
        >
          <span>{t("empty.titlePrefix")}</span>
          <EmptyChatWorkspacePicker
            availableWorkspaces={availableWorkspaces}
            selectedWorkspaceLabel={selectedWorkspaceLabel}
            selectedWorkspacePath={selectedWorkspacePath}
            workspacePickerPending={workspacePickerPending}
            onAddWorkspace={onAddWorkspace}
            onSelectWorkspace={onSelectWorkspace}
          />
          <span>{t("empty.titleSuffix")}</span>
        </h2>
      ) : <h2>{t("empty.title")}</h2>}
      <p>{t("empty.description")}</p>
      {workspaceSelectionEnabled && workspaceError ? (
        <p className="react-empty-chat-start__workspace-error" role="alert">{workspaceError}</p>
      ) : null}
      <div className="react-empty-chat-prompts" aria-label={t("empty.suggestions")}>
        {prompts.map((prompt) => (
          <button key={prompt} type="button" onClick={() => onSelectPrompt(prompt)}>{prompt}</button>
        ))}
      </div>
    </section>
  );
}

function EmptyChatWorkspacePicker({
  availableWorkspaces,
  onAddWorkspace,
  onSelectWorkspace,
  selectedWorkspaceLabel,
  selectedWorkspacePath,
  workspacePickerPending,
}: {
  availableWorkspaces: readonly WorkspaceRegistryEntry[];
  onAddWorkspace: () => Promise<string | undefined>;
  onSelectWorkspace: (workingDirectory?: string) => void;
  selectedWorkspaceLabel: string;
  selectedWorkspacePath?: string;
  workspacePickerPending: boolean;
}) {
  const { t } = useTranslation("chat");
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedKey = normalizedWorkspacePathKey(selectedWorkspacePath ?? "");
  const options = [
    { exists: true, name: t("shell.generalSessions"), path: "" },
    ...availableWorkspaces,
  ];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    optionRefs.current.length = options.length + 1;
    if (!open) return;
    const focusTimer = window.setTimeout(() => {
      const selectedOption = optionRefs.current.find((option) => (
        option?.getAttribute("aria-checked") === "true" && !option.disabled
      ));
      (selectedOption ?? optionRefs.current.find((option) => option && !option.disabled))?.focus();
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [open, options.length]);

  function closeAndRestoreFocus(): void {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function selectWorkspace(workingDirectory?: string): void {
    onSelectWorkspace(workingDirectory);
    closeAndRestoreFocus();
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLSpanElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const enabledOptions = optionRefs.current.filter((option): option is HTMLButtonElement => Boolean(option && !option.disabled));
    if (!enabledOptions.length) return;
    event.preventDefault();
    const currentIndex = enabledOptions.findIndex((option) => option === document.activeElement);
    if (event.key === "Home") {
      enabledOptions[0]?.focus();
    } else if (event.key === "End") {
      enabledOptions[enabledOptions.length - 1]?.focus();
    } else {
      const direction = event.key === "ArrowDown" ? 1 : -1;
      enabledOptions[(currentIndex + direction + enabledOptions.length) % enabledOptions.length]?.focus();
    }
  }

  async function addWorkspace(): Promise<void> {
    setOpen(false);
    try {
      const workingDirectory = await onAddWorkspace();
      if (workingDirectory) onSelectWorkspace(workingDirectory);
    } catch (error) {
      console.error("[empty-chat] workspace.pick.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      triggerRef.current?.focus();
    }
  }

  return (
    <span
      className="react-empty-chat-workspace"
      ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("empty.workspacePicker", { workspace: selectedWorkspaceLabel })}
        className="react-empty-chat-workspace__trigger"
        disabled={workspacePickerPending}
        ref={triggerRef}
        title={selectedWorkspacePath || selectedWorkspaceLabel}
        type="button"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        {selectedWorkspacePath ? <Folder aria-hidden="true" size={19} /> : <MessagesSquare aria-hidden="true" size={19} />}
        <span>{selectedWorkspaceLabel}</span>
        <ChevronDown aria-hidden="true" size={16} />
      </button>
      {open ? (
        <span
          aria-label={t("empty.workspaceMenu")}
          className="react-popover-surface react-empty-chat-workspace__menu"
          id={menuId}
          role="menu"
          onKeyDown={handleMenuKeyDown}
        >
          {options.map((workspace, index) => {
            const workspaceKey = normalizedWorkspacePathKey(workspace.path);
            const selected = workspaceKey === selectedKey;
            return (
              <button
                aria-checked={selected}
                className="react-popover-item react-empty-chat-workspace__option"
                disabled={!workspace.exists}
                key={workspace.path || "general"}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                role="menuitemradio"
                title={workspace.path || workspace.name}
                type="button"
                onClick={() => selectWorkspace(workspace.path || undefined)}
              >
                {workspace.path ? <Folder aria-hidden="true" size={18} /> : <MessagesSquare aria-hidden="true" size={18} />}
                <span>{workspace.name}</span>
                {selected ? <Check aria-hidden="true" size={17} /> : <span aria-hidden="true" />}
              </button>
            );
          })}
          <button
            className="react-popover-item react-empty-chat-workspace__add"
            disabled={workspacePickerPending}
            ref={(node) => {
              optionRefs.current[options.length] = node;
            }}
            role="menuitem"
            type="button"
            onClick={() => void addWorkspace()}
          >
            {workspacePickerPending ? <Loader2 aria-hidden="true" className="react-spin" size={18} /> : <FolderPlus aria-hidden="true" size={18} />}
            <span>{t("shell.addWorkspace")}</span>
            <span aria-hidden="true" />
          </button>
        </span>
      ) : null}
    </span>
  );
}
