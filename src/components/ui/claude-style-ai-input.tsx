"use client";

import type { ClipboardEvent, FormEvent, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { TFunction } from "i18next";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../../app-core/chat/reasoningEffort";
import type { TokenUsage } from "../../app-core/chat/chatTurnModel";
import {
  AlertCircle,
  Archive,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Command,
  Copy,
  FileText,
  ImageIcon,
  MessageCircle,
  Music,
  Plus,
  SlidersHorizontal,
  Square,
  TerminalSquare,
  Video,
  X,
} from "lucide-react";

export interface ComposerFileReference {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
}

export type ComposerFileSelection = Omit<ComposerFileReference, "id">;

export interface PastedContent {
  id: string;
  content: string;
  timestamp: Date;
  wordCount: number;
}

export interface ModelOption {
  id: string;
  modelId?: string;
  providerId?: string;
  name: string;
  description: string;
  badge?: string;
}

export interface ComposerToolOption {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  disabled?: boolean;
}

export interface ComposerSlashCommand {
  command: `/${string}`;
  description: string;
  label: string;
  prompt: string;
  submitOnSelect?: boolean;
}

export interface ComposerSendOptions {
  model?: string;
  provider?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ComposerContextReference {
  detail: string;
  id: string;
  kind: "file" | "terminal" | "reference";
  label: string;
}

export interface ComposerSessionMentionOption {
  detail: string;
  id: string;
  label: string;
}

export interface ClaudeStyleAiInputProps {
  className?: string;
  contextReferences?: ComposerContextReference[];
  onSendMessage?: (
    message: string,
    files: ComposerFileReference[],
    pastedContent: PastedContent[],
    options: ComposerSendOptions,
  ) => void | Promise<void>;
  onInterruptMessage?: (
    message: string,
    files: ComposerFileReference[],
    pastedContent: PastedContent[],
    options: ComposerSendOptions,
  ) => void | Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
  placeholder?: string;
  maxFiles?: number;
  onSelectFiles?: () => Promise<ComposerFileSelection[]>;
  models?: ModelOption[];
  defaultModel?: string;
  defaultReasoningEffort?: ReasoningEffort;
  onModelChange?: (modelId: string) => void;
  onReasoningEffortChange?: (effort: ReasoningEffort) => void;
  onClearContextReferences?: () => void;
  onRemoveContextReference?: (id: string) => void;
  onAddSessionMention?: (id: string) => void;
  onClearSessionMentions?: () => void;
  onRemoveSessionMention?: (id: string) => void;
  contextUsage?: TokenUsage;
  selectedSessionMentionIds?: readonly string[];
  sessionMentionOptions?: readonly ComposerSessionMentionOption[];
  tools?: ComposerToolOption[];
  responding?: boolean;
  canStopResponding?: boolean;
  stopUnavailableReason?: string;
  onStopResponding?: () => void | Promise<void>;
  slashCommands?: readonly ComposerSlashCommand[];
  value?: string;
  onValueChange?: (value: string) => void;
}

const MAX_FILES = 10;
const PASTE_THRESHOLD = 200;
const EMPTY_MODELS: ModelOption[] = [];
const EMPTY_TOOLS: ComposerToolOption[] = [];
const EMPTY_SLASH_COMMANDS: readonly ComposerSlashCommand[] = [];
const EMPTY_SESSION_MENTIONS: readonly ComposerSessionMentionOption[] = [];
const MAX_SESSION_MENTIONS = 4;
type ReasoningEffortOption = {
  description: string;
  label: string;
  value: ReasoningEffort;
};

type ModelMenuView = "advanced" | "effort" | "models";

let generatedId = 0;

function nextInputId(prefix: string): string {
  generatedId += 1;
  return `${prefix}-${generatedId}`;
}

export function ClaudeStyleAiInput({
  canStopResponding = true,
  className,
  contextReferences = [],
  contextUsage,
  defaultModel,
  defaultReasoningEffort,
  disabled = false,
  disabledReason,
  maxFiles = MAX_FILES,
  models = EMPTY_MODELS,
  onModelChange,
  onReasoningEffortChange,
  onAddSessionMention,
  onClearContextReferences,
  onClearSessionMentions,
  onInterruptMessage,
  onRemoveContextReference,
  onRemoveSessionMention,
  onSelectFiles,
  onSendMessage,
  onStopResponding,
  onValueChange,
  placeholder,
  responding = false,
  selectedSessionMentionIds = [],
  sessionMentionOptions = EMPTY_SESSION_MENTIONS,
  slashCommands = EMPTY_SLASH_COMMANDS,
  stopUnavailableReason,
  tools = EMPTY_TOOLS,
  value,
}: ClaudeStyleAiInputProps) {
  const { t } = useTranslation("chat");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const toolMenuRef = useRef<HTMLDivElement | null>(null);
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<ComposerFileReference[]>([]);
  const [pastedContent, setPastedContent] = useState<PastedContent[]>([]);
  const [selectedModelId, setSelectedModelId] = useState(defaultModel ?? models[0]?.id ?? "");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<ReasoningEffort>(
    defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT,
  );
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuView, setModelMenuView] = useState<ModelMenuView>("advanced");
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [enabledToolIds, setEnabledToolIds] = useState<string[]>(() => tools.filter((tool) => tool.enabled).map((tool) => tool.id));
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [selectingFiles, setSelectingFiles] = useState(false);
  const [activeSlashCommandIndex, setActiveSlashCommandIndex] = useState(0);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [activeSessionMentionIndex, setActiveSessionMentionIndex] = useState(0);
  const [sessionMentionMenuDismissed, setSessionMentionMenuDismissed] = useState(false);
  const slashListboxId = useId();
  const sessionMentionListboxId = useId();
  const currentMessage = value ?? message;
  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId)
      ?? models.find((model) => model.id === defaultModel)
      ?? models[0],
    [defaultModel, models, selectedModelId],
  );
  const effortOptions = useMemo(() => reasoningEffortOptions(t), [t]);
  const selectedReasoningEffortLabel = reasoningEffortLabel(selectedReasoningEffort, effortOptions);
  const contextUsageView = useMemo(() => buildContextUsageView(contextUsage, t), [contextUsage, t]);
  const resolvedPlaceholder = placeholder ?? t("composer.placeholder");
  const enabledToolIdSet = useMemo(() => new Set(enabledToolIds), [enabledToolIds]);
  const selectedSessionMentionIdSet = useMemo(
    () => new Set(selectedSessionMentionIds),
    [selectedSessionMentionIds],
  );
  const selectedSessionMentions = useMemo(
    () => sessionMentionOptions.filter((option) => selectedSessionMentionIdSet.has(option.id)),
    [selectedSessionMentionIdSet, sessionMentionOptions],
  );
  const canSend = !disabled && !sending && Boolean(
    currentMessage.trim()
      || files.length
      || pastedContent.length
      || contextReferences.length
      || selectedSessionMentions.length,
  );
  const slashQuery = useMemo(() => {
    const match = /^\/([^\s]*)$/.exec(currentMessage);
    return match?.[1].toLocaleLowerCase();
  }, [currentMessage]);
  const filteredSlashCommands = useMemo(() => {
    if (slashQuery === undefined) return [];
    return slashCommands.filter((command) => {
      const name = command.command.slice(1).toLocaleLowerCase();
      const searchText = `${name} ${command.label} ${command.description}`.toLocaleLowerCase();
      return name.startsWith(slashQuery) || searchText.includes(slashQuery);
    });
  }, [slashCommands, slashQuery]);
  const slashMenuOpen = !disabled
    && !sending
    && !slashMenuDismissed
    && slashQuery !== undefined
    && filteredSlashCommands.length > 0;
  const activeSlashOptionIndex = Math.min(activeSlashCommandIndex, Math.max(0, filteredSlashCommands.length - 1));
  const mentionMatch = useMemo(() => sessionMentionMatch(currentMessage), [currentMessage]);
  const filteredSessionMentions = useMemo(() => {
    if (!mentionMatch || selectedSessionMentions.length >= MAX_SESSION_MENTIONS) return [];
    const query = mentionMatch.query.toLocaleLowerCase();
    return sessionMentionOptions
      .filter((option) => !selectedSessionMentionIdSet.has(option.id))
      .filter((option) => `${option.label} ${option.detail}`.toLocaleLowerCase().includes(query))
      .slice(0, 8);
  }, [mentionMatch, selectedSessionMentionIdSet, selectedSessionMentions.length, sessionMentionOptions]);
  const sessionMentionMenuOpen = !disabled
    && !sending
    && !sessionMentionMenuDismissed
    && Boolean(mentionMatch)
    && filteredSessionMentions.length > 0;
  const activeSessionMentionOptionIndex = Math.min(
    activeSessionMentionIndex,
    Math.max(0, filteredSessionMentions.length - 1),
  );

  function updateMessage(nextMessage: string): void {
    setMessage(nextMessage);
    onValueChange?.(nextMessage);
  }

  useEffect(() => {
    const nextModelId = defaultModel || models[0]?.id || "";
    setSelectedModelId(nextModelId);
  }, [defaultModel, models]);

  useEffect(() => {
    setSelectedReasoningEffort(defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT);
  }, [defaultReasoningEffort]);

  useEffect(() => {
    setEnabledToolIds(tools.filter((tool) => tool.enabled).map((tool) => tool.id));
  }, [tools]);

  useEffect(() => {
    setActiveSlashCommandIndex(0);
    setSlashMenuDismissed(false);
    setActiveSessionMentionIndex(0);
    setSessionMentionMenuDismissed(false);
  }, [currentMessage]);

  useEffect(() => {
    if (!slashMenuOpen && !sessionMentionMenuOpen) return;
    setModelMenuOpen(false);
    setModelMenuView("advanced");
    setToolMenuOpen(false);
  }, [sessionMentionMenuOpen, slashMenuOpen]);

  useEffect(() => {
    if (!modelMenuOpen && !toolMenuOpen && !slashMenuOpen && !sessionMentionMenuOpen) {
      return;
    }
    function closeMenus(event: PointerEvent) {
      const target = event.target as Node;
      if (!modelMenuRef.current?.contains(target)) {
        setModelMenuOpen(false);
        setModelMenuView("advanced");
      }
      if (!toolMenuRef.current?.contains(target)) {
        setToolMenuOpen(false);
      }
      if (slashMenuOpen && !panelRef.current?.contains(target)) {
        setSlashMenuDismissed(true);
      }
      if (sessionMentionMenuOpen && !panelRef.current?.contains(target)) {
        setSessionMentionMenuDismissed(true);
      }
    }
    document.addEventListener("pointerdown", closeMenus, true);
    return () => document.removeEventListener("pointerdown", closeMenus, true);
  }, [modelMenuOpen, sessionMentionMenuOpen, slashMenuOpen, toolMenuOpen]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setModelMenuOpen(false);
      setModelMenuView("advanced");
      modelTriggerRef.current?.focus();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [modelMenuOpen]);

  async function sendMessage(mode: "interrupt" | "queue") {
    if (!canSend) {
      return;
    }
    setSending(true);
    setError("");
    try {
      const handler = mode === "interrupt" ? onInterruptMessage : onSendMessage;
      await handler?.(currentMessage.trim(), files, pastedContent, {
        ...(selectedModel ? { model: selectedModel.modelId || selectedModel.id } : {}),
        ...(selectedModel?.providerId ? { provider: selectedModel.providerId } : {}),
        reasoningEffort: selectedReasoningEffort,
      });
      updateMessage("");
      setFiles([]);
      setPastedContent([]);
      onClearContextReferences?.();
      onClearSessionMentions?.();
    } catch (error) {
      setError(error instanceof Error ? error.message : t("composer.sendFailed"));
    } finally {
      setSending(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendMessage("queue");
  }

  async function handleStopResponding() {
    setError("");
    try {
      await onStopResponding?.();
    } catch {
      setError(t("composer.stopFailed"));
    }
  }

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (sessionMentionMenuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveSessionMentionIndex((current) => (
          (current + direction + filteredSessionMentions.length) % filteredSessionMentions.length
        ));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        selectSessionMention(filteredSessionMentions[activeSessionMentionOptionIndex] ?? filteredSessionMentions[0]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSessionMentionMenuDismissed(true);
        return;
      }
    }
    if (slashMenuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveSlashCommandIndex((current) => (
          (current + direction + filteredSlashCommands.length) % filteredSlashCommands.length
        ));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        selectSlashCommand(filteredSlashCommands[activeSlashOptionIndex] ?? filteredSlashCommands[0]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashMenuDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function selectSlashCommand(command: ComposerSlashCommand | undefined) {
    if (!command) return;
    setSlashMenuDismissed(true);
    updateMessage(command.prompt);
    if (command.submitOnSelect) {
      window.requestAnimationFrame(() => textareaRef.current?.form?.requestSubmit());
      return;
    }
    textareaRef.current?.focus();
  }

  function selectSessionMention(option: ComposerSessionMentionOption | undefined) {
    const match = sessionMentionMatch(currentMessage);
    if (!option || !match) return;
    setSessionMentionMenuDismissed(true);
    updateMessage(currentMessage.slice(0, match.start));
    onAddSessionMention?.(option.id);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const text = event.clipboardData.getData("text");
    if (text.length < PASTE_THRESHOLD) {
      return;
    }
    event.preventDefault();
    setPastedContent((current) => [
      ...current,
      {
        id: nextInputId("paste"),
        content: text,
        timestamp: new Date(),
        wordCount: countWords(text),
      },
    ]);
  }

  async function handleSelectFiles() {
    setError("");
    setSelectingFiles(true);
    try {
      const selectedFiles = await onSelectFiles?.() ?? [];
      if (!selectedFiles.length) {
        return;
      }
      setFiles((current) => {
        const remainingSlots = Math.max(0, maxFiles - current.length);
        if (selectedFiles.length > remainingSlots) {
          setError(t("composer.fileLimit", { count: maxFiles }));
        }
        return [
          ...current,
          ...selectedFiles.slice(0, remainingSlots).map((file) => ({
            ...file,
            id: nextInputId("file"),
          })),
        ];
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : t("composer.filesFailed"));
    } finally {
      setSelectingFiles(false);
    }
  }

  function removeFile(id: string) {
    setFiles((current) => current.filter((file) => file.id !== id));
  }

  function removePastedContent(id: string) {
    setPastedContent((current) => current.filter((item) => item.id !== id));
  }

  function selectModel(modelId: string) {
    setSelectedModelId(modelId);
    setModelMenuOpen(false);
    setModelMenuView("advanced");
    modelTriggerRef.current?.focus();
    onModelChange?.(modelId);
  }

  function selectReasoningEffort(effort: ReasoningEffort) {
    setSelectedReasoningEffort(effort);
    setModelMenuOpen(false);
    setModelMenuView("advanced");
    modelTriggerRef.current?.focus();
    onReasoningEffortChange?.(effort);
  }

  function toggleTool(tool: ComposerToolOption) {
    if (tool.disabled) {
      return;
    }
    setEnabledToolIds((current) => {
      if (current.includes(tool.id)) {
        return current.filter((id) => id !== tool.id);
      }
      return [...current, tool.id];
    });
  }

  function handlePanelPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    const rect = panel.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const edgeDistance = Math.min(x, y, rect.width - x, rect.height - y);
    const edgeSensitivity = Math.min(76, Math.max(36, Math.min(rect.width, rect.height) * 0.38));
    const edgeProximity = Math.max(0, Math.min(1, 1 - edgeDistance / edgeSensitivity));
    const opacity = Math.round(Math.pow(edgeProximity, 0.68) * 100) / 100;

    panel.style.setProperty("--claude-ai-panel-glow-x", `${x}px`);
    panel.style.setProperty("--claude-ai-panel-glow-y", `${y}px`);
    panel.style.setProperty("--claude-ai-panel-glow-opacity", `${opacity}`);
  }

  function handlePanelPointerLeave() {
    panelRef.current?.style.setProperty("--claude-ai-panel-glow-opacity", "0");
  }

  return (
    <form
      aria-label={t("composer.label")}
      className={["claude-ai-input", className].filter(Boolean).join(" ")}
      onSubmit={(event) => void handleSubmit(event)}
    >
      {error ? (
        <div className="claude-ai-input__notice" role="alert">
          <AlertCircle aria-hidden="true" size={15} />
          <span>{error}</span>
        </div>
      ) : null}
      {!error && disabled && disabledReason ? (
        <div className="claude-ai-input__notice" role="status">
          <AlertCircle aria-hidden="true" size={15} />
          <span>{disabledReason}</span>
        </div>
      ) : null}
      {files.length || pastedContent.length || contextReferences.length || selectedSessionMentions.length ? (
        <div className="claude-ai-input__attachments" aria-label={t("composer.attachments")}>
          {selectedSessionMentions.map((reference) => (
            <AttachmentChip
              detail={reference.detail}
              icon={<MessageCircle aria-hidden="true" size={16} />}
              key={reference.id}
              label={reference.label}
              onRemove={() => onRemoveSessionMention?.(reference.id)}
              removeLabel={t("composer.remove", { name: reference.label })}
            />
          ))}
          {contextReferences.map((reference) => (
            <AttachmentChip
              detail={reference.detail}
              icon={reference.kind === "terminal" ? <TerminalSquare aria-hidden="true" size={16} /> : <FileText aria-hidden="true" size={16} />}
              key={reference.id}
              label={reference.label}
              onRemove={() => onRemoveContextReference?.(reference.id)}
              removeLabel={t("composer.remove", { name: reference.label })}
            />
          ))}
          {pastedContent.map((item) => (
            <AttachmentChip
              detail={t("composer.words", { count: item.wordCount })}
              icon={<Copy aria-hidden="true" size={16} />}
              key={item.id}
              label={t("composer.pastedText")}
              onRemove={() => removePastedContent(item.id)}
              removeLabel={t("composer.removePasted")}
            />
          ))}
          {files.map((item) => (
            <AttachmentChip
              detail={formatFileMetadata(item.mimeType, item.sizeBytes)}
              icon={getFileIcon(item.mimeType)}
              key={item.id}
              label={item.name}
              onRemove={() => removeFile(item.id)}
              removeLabel={t("composer.remove", { name: item.name })}
            />
          ))}
        </div>
      ) : null}

      <div
        ref={panelRef}
        className="claude-ai-input__panel"
        onPointerLeave={handlePanelPointerLeave}
        onPointerMove={handlePanelPointerMove}
      >
        {sessionMentionMenuOpen ? (
          <div
            aria-label={t("composer.sessionMention.menu")}
            className="claude-ai-input__slash-menu claude-ai-input__mention-menu"
            id={sessionMentionListboxId}
            role="listbox"
          >
            <div className="claude-ai-input__mention-heading">{t("composer.sessionMention.heading")}</div>
            {filteredSessionMentions.map((option, index) => {
              const selected = index === activeSessionMentionOptionIndex;
              const optionId = `${sessionMentionListboxId}-option-${index}`;
              return (
                <button
                  aria-label={`${option.label}: ${option.detail}`}
                  aria-selected={selected}
                  className="claude-ai-input__slash-option"
                  id={optionId}
                  key={option.id}
                  role="option"
                  type="button"
                  onClick={() => selectSessionMention(option)}
                  onMouseDown={(event) => event.preventDefault()}
                >
                  <MessageCircle aria-hidden="true" size={16} />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.detail}</small>
                  </span>
                  {selected ? <kbd>Enter</kbd> : null}
                </button>
              );
            })}
          </div>
        ) : slashMenuOpen ? (
          <div
            aria-label={t("composer.slash")}
            className="claude-ai-input__slash-menu"
            id={slashListboxId}
            role="listbox"
          >
            {filteredSlashCommands.map((command, index) => {
              const selected = index === activeSlashOptionIndex;
              const optionId = `${slashListboxId}-option-${index}`;
              return (
                <button
                  aria-label={`${command.command} ${command.label}: ${command.description}`}
                  aria-selected={selected}
                  className="claude-ai-input__slash-option"
                  id={optionId}
                  key={command.command}
                  role="option"
                  type="button"
                  onClick={() => selectSlashCommand(command)}
                  onMouseDown={(event) => event.preventDefault()}
                >
                  <Command aria-hidden="true" size={16} />
                  <span>
                    <strong><code>{command.command}</code>{command.label}</strong>
                    <small>{command.description}</small>
                  </span>
                  {selected ? <kbd>Enter</kbd> : null}
                </button>
              );
            })}
          </div>
        ) : null}
        <textarea
          aria-label={t("composer.message")}
          aria-activedescendant={sessionMentionMenuOpen
            ? `${sessionMentionListboxId}-option-${activeSessionMentionOptionIndex}`
            : slashMenuOpen ? `${slashListboxId}-option-${activeSlashOptionIndex}` : undefined}
          aria-autocomplete="list"
          aria-controls={sessionMentionMenuOpen ? sessionMentionListboxId : slashMenuOpen ? slashListboxId : undefined}
          aria-expanded={sessionMentionMenuOpen || slashMenuOpen}
          aria-haspopup="listbox"
          className="claude-ai-input__textarea"
          disabled={disabled || sending}
          placeholder={resolvedPlaceholder}
          rows={2}
          value={currentMessage}
          onChange={(event) => updateMessage(event.currentTarget.value)}
          onKeyDown={handleTextareaKeyDown}
          onPaste={handlePaste}
          ref={textareaRef}
        />

        <div className="claude-ai-input__toolbar">
          <div className="claude-ai-input__tools">
            <button
              aria-label={t("composer.attachFiles")}
              className="claude-ai-input__icon-button"
              disabled={disabled || selectingFiles || files.length >= maxFiles || !onSelectFiles}
              title={t("composer.attachFiles")}
              type="button"
              onClick={() => void handleSelectFiles()}
            >
              <Plus aria-hidden="true" size={18} />
            </button>
            <div ref={toolMenuRef} className="claude-ai-input__tool">
              <button
                aria-expanded={toolMenuOpen}
                aria-haspopup="menu"
                aria-label={t("composer.tools")}
                className="claude-ai-input__icon-button"
                disabled={disabled || !tools.length}
                title={t("composer.tools")}
                type="button"
                onClick={() => {
                  setSlashMenuDismissed(true);
                  setToolMenuOpen((open) => !open);
                  setModelMenuOpen(false);
                }}
              >
                <SlidersHorizontal aria-hidden="true" size={18} />
              </button>
              {toolMenuOpen ? (
                <div className="claude-ai-input__tool-menu" role="menu" aria-label={t("composer.tools")}>
                  {tools.map((tool) => {
                    const checked = enabledToolIdSet.has(tool.id);
                    return (
                      <button
                        aria-checked={checked}
                        className="claude-ai-input__tool-option"
                        disabled={tool.disabled}
                        key={tool.id}
                        role="menuitemcheckbox"
                        type="button"
                        onClick={() => toggleTool(tool)}
                      >
                        <span>
                          <strong>{tool.name}</strong>
                          {tool.description ? <small>{tool.description}</small> : null}
                        </span>
                        <em>{checked ? t("composer.on") : t("composer.off")}</em>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            <div ref={modelMenuRef} className="claude-ai-input__model">
              <button
                ref={modelTriggerRef}
                aria-expanded={modelMenuOpen}
                aria-haspopup="dialog"
                aria-label={t("composer.selectModel")}
                className="claude-ai-input__model-trigger"
                disabled={disabled || !models.length}
                type="button"
                onClick={() => {
                  setSlashMenuDismissed(true);
                  setModelMenuOpen((open) => {
                    if (!open) setModelMenuView("advanced");
                    return !open;
                  });
                  setToolMenuOpen(false);
                }}
              >
                <span className="claude-ai-input__model-trigger-name">{selectedModel?.name ?? t("composer.model")}</span>
                <span className="claude-ai-input__model-trigger-effort">{selectedReasoningEffortLabel}</span>
                <ChevronDown aria-hidden="true" size={16} />
              </button>
              {modelMenuOpen ? (
                <div className="claude-ai-input__model-menu" role="dialog" aria-label={t("composer.modelEffort")}>
                  {modelMenuView === "advanced" ? (
                    <>
                      <div className="claude-ai-input__model-menu-title">{t("composer.advanced")}</div>
                      <button
                        className="claude-ai-input__model-menu-row"
                        type="button"
                        onClick={() => setModelMenuView("models")}
                      >
                        <strong>{t("composer.model")}</strong>
                        <span>{selectedModel?.name ?? t("composer.chooseModel")}</span>
                        <ChevronRight aria-hidden="true" size={16} />
                      </button>
                      <button
                        className="claude-ai-input__model-menu-row"
                        type="button"
                        onClick={() => setModelMenuView("effort")}
                      >
                        <strong>{t("composer.effort")}</strong>
                        <span>{selectedReasoningEffortLabel}</span>
                        <ChevronRight aria-hidden="true" size={16} />
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="claude-ai-input__model-menu-header">
                        <button
                          aria-label={t("composer.backAdvanced")}
                          className="claude-ai-input__model-menu-back"
                          type="button"
                          onClick={() => setModelMenuView("advanced")}
                        >
                          <ChevronLeft aria-hidden="true" size={16} />
                        </button>
                        <strong>{modelMenuView === "models" ? t("composer.model") : t("composer.effort")}</strong>
                      </div>
                      {modelMenuView === "models" ? (
                        <div className="claude-ai-input__model-menu-list" role="listbox" aria-label={t("composer.models")}>
                          {models.map((model) => (
                            <button
                              aria-selected={model.id === selectedModelId}
                              className="claude-ai-input__model-option"
                              key={model.id}
                              role="option"
                              type="button"
                              onClick={() => selectModel(model.id)}
                            >
                              <span>
                                <strong>{model.name}</strong>
                                <small>{model.description}</small>
                              </span>
                              {model.badge ? <em>{model.badge}</em> : null}
                              {model.id === selectedModelId ? <Check aria-hidden="true" size={15} /> : null}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="claude-ai-input__model-menu-list" role="listbox" aria-label={t("composer.reasoningEffort")}>
                          {effortOptions.map((option) => (
                            <button
                              aria-selected={option.value === selectedReasoningEffort}
                              className="claude-ai-input__model-option claude-ai-input__effort-option"
                              key={option.value}
                              role="option"
                              type="button"
                              onClick={() => selectReasoningEffort(option.value)}
                            >
                              <span>
                                <strong>{option.label}</strong>
                                <small>{option.description}</small>
                              </span>
                              {option.value === selectedReasoningEffort ? <Check aria-hidden="true" size={15} /> : null}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : null}
            </div>
            {contextUsageView ? <ContextUsageIndicator view={contextUsageView} /> : null}
          </div>

          {responding ? (
            <div className="claude-ai-input__running-actions">
              <button
                className="claude-ai-input__running-action claude-ai-input__running-action--primary"
                disabled={!canSend || !onInterruptMessage}
                title={canSend ? t("composer.interruptHelp") : t("composer.interruptDisabled")}
                type="button"
                onClick={() => void sendMessage("interrupt")}
              >
                {t("composer.interrupt")}
              </button>
              <button
                className="claude-ai-input__running-action"
                disabled={!canSend}
                title={canSend ? t("composer.queueHelp") : t("composer.queueDisabled")}
                type="submit"
              >
                {t("composer.queue")}
              </button>
              <button
                aria-label={canStopResponding ? t("composer.stop") : t("composer.stopUnavailable", { reason: stopUnavailableReason || t("composer.unsupported") })}
                className="claude-ai-input__send"
                disabled={disabled || !canStopResponding}
                title={canStopResponding ? t("composer.stop") : stopUnavailableReason || t("composer.stoppingUnavailable")}
                type="button"
                onClick={() => void handleStopResponding()}
              >
                <Square aria-hidden="true" size={15} />
              </button>
            </div>
          ) : (
            <button
              aria-label={t("composer.send")}
              className="claude-ai-input__send"
              disabled={!canSend}
              title={canSend ? t("composer.send") : disabledReason || t("composer.sendDisabled")}
              type="submit"
            >
              <ArrowUp aria-hidden="true" size={18} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

type ContextUsageView = {
  ariaLabel: string;
  leftPercent: number;
  percent: number;
  state: "normal" | "warn" | "critical";
  strategy?: string;
  tokenLabel: string;
};

function ContextUsageIndicator({ view }: { view: ContextUsageView }) {
  const { t } = useTranslation("chat");
  return (
    <div
      aria-label={view.ariaLabel}
      className="claude-ai-input__context-usage"
      data-state={view.state}
      role="img"
      tabIndex={0}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle className="claude-ai-input__context-usage-track" cx="12" cy="12" r="8.5" pathLength={100} />
        <circle
          className="claude-ai-input__context-usage-value"
          cx="12"
          cy="12"
          r="8.5"
          pathLength={100}
          strokeDasharray={`${view.percent} 100`}
        />
      </svg>
      <span className="claude-ai-input__context-usage-tip" role="tooltip">
        <strong>{t("composer.context.title")}</strong>
        <span>{t("composer.context.used", { percent: view.percent, left: view.leftPercent })}</span>
        <span>{view.tokenLabel}</span>
        {view.strategy ? <span>{t("composer.context.strategy", { strategy: view.strategy })}</span> : null}
      </span>
    </div>
  );
}

function buildContextUsageView(usage: TokenUsage | undefined, t: TFunction<"chat">): ContextUsageView | undefined {
  if (!usage) {
    return {
      ariaLabel: t("composer.context.aria", { percent: 0, left: 100 }),
      leftPercent: 100,
      percent: 0,
      state: "normal",
      tokenLabel: t("composer.context.zero"),
    };
  }
  const windowTokens = positiveNumber(usage.contextWindowTokens);
  const usedTokens = positiveNumber(usage.contextWindowUsedTokens ?? usage.promptTokens ?? usage.totalTokens);
  const percent = boundedPercent(usage.percent ?? (
    windowTokens !== undefined && usedTokens !== undefined ? (usedTokens / windowTokens) * 100 : undefined
  ));
  if (percent === undefined) {
    return undefined;
  }

  const leftPercent = Math.max(0, Math.round(100 - percent));
  const tokenLabel = windowTokens !== undefined && usedTokens !== undefined
    ? t("composer.context.tokens", { used: formatTokenCount(usedTokens), window: formatTokenCount(windowTokens) })
    : t("composer.context.provider");
  return {
    ariaLabel: t("composer.context.aria", { percent, left: leftPercent }),
    leftPercent,
    percent,
    state: percent >= 85 ? "critical" : percent >= 60 ? "warn" : "normal",
    strategy: usage.contextWindowStrategy,
    tokenLabel,
  };
}

function boundedPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function positiveNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${trimDecimal(value / 1_000_000)}M`;
  }
  if (value >= 1_000) {
    return `${trimDecimal(value / 1_000)}k`;
  }
  return String(Math.round(value));
}

function trimDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function reasoningEffortOptions(t: TFunction<"chat">): readonly ReasoningEffortOption[] {
  return [
    { value: "low", label: t("composer.effortOptions.low.label"), description: t("composer.effortOptions.low.description") },
    { value: "medium", label: t("composer.effortOptions.medium.label"), description: t("composer.effortOptions.medium.description") },
    { value: "high", label: t("composer.effortOptions.high.label"), description: t("composer.effortOptions.high.description") },
    { value: "xhigh", label: t("composer.effortOptions.xhigh.label"), description: t("composer.effortOptions.xhigh.description") },
    { value: "max", label: t("composer.effortOptions.max.label"), description: t("composer.effortOptions.max.description") },
  ];
}

function reasoningEffortLabel(effort: ReasoningEffort, options: readonly ReasoningEffortOption[]): string {
  return options.find((option) => option.value === effort)?.label ?? options[1]?.label ?? "Medium";
}

function sessionMentionMatch(message: string): { query: string; start: number } | undefined {
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(message);
  if (!match) return undefined;
  const atOffset = match[0].lastIndexOf("@");
  return {
    query: match[1] ?? "",
    start: match.index + atOffset,
  };
}

function AttachmentChip({
  detail,
  icon,
  label,
  onRemove,
  removeLabel,
}: {
  detail: string;
  icon: ReactNode;
  label: string;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <div className="claude-ai-input__attachment">
      <span className="claude-ai-input__attachment-icon">{icon}</span>
      <span className="claude-ai-input__attachment-text">
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <button aria-label={removeLabel} type="button" onClick={onRemove}>
        <X aria-hidden="true" size={14} />
      </button>
    </div>
  );
}

const getFileIcon = (type: string) => {
  if (type.startsWith("image/")) {
    return <ImageIcon aria-hidden="true" size={16} />;
  }
  if (type.startsWith("video/")) {
    return <Video aria-hidden="true" size={16} />;
  }
  if (type.startsWith("audio/")) {
    return <Music aria-hidden="true" size={16} />;
  }
  if (type.includes("zip") || type.includes("rar") || type.includes("tar")) {
    return <Archive aria-hidden="true" size={16} />;
  }
  return <FileText aria-hidden="true" size={16} />;
};

function formatFileSize(bytes: number): string {
  if (bytes === 0) {
    return "0 Bytes";
  }
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function getFileTypeLabel(type: string): string {
  const parts = type.split("/");
  let label = (parts[parts.length - 1] || "file").toUpperCase();
  if (label.length > 7 && label.includes("-")) {
    label = label.substring(0, label.indexOf("-"));
  }
  if (label.length > 10) {
    label = `${label.substring(0, 10)}...`;
  }
  return label;
}

export function formatFileMetadata(mimeType: string, sizeBytes: number): string {
  return `${getFileTypeLabel(mimeType)} - ${formatFileSize(sizeBytes)}`;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
