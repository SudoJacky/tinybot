"use client";

import type { ComposerCursor, ComposerEditorHandle, ComposerEditorProps, ComposerSkillOption } from "./composerContracts";

import type { DragEvent, FormEvent, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../../app-core/chat/reasoningEffort";
import type { TokenUsage } from "../../app-core/chat/chatTurnContracts";
import { formatFileMetadata } from "./composerFileMetadata";
import { ComposerAnnotations } from "./ComposerAnnotations";
import { FileAttachmentChip } from "./FileAttachmentChip";
import { MarkdownComposerEditor } from "./MarkdownComposerEditor";
import { PlainComposerEditor } from "./PlainComposerEditor";
import { useComposerRichText } from "./useComposerRichText";
import type { ComposerContextReference } from "./composerContextReference";
export type { ComposerContextReference } from "./composerContextReference";
import {
  AlertCircle,
  ArrowUp,
  Box,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Command,
  FileText,
  MessageCircle,
  Plus,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";

export interface ComposerFileReference {
  contentHash?: string;
  id: string;
  name: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
}

export type ComposerFileSelection = Omit<ComposerFileReference, "id">;

export interface ModelOption {
  id: string;
  modelId?: string;
  providerId?: string;
  name: string;
  description: string;
  badge?: string;
  supportsImageInput?: boolean;
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
  mcpEnabled?: boolean;
}

export interface ComposerSessionMentionOption {
  detail: string;
  id: string;
  label: string;
}

export interface ClaudeStyleAiInputProps {
  richText?: boolean;
  className?: string;
  contextReferences?: ComposerContextReference[];
  focusRequestId?: number;
  onSendMessage?: (
    message: string,
    files: ComposerFileReference[],
    options: ComposerSendOptions,
  ) => void | Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  placeholder?: string;
  maxFiles?: number;
  files?: ComposerFileReference[];
  onFilesChange?: (files: ComposerFileReference[]) => void;
  onSelectFiles?: () => Promise<ComposerFileSelection[]>;
  onImportFiles?: (files: File[]) => Promise<ComposerFileSelection[]>;
  attachmentContextKey?: string;
  models?: ModelOption[];
  defaultModel?: string;
  defaultReasoningEffort?: ReasoningEffort;
  onModelChange?: (modelId: string) => void;
  onReasoningEffortChange?: (effort: ReasoningEffort) => void;
  onClearContextReferences?: () => void;
  onRemoveContextReference?: (id: string) => void;
  onAddSessionMention?: (id: string) => void;
  onAddSkill?: (id: string) => void;
  onClearSessionMentions?: () => void;
  onClearSkills?: () => void;
  onRemoveSessionMention?: (id: string) => void;
  onRemoveSkill?: (id: string) => void;
  contextUsage?: TokenUsage;
  selectedSessionMentionIds?: readonly string[];
  selectedSkillIds?: readonly string[];
  sessionMentionOptions?: readonly ComposerSessionMentionOption[];
  teamAvailable?: boolean;
  skillOptions?: readonly ComposerSkillOption[];
  mcpEnabled?: boolean;
  responding?: boolean;
  canStopResponding?: boolean;
  stopUnavailableReason?: string;
  onStopResponding?: () => void | Promise<void>;
  slashCommands?: readonly ComposerSlashCommand[];
  value?: string;
  onValueChange?: (value: string) => void;
}

const MAX_FILES = 10;
const EMPTY_MODELS: ModelOption[] = [];
const EMPTY_SLASH_COMMANDS: readonly ComposerSlashCommand[] = [];
const EMPTY_SKILLS: readonly ComposerSkillOption[] = [];
const EMPTY_SESSION_MENTIONS: readonly ComposerSessionMentionOption[] = [];
const EMPTY_SELECTED_IDS: readonly string[] = [];
const MAX_SESSION_MENTIONS = 4;
type ReasoningEffortOption = {
  description: string;
  label: string;
  value: ReasoningEffort;
};

type ModelMenuView = "advanced" | "effort" | "models";

type ComposerSlashMenuOption =
  | { command: ComposerSlashCommand; kind: "command" }
  | { kind: "skill"; skill: ComposerSkillOption };

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
  files: controlledFiles,
  focusRequestId,
  maxFiles = MAX_FILES,
  models = EMPTY_MODELS,
  onModelChange,
  onReasoningEffortChange,
  onAddSessionMention,
  onAddSkill,
  onClearContextReferences,
  onClearSessionMentions,
  onClearSkills,
  onFilesChange,
  onRemoveContextReference,
  onRemoveSessionMention,
  onRemoveSkill,
  onSelectFiles,
  onImportFiles,
  attachmentContextKey,
  onSendMessage,
  onStopResponding,
  onValueChange,
  placeholder,
  responding = false,
  richText,
  sendDisabled = false,
  sendDisabledReason,
  selectedSessionMentionIds = EMPTY_SELECTED_IDS,
  selectedSkillIds = EMPTY_SELECTED_IDS,
  sessionMentionOptions = EMPTY_SESSION_MENTIONS,
  teamAvailable = false,
  skillOptions = EMPTY_SKILLS,
  slashCommands = EMPTY_SLASH_COMMANDS,
  stopUnavailableReason,
  mcpEnabled,
  value,
}: ClaudeStyleAiInputProps) {
  const { t } = useTranslation("chat");
  const preferRichText = useComposerRichText();
  const richTextEnabled = richText ?? preferRichText;
  const editorRef = useRef<ComposerEditorHandle | null>(null);
  const [composerCursor, setComposerCursor] = useState<ComposerCursor>({ text: "", offset: 0 });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const attachmentRowRef = useRef<HTMLDivElement | null>(null);
  const previousAttachmentIds = useRef(new Set<string>());
  const handledFocusRequestRef = useRef(focusRequestId);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [message, setMessage] = useState("");
  const [uncontrolledFiles, setUncontrolledFiles] = useState<ComposerFileReference[]>([]);
  const [selectedModelId, setSelectedModelId] = useState(defaultModel ?? models[0]?.id ?? "");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<ReasoningEffort>(
    defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT,
  );
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuView, setModelMenuView] = useState<ModelMenuView>("advanced");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [selectingFiles, setSelectingFiles] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const fileRequestRef = useRef<object | null>(null);
  const dragDepthRef = useRef(0);
  const [activeSlashCommandIndex, setActiveSlashCommandIndex] = useState(0);
  const [activeSlashStart, setActiveSlashStart] = useState<number | null>(null);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [activeSessionMentionIndex, setActiveSessionMentionIndex] = useState(0);
  const [sessionMentionMenuDismissed, setSessionMentionMenuDismissed] = useState(false);
  const slashListboxId = useId();
  const sessionMentionListboxId = useId();
  const currentMessage = value ?? message;
  const files = controlledFiles ?? uncontrolledFiles;
  useLayoutEffect(() => {
    const ids = [...contextReferences.map((reference) => reference.id), ...files.map((file) => file.id)];
    const added = ids.filter((id) => !previousAttachmentIds.current.has(id));
    previousAttachmentIds.current = new Set(ids);
    if (!added.length) return;
    const row = attachmentRowRef.current;
    const target = row && Array.from(row.querySelectorAll<HTMLElement>("[data-attachment-id]"))
      .find((element) => element.dataset.attachmentId === added[added.length - 1]);
    if (row && target) {
      const bounds = row.getBoundingClientRect();
      const chip = target.getBoundingClientRect();
      if (chip.right > bounds.right) row.scrollLeft += chip.right - bounds.right;
      else if (chip.left < bounds.left) row.scrollLeft += chip.left - bounds.left;
    }
  }, [contextReferences, files]);
  const filesRef = useRef(files);
  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId)
      ?? models.find((model) => model.id === defaultModel)
      ?? models[0],
    [defaultModel, models, selectedModelId],
  );
  const selectedModelRejectsImages = Boolean(
    selectedModel
    && selectedModel.supportsImageInput !== true
    && (files.some((file) => file.mimeType.startsWith("image/")) || contextReferences.some((reference) => reference.mimeType?.startsWith("image/"))),
  );
  const imageCompatibilityError = selectedModelRejectsImages
    ? t("composer.imageUnsupported", { model: selectedModel?.name ?? t("composer.model") })
    : "";
  const composerError = imageCompatibilityError || error;
  const effortOptions = useMemo(() => reasoningEffortOptions(t), [t]);
  const selectedReasoningEffortLabel = reasoningEffortLabel(selectedReasoningEffort, effortOptions);
  const contextUsageView = useMemo(() => buildContextUsageView(contextUsage, t), [contextUsage, t]);
  const resolvedPlaceholder = placeholder ?? t("composer.placeholder");
  const selectedSessionMentionIdSet = useMemo(
    () => new Set(selectedSessionMentionIds),
    [selectedSessionMentionIds],
  );
  const selectedSessionMentions = useMemo(
    () => sessionMentionOptions.filter((option) => selectedSessionMentionIdSet.has(option.id)),
    [selectedSessionMentionIdSet, sessionMentionOptions],
  );

  const selectedSkillIdSet = useMemo(() => new Set(selectedSkillIds), [selectedSkillIds]);
  const selectedSkills = useMemo(
    () => skillOptions.filter((option) => selectedSkillIdSet.has(option.id)),
    [selectedSkillIdSet, skillOptions],
  );
  const inlineSkillsEnabled = skillOptions.length > 0 || selectedSkills.length > 0;
  const canSend = !disabled && !sendDisabled && !sending && !selectingFiles && !selectedModelRejectsImages && Boolean(
    currentMessage.trim()
      || files.length
      || contextReferences.length
      || selectedSessionMentions.length
      || selectedSkills.length,
  );
  const composerTriggerText = richTextEnabled ? composerCursor.text : currentMessage;
  const composerCaretOffset = composerCursor.offset;
  const slashMatch = useMemo(
    () => slashTriggerMatch(composerTriggerText, composerCaretOffset, activeSlashStart),
    [activeSlashStart, composerCaretOffset, composerTriggerText],
  );
  const slashQuery = slashMatch?.query.toLocaleLowerCase();
  const filteredSlashOptions = useMemo<ComposerSlashMenuOption[]>(() => {
    if (slashQuery === undefined) return [];
    const commands = slashCommands.filter((command) => {
      const name = command.command.slice(1).toLocaleLowerCase();
      const searchText = `${name} ${command.label} ${command.description}`.toLocaleLowerCase();
      return name.startsWith(slashQuery) || searchText.includes(slashQuery);
    }).map((command) => ({ command, kind: "command" as const }));
    const skills = skillOptions
      .filter((skill) => !selectedSkillIdSet.has(skill.id))
      .filter((skill) => `${skill.label} ${skill.description} ${skill.sourceLabel}`
        .toLocaleLowerCase()
        .includes(slashQuery))
      .map((skill) => ({ kind: "skill" as const, skill }));
    return [...commands, ...skills];
  }, [selectedSkillIdSet, skillOptions, slashCommands, slashQuery]);
  const slashMenuOpen = !disabled
    && !sending
    && !slashMenuDismissed
    && slashQuery !== undefined
    && filteredSlashOptions.length > 0;
  const activeSlashOptionIndex = Math.min(activeSlashCommandIndex, Math.max(0, filteredSlashOptions.length - 1));
  const mentionMatch = useMemo(
    () => sessionMentionMatch(composerTriggerText, composerCaretOffset),
    [composerCaretOffset, composerTriggerText],
  );
  const filteredSessionMentions = useMemo(() => {
    if (!mentionMatch) return [];
    const query = mentionMatch.query.toLocaleLowerCase();
    const options = selectedSessionMentions.length >= MAX_SESSION_MENTIONS ? [] : [...sessionMentionOptions];
    if (teamAvailable && !/^@team(?:\s|$)/.test(currentMessage)) {
      options.unshift({ id: "__team_mode__", label: "team", detail: t("composer.teamDescription") });
    }
    return options
      .filter((option) => !selectedSessionMentionIdSet.has(option.id))
      .filter((option) => `${option.label} ${option.detail}`.toLocaleLowerCase().includes(query))
      .slice(0, 8);
  }, [mentionMatch, selectedSessionMentionIdSet, selectedSessionMentions.length, sessionMentionOptions, teamAvailable, currentMessage, t]);
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

  function updateFiles(update: (current: ComposerFileReference[]) => ComposerFileReference[]): void {
    const nextFiles = update(filesRef.current);
    filesRef.current = nextFiles;
    if (controlledFiles === undefined) setUncontrolledFiles(nextFiles);
    else onFilesChange?.(nextFiles);
  }

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useLayoutEffect(() => {
    setSelectingFiles(false);
    setDraggingFiles(false);
    dragDepthRef.current = 0;
    return () => { fileRequestRef.current = null; };
  }, [attachmentContextKey]);

  useEffect(() => {
    const nextModelId = defaultModel || models[0]?.id || "";
    setSelectedModelId(nextModelId);
  }, [defaultModel, models]);

  useEffect(() => {
    setSelectedReasoningEffort(defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT);
  }, [defaultReasoningEffort]);

  useLayoutEffect(() => {
    if (!focusRequestId || handledFocusRequestRef.current === focusRequestId) return;
    handledFocusRequestRef.current = focusRequestId;
    editorRef.current?.focusEnd();
  }, [focusRequestId]);

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
  }, [sessionMentionMenuOpen, slashMenuOpen]);

  useEffect(() => {
    if (!modelMenuOpen && !slashMenuOpen && !sessionMentionMenuOpen) {
      return;
    }
    function closeMenus(event: PointerEvent) {
      const target = event.target as Node;
      if (!modelMenuRef.current?.contains(target)) {
        setModelMenuOpen(false);
        setModelMenuView("advanced");
      }
      if (slashMenuOpen && !panelRef.current?.contains(target)) {
        setSlashMenuDismissed(true);
        setActiveSlashStart(null);
      }
      if (sessionMentionMenuOpen && !panelRef.current?.contains(target)) {
        setSessionMentionMenuDismissed(true);
      }
    }
    document.addEventListener("pointerdown", closeMenus, true);
    return () => document.removeEventListener("pointerdown", closeMenus, true);
  }, [modelMenuOpen, sessionMentionMenuOpen, slashMenuOpen]);

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

  async function sendMessage() {
    if (!canSend || fileRequestRef.current) {
      return;
    }
    setSending(true);
    setError("");
    try {
      await onSendMessage?.(currentMessage.trim(), files, {
        ...(selectedModel ? { model: selectedModel.modelId || selectedModel.id } : {}),
        ...(selectedModel?.providerId ? { provider: selectedModel.providerId } : {}),
        reasoningEffort: selectedReasoningEffort,
        ...(mcpEnabled !== undefined ? { mcpEnabled } : {}),
      });
      updateMessage("");
      setActiveSlashStart(null);
      if (controlledFiles === undefined) updateFiles(() => []);
      else onFilesChange?.([]);
      onClearContextReferences?.();
      onClearSessionMentions?.();
      onClearSkills?.();
    } catch (error) {
      setError(error instanceof Error ? error.message : t("composer.sendFailed"));
    } finally {
      setSending(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendMessage();
  }

  async function handleStopResponding() {
    setError("");
    try {
      await onStopResponding?.();
    } catch {
      setError(t("composer.stopFailed"));
    }
  }

  function updateSlashTrigger(messageValue: string, caretOffset: number): void {
    const caret = clampOffset(caretOffset, messageValue);
    if (caret > 0 && messageValue[caret - 1] === "/") setSlashMenuDismissed(false);
    setActiveSlashStart((current) => nextSlashTriggerStart(messageValue, caret, current));
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement | HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && event.shiftKey) return;
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
          (current + direction + filteredSlashOptions.length) % filteredSlashOptions.length
        ));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        selectSlashOption(filteredSlashOptions[activeSlashOptionIndex] ?? filteredSlashOptions[0]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashMenuDismissed(true);
        setActiveSlashStart(null);
        return;
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.closest("form")?.requestSubmit();
    }
  }

  function selectSlashOption(option: ComposerSlashMenuOption | undefined) {
    if (!option) return;
    setSlashMenuDismissed(true);
    setActiveSlashStart(null);
    if (option.kind === "skill") {
      if (slashMatch) editorRef.current?.replaceTrigger(slashMatch.start, slashMatch.end, option.skill);
      return;
    }
    updateMessage(option.command.prompt);
    window.requestAnimationFrame(() => {
      editorRef.current?.focusEnd();
      if (option.command.submitOnSelect) panelRef.current?.closest("form")?.requestSubmit();
    });
  }

  function selectSessionMention(option: ComposerSessionMentionOption | undefined) {
    const match = sessionMentionMatch(composerTriggerText, composerCaretOffset);
    if (!option || !match) return;
    setSessionMentionMenuDismissed(true);
    if (option.id === "__team_mode__") {
      if (richTextEnabled) editorRef.current?.replaceTrigger(match.start, match.end, undefined, "@team ");
      else {
        updateMessage("@team " + currentMessage.slice(0, match.start) + currentMessage.slice(match.end));
        window.requestAnimationFrame(() => editorRef.current?.focusEnd());
      }
      return;
    }
    editorRef.current?.replaceTrigger(match.start, match.end);
    onAddSessionMention?.(option.id);
  }

  async function selectFiles(load: () => Promise<ComposerFileSelection[]>) {
    if (disabled || sending || fileRequestRef.current) return;
    const request = {};
    fileRequestRef.current = request;
    setError("");
    setSelectingFiles(true);
    try {
      const selectedFiles = await load();
      if (fileRequestRef.current !== request) return;
      if (!selectedFiles.length) {
        return;
      }
      const acceptedFiles = selectedModel && selectedModel.supportsImageInput !== true
        ? selectedFiles.filter((file) => !file.mimeType.startsWith("image/"))
        : selectedFiles;
      if (acceptedFiles.length !== selectedFiles.length) {
        setError(t("composer.imageUnsupported", { model: selectedModel?.name ?? t("composer.model") }));
      }
      updateFiles((current) => {
        const remainingSlots = Math.max(0, maxFiles - current.length);
        if (acceptedFiles.length > remainingSlots) {
          setError(t("composer.fileLimit", { count: maxFiles }));
        }
        return [
          ...current,
          ...acceptedFiles.slice(0, remainingSlots).map((file) => ({
            ...file,
            id: nextInputId("file"),
          })),
        ];
      });
    } catch (error) {
      if (fileRequestRef.current === request) {
        setError(error instanceof Error ? error.message : typeof error === "string" ? error : t("composer.filesFailed"));
      }
    } finally {
      if (fileRequestRef.current === request) {
        fileRequestRef.current = null;
        setSelectingFiles(false);
      }
    }
  }

  function handleSelectFiles() {
    if (onSelectFiles) return selectFiles(onSelectFiles);
  }

  function handleImportFiles(incoming: File[]) {
    if (!onImportFiles || disabled || sending || fileRequestRef.current) return;
    const remainingSlots = Math.max(0, maxFiles - filesRef.current.length);
    // Reject an oversized batch before reading bytes; no files disappear silently.
    if (incoming.length > remainingSlots) {
      setError(t("composer.fileLimit", { count: maxFiles }));
      return;
    }
    return selectFiles(() => onImportFiles(incoming));
  }

  function handleDragOver(event: DragEvent<HTMLFormElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = onImportFiles && !disabled && !sending && !selectingFiles ? "copy" : "none";
  }

  function handleDragEnter(event: DragEvent<HTMLFormElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    if (onImportFiles && !disabled && !sending && !selectingFiles) setDraggingFiles(true);
  }

  function handleDragLeave(event: DragEvent<HTMLFormElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDraggingFiles(false);
  }

  function handleDrop(event: DragEvent<HTMLFormElement>) {
    dragDepthRef.current = 0;
    setDraggingFiles(false);
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    void handleImportFiles(Array.from(event.dataTransfer.files));
  }

  function removeFile(id: string) {
    updateFiles((current) => current.filter((file) => file.id !== id));
  }

  function selectModel(modelId: string) {
    setSelectedModelId(modelId);
    setError("");
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

  const removeSkillLabel = useCallback((skill: ComposerSkillOption) => t("composer.remove", { name: skill.label }), [t]);
  const editorProps: ComposerEditorProps = {
    ref: editorRef,
    value: currentMessage,
    disabled: disabled || sending,
    label: t("composer.message"),
    placeholder: resolvedPlaceholder,
    skills: selectedSkills,
    removeSkillLabel,
    activeDescendant: sessionMentionMenuOpen
      ? `${sessionMentionListboxId}-option-${activeSessionMentionOptionIndex}`
      : slashMenuOpen ? `${slashListboxId}-option-${activeSlashOptionIndex}` : undefined,
    controls: sessionMentionMenuOpen ? sessionMentionListboxId : slashMenuOpen ? slashListboxId : undefined,
    onChange: updateMessage,
    onCursorChange: (next) => {
      setComposerCursor(next);
      updateSlashTrigger(next.text, next.offset);
    },
    onSkillsChange: (ids) => {
      for (const id of selectedSkillIds) if (!ids.includes(id)) onRemoveSkill?.(id);
      for (const id of ids) if (!selectedSkillIdSet.has(id)) onAddSkill?.(id);
    },
    onImportFiles: (incoming) => { void handleImportFiles(incoming); },
    onKeyDown: handleComposerKeyDown,
  };

  return (
    <form
      aria-label={t("composer.label")}
      className={["claude-ai-input", className].filter(Boolean).join(" ")}
      data-dragging-files={draggingFiles || undefined}
      aria-busy={selectingFiles}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onSubmit={(event) => void handleSubmit(event)}
    >
      {composerError ? (
        <div className="claude-ai-input__notice" role="alert">
          <AlertCircle aria-hidden="true" size={15} />
          <span>{composerError}</span>
        </div>
      ) : null}
      {!composerError && (disabled || sendDisabled) && (disabledReason || sendDisabledReason) ? (
        <div className="claude-ai-input__notice" role="status">
          <AlertCircle aria-hidden="true" size={15} />
          <span>{disabledReason || sendDisabledReason}</span>
        </div>
      ) : null}
      <div
        ref={panelRef}
        className="claude-ai-input__panel"
        onPointerLeave={handlePanelPointerLeave}
        onPointerMove={handlePanelPointerMove}
      >
        {files.length || contextReferences.length || selectedSessionMentions.length ? (
          <div aria-label={t("composer.attachments")}>
            <div ref={attachmentRowRef} className="claude-ai-input__attachments">
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
              <ComposerAnnotations references={contextReferences.filter((reference) => reference.presentation === "compact-annotation")} onRemove={(id) => onRemoveContextReference?.(id)} />
              {contextReferences.filter((reference) => reference.presentation !== "compact-annotation" && !reference.annotation).map((reference) => reference.kind === "file" ? (
                <FileAttachmentChip
                  key={reference.id} id={reference.id} name={reference.label} path={reference.body}
                  detail={reference.detail} mimeType={reference.mimeType}
                  onRemove={() => onRemoveContextReference?.(reference.id)}
                  removeLabel={t("composer.remove", { name: reference.label })}
                />
              ) : (
                <AttachmentChip
                  imageUrl={reference.imageUrl}
                  annotation={reference.annotation}
                  body={reference.body}
                  detail={reference.detail}
                  icon={reference.kind === "terminal" ? <TerminalSquare aria-hidden="true" size={16} /> : <FileText aria-hidden="true" size={16} />}
                  key={reference.id}
                  label={reference.label}
                  onRemove={() => onRemoveContextReference?.(reference.id)}
                  removeLabel={t("composer.remove", { name: reference.label })}
                />
              ))}
              {files.map((item) => (
                <FileAttachmentChip
                  id={item.id}
                  detail={formatFileMetadata(item.mimeType, item.sizeBytes)}
                  mimeType={item.mimeType}
                  path={item.path}
                  key={item.id}
                  name={item.name}
                  onRemove={() => removeFile(item.id)}
                  removeLabel={t("composer.remove", { name: item.name })}
                />
              ))}
            </div>
            {contextReferences.filter((reference) => reference.presentation !== "compact-annotation" && reference.annotation).map((reference) => (
              <AttachmentChip key={reference.id} {...reference} icon={<FileText aria-hidden="true" size={16} />}
                onRemove={() => onRemoveContextReference?.(reference.id)} removeLabel={t("composer.remove", { name: reference.label })} />
            ))}
          </div>
        ) : null}
        {draggingFiles || selectingFiles ? (
          <div className="claude-ai-input__file-status" role="status">
            <FileText aria-hidden="true" size={18} />
            {t(selectingFiles ? "composer.importingFiles" : "composer.dropFiles")}
          </div>
        ) : null}
        {sessionMentionMenuOpen ? (
          <div
            aria-label={t("composer.sessionMention.menu")}
            className="react-popover-surface claude-ai-input__slash-menu claude-ai-input__mention-menu"
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
                  className="react-popover-item claude-ai-input__slash-option"
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
            className="react-popover-surface claude-ai-input__slash-menu"
            id={slashListboxId}
            role="listbox"
          >
            {filteredSlashOptions.map((option, index) => {
              if (option.kind !== "command") return null;
              const { command } = option;
              const selected = index === activeSlashOptionIndex;
              const optionId = `${slashListboxId}-option-${index}`;
              return (
                <button
                  aria-label={`${command.command} ${command.label}: ${command.description}`}
                  aria-selected={selected}
                  className="react-popover-item claude-ai-input__slash-option"
                  id={optionId}
                  key={command.command}
                  role="option"
                  type="button"
                  onClick={() => selectSlashOption(option)}
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
            {filteredSlashOptions.some((option) => option.kind === "skill") ? (
              <div
                aria-label={t("composer.skill.heading")}
                className="claude-ai-input__slash-group"
                role="group"
              >
                <div aria-hidden="true" className="claude-ai-input__slash-heading">{t("composer.skill.heading")}</div>
                {filteredSlashOptions.map((option, index) => {
                  if (option.kind !== "skill") return null;
                  const { skill } = option;
                  const selected = index === activeSlashOptionIndex;
                  const optionId = `${slashListboxId}-option-${index}`;
                  return (
                    <button
                      aria-label={`${skill.label}: ${skill.description}. ${skill.sourceLabel}`}
                      aria-selected={selected}
                      className="react-popover-item claude-ai-input__slash-option claude-ai-input__slash-option--skill"
                      id={optionId}
                      key={`skill:${skill.id}`}
                      role="option"
                      type="button"
                      onClick={() => selectSlashOption(option)}
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      <Box aria-hidden="true" size={16} />
                      <span>
                        <strong>{skill.label}</strong>
                        <small>{skill.description}</small>
                      </span>
                      <span className="claude-ai-input__slash-option-meta">
                        <em>{skill.sourceLabel}</em>
                        {selected ? <kbd>Enter</kbd> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
        {richTextEnabled
          ? <MarkdownComposerEditor {...editorProps} />
          : <PlainComposerEditor {...editorProps} inlineSkills={inlineSkillsEnabled} />}

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
                  setActiveSlashStart(null);
                  setModelMenuOpen((open) => {
                    if (!open) setModelMenuView("advanced");
                    return !open;
                  });
                }}
              >
                <span className="claude-ai-input__model-trigger-name">{selectedModel?.name ?? t("composer.model")}</span>
                <span className="claude-ai-input__model-trigger-effort">{selectedReasoningEffortLabel}</span>
                <ChevronDown aria-hidden="true" size={16} />
              </button>
              {modelMenuOpen ? (
                <div className="react-popover-surface claude-ai-input__model-menu" role="dialog" aria-label={t("composer.modelEffort")}>
                  {modelMenuView === "advanced" ? (
                    <>
                      <div className="claude-ai-input__model-menu-title">{t("composer.advanced")}</div>
                      <button
                        className="react-popover-item claude-ai-input__model-menu-row"
                        type="button"
                        onClick={() => setModelMenuView("models")}
                      >
                        <strong>{t("composer.model")}</strong>
                        <span>{selectedModel?.name ?? t("composer.chooseModel")}</span>
                        <ChevronRight aria-hidden="true" size={16} />
                      </button>
                      <button
                        className="react-popover-item claude-ai-input__model-menu-row"
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
                              className="react-popover-item claude-ai-input__model-option"
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
                              className="react-popover-item claude-ai-input__model-option claude-ai-input__effort-option"
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

          <button
            aria-label={responding
              ? canStopResponding
                ? t("composer.stop")
                : t("composer.stopUnavailable", { reason: stopUnavailableReason || t("composer.unsupported") })
              : t("composer.send")}
            className="claude-ai-input__send"
            disabled={responding ? disabled || !canStopResponding : !canSend}
            title={responding
              ? canStopResponding
                ? t("composer.stop")
                : stopUnavailableReason || t("composer.stoppingUnavailable")
              : canSend
                ? t("composer.send")
                : sendDisabledReason || disabledReason || t("composer.sendDisabled")}
            type={responding ? "button" : "submit"}
            onClick={responding ? () => void handleStopResponding() : undefined}
          >
            {responding
              ? <Square aria-hidden="true" size={15} />
              : <ArrowUp aria-hidden="true" size={18} />}
          </button>
        </div>
      </div>
    </form>
  );
}

type ContextUsageView = {
  ariaLabel: string;
  cacheHitLabel: string;
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
      aria-description={view.cacheHitLabel}
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
        <span>{view.cacheHitLabel}</span>
        {view.strategy ? <span>{t("composer.context.strategy", { strategy: view.strategy })}</span> : null}
      </span>
    </div>
  );
}

function buildContextUsageView(usage: TokenUsage | undefined, t: TFunction<"chat">): ContextUsageView | undefined {
  const cacheHitLabel = buildCacheHitLabel(usage, t);
  if (!usage) {
    return {
      ariaLabel: t("composer.context.aria", { percent: 0, left: 100 }),
      cacheHitLabel,
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
    cacheHitLabel,
    leftPercent,
    percent,
    state: percent >= 85 ? "critical" : percent >= 60 ? "warn" : "normal",
    strategy: usage.contextWindowStrategy,
    tokenLabel,
  };
}

function buildCacheHitLabel(usage: TokenUsage | undefined, t: TFunction<"chat">): string {
  const cachedTokens = nonNegativeNumber(usage?.cachedTokens);
  const promptTokens = positiveNumber(usage?.promptTokens);
  if (cachedTokens === undefined || promptTokens === undefined) {
    return t("composer.context.cacheUnavailable");
  }
  const percent = boundedPercent((cachedTokens / promptTokens) * 100) ?? 0;
  return t("composer.context.cacheHit", { percent });
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

function nonNegativeNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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

function clampOffset(offset: number, message: string): number {
  return Math.max(0, Math.min(message.length, offset));
}

function nextSlashTriggerStart(
  message: string,
  caretOffset: number,
  activeStart: number | null,
): number | null {
  const caret = clampOffset(caretOffset, message);
  if (caret > 0 && message[caret - 1] === "/") return caret - 1;
  if (
    activeStart === null
    || activeStart < 0
    || activeStart >= caret
    || message[activeStart] !== "/"
  ) {
    return null;
  }
  return /[\s/]/u.test(message.slice(activeStart + 1, caret)) ? null : activeStart;
}

function slashTriggerMatch(
  message: string,
  caretOffset: number,
  activeStart: number | null,
): { end: number; query: string; start: number } | undefined {
  const end = clampOffset(caretOffset, message);
  if (
    activeStart === null
    || activeStart < 0
    || activeStart >= end
    || message[activeStart] !== "/"
  ) {
    return undefined;
  }
  const query = message.slice(activeStart + 1, end);
  if (/[\s/]/u.test(query)) return undefined;
  return {
    end,
    query,
    start: activeStart,
  };
}

function sessionMentionMatch(
  message: string,
  caretOffset = message.length,
): { end: number; query: string; start: number } | undefined {
  const end = clampOffset(caretOffset, message);
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(message.slice(0, end));
  if (!match) return undefined;
  const atOffset = match[0].lastIndexOf("@");
  return {
    end,
    query: match[1] ?? "",
    start: match.index + atOffset,
  };
}

function AttachmentChip({
  imageUrl,
  annotation,
  body,
  detail,
  icon,
  label,
  onRemove,
  removeLabel,
}: {
  imageUrl?: string;
  annotation?: ComposerContextReference["annotation"];
  body?: string;
  detail: string;
  icon: ReactNode;
  label: string;
  onRemove: () => void;
  removeLabel: string;
}) {
  if (annotation || body) {
    return (
      <div className="claude-ai-input__attachment" data-presentation="annotation">
        <div className="claude-ai-input__attachment-header">
          <span className="claude-ai-input__attachment-icon">{icon}</span>
          <span className="claude-ai-input__attachment-text">
            <strong>{label}</strong>
            <small>{detail}</small>
          </span>
          <button aria-label={removeLabel} type="button" onClick={onRemove}>
            <X aria-hidden="true" size={14} />
          </button>
        </div>
        {imageUrl ? <a href={imageUrl} target="_blank" rel="noreferrer"><img src={imageUrl} alt={label} style={{ width: "100%", maxHeight: 120, objectFit: "contain" }} /></a> : null}
        {body ? annotation?.onChange ? <details><summary>{detail}</summary><p className="claude-ai-input__attachment-body">{body}</p></details> : <p className="claude-ai-input__attachment-body">{body}</p> : null}
        {annotation ? (
          <div className="claude-ai-input__attachment-annotation">
            <span className="claude-ai-input__attachment-annotation-label">
              <MessageCircle aria-hidden="true" size={14} />
              {annotation.label}
            </span>
            {annotation.onChange ? <textarea aria-label={annotation.label} value={annotation.text} maxLength={8000} onChange={(event) => annotation.onChange?.(event.currentTarget.value)} style={{ width: "100%", minHeight: 56, resize: "vertical", font: "inherit", color: "inherit", background: "transparent", border: "1px solid var(--color-hairline)", borderRadius: 6, padding: 6 }} /> : <p>{annotation.text}</p>}
          </div>
        ) : null}
      </div>
    );
  }
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
