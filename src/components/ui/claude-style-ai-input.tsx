"use client";

import type { ClipboardEvent, FormEvent, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { TFunction } from "i18next";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../../app-core/chat/reasoningEffort";
import type { TokenUsage } from "../../app-core/chat/chatTurnContracts";
import { formatFileMetadata } from "./composerFileMetadata";
import {
  AlertCircle,
  Archive,
  ArrowUp,
  Box,
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
  contentHash?: string;
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

export interface ComposerSkillOption {
  description: string;
  id: string;
  label: string;
  sourceLabel: string;
}

export interface ComposerSendOptions {
  model?: string;
  provider?: string;
  reasoningEffort?: ReasoningEffort;
  selectedTools?: string[];
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
  disabled?: boolean;
  disabledReason?: string;
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  placeholder?: string;
  maxFiles?: number;
  files?: ComposerFileReference[];
  onFilesChange?: (files: ComposerFileReference[]) => void;
  onSelectFiles?: () => Promise<ComposerFileSelection[]>;
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
  skillOptions?: readonly ComposerSkillOption[];
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

interface InlineComposerCaret {
  offset: number;
  skillsBefore: number;
}

interface InlineSkillPlacement {
  id: string;
  offset: number;
}

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
  onSendMessage,
  onStopResponding,
  onValueChange,
  placeholder,
  responding = false,
  sendDisabled = false,
  sendDisabledReason,
  selectedSessionMentionIds = EMPTY_SELECTED_IDS,
  selectedSkillIds = EMPTY_SELECTED_IDS,
  sessionMentionOptions = EMPTY_SESSION_MENTIONS,
  skillOptions = EMPTY_SKILLS,
  slashCommands = EMPTY_SLASH_COMMANDS,
  stopUnavailableReason,
  tools = EMPTY_TOOLS,
  value,
}: ClaudeStyleAiInputProps) {
  const { t } = useTranslation("chat");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inlineEditorRef = useRef<HTMLDivElement | null>(null);
  const inlineEditorComposingRef = useRef(false);
  const pendingInlineCaretRef = useRef<InlineComposerCaret | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const toolMenuRef = useRef<HTMLDivElement | null>(null);
  const [message, setMessage] = useState("");
  const [uncontrolledFiles, setUncontrolledFiles] = useState<ComposerFileReference[]>([]);
  const [pastedContent, setPastedContent] = useState<PastedContent[]>([]);
  const [selectedModelId, setSelectedModelId] = useState(defaultModel ?? models[0]?.id ?? "");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<ReasoningEffort>(
    defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT,
  );
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuView, setModelMenuView] = useState<ModelMenuView>("advanced");
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [enabledToolIds, setEnabledToolIds] = useState<string[]>(() => tools.filter((tool) => tool.enabled).map((tool) => tool.id));
  const knownToolIdsRef = useRef(new Set(tools.map((tool) => tool.id)));
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [selectingFiles, setSelectingFiles] = useState(false);
  const [activeSlashCommandIndex, setActiveSlashCommandIndex] = useState(0);
  const [activeSlashStart, setActiveSlashStart] = useState<number | null>(null);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [activeSessionMentionIndex, setActiveSessionMentionIndex] = useState(0);
  const [sessionMentionMenuDismissed, setSessionMentionMenuDismissed] = useState(false);
  const [inlineCaret, setInlineCaret] = useState<InlineComposerCaret>({ offset: 0, skillsBefore: 0 });
  const [inlineSkillPlacements, setInlineSkillPlacements] = useState<InlineSkillPlacement[]>([]);
  const [textareaCaretOffset, setTextareaCaretOffset] = useState(0);
  const slashListboxId = useId();
  const sessionMentionListboxId = useId();
  const currentMessage = value ?? message;
  const files = controlledFiles ?? uncontrolledFiles;
  const filesRef = useRef(files);
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

  useEffect(() => {
    const selectableToolIds = new Set(tools.filter((tool) => !tool.disabled).map((tool) => tool.id));
    const previousToolIds = knownToolIdsRef.current;
    setEnabledToolIds((current) => {
      const next = current.filter((id) => selectableToolIds.has(id));
      for (const tool of tools) {
        if (tool.enabled && !tool.disabled && !previousToolIds.has(tool.id) && !next.includes(tool.id)) {
          next.push(tool.id);
        }
      }
      return next;
    });
    knownToolIdsRef.current = new Set(tools.map((tool) => tool.id));
  }, [tools]);
  const selectedSkillIdSet = useMemo(() => new Set(selectedSkillIds), [selectedSkillIds]);
  const selectedSkills = useMemo(
    () => skillOptions.filter((option) => selectedSkillIdSet.has(option.id)),
    [selectedSkillIdSet, skillOptions],
  );
  const inlineEditorEnabled = skillOptions.length > 0 || selectedSkills.length > 0;
  const visibleInlineSkillPlacements = useMemo(() => {
    const placements = inlineSkillPlacements
      .filter((placement) => selectedSkillIdSet.has(placement.id))
      .map((placement) => ({
        ...placement,
        offset: clampOffset(placement.offset, currentMessage),
      }));
    for (const id of selectedSkillIds) {
      if (!placements.some((placement) => placement.id === id)) {
        placements.push({ id, offset: currentMessage.length });
      }
    }
    return placements;
  }, [currentMessage, inlineSkillPlacements, selectedSkillIdSet, selectedSkillIds]);
  const canSend = !disabled && !sendDisabled && !sending && Boolean(
    currentMessage.trim()
      || files.length
      || pastedContent.length
      || contextReferences.length
      || selectedSessionMentions.length
      || selectedSkills.length,
  );
  const composerCaretOffset = inlineEditorEnabled ? inlineCaret.offset : textareaCaretOffset;
  const slashMatch = useMemo(
    () => slashTriggerMatch(currentMessage, composerCaretOffset, activeSlashStart),
    [activeSlashStart, composerCaretOffset, currentMessage],
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
    () => sessionMentionMatch(currentMessage, composerCaretOffset),
    [composerCaretOffset, currentMessage],
  );
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

  function updateFiles(update: (current: ComposerFileReference[]) => ComposerFileReference[]): void {
    const nextFiles = update(filesRef.current);
    filesRef.current = nextFiles;
    if (controlledFiles === undefined) setUncontrolledFiles(nextFiles);
    else onFilesChange?.(nextFiles);
  }

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

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
    setInlineSkillPlacements((current) => {
      const next = current.filter((placement) => selectedSkillIdSet.has(placement.id));
      return next.length === current.length ? current : next;
    });
  }, [selectedSkillIdSet]);

  useLayoutEffect(() => {
    const editor = inlineEditorRef.current;
    if (!editor) return;
    renderInlineComposerDom(
      editor,
      currentMessage,
      visibleInlineSkillPlacements,
      selectedSkills,
      (skill) => t("composer.remove", { name: skill.label }),
    );
    const pendingCaret = pendingInlineCaretRef.current;
    if (!pendingCaret) return;
    pendingInlineCaretRef.current = null;
    editor.focus();
    restoreInlineComposerCaret(editor, pendingCaret);
  }, [currentMessage, selectedSkills, t, visibleInlineSkillPlacements]);

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
        setActiveSlashStart(null);
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

  async function sendMessage() {
    if (!canSend) {
      return;
    }
    setSending(true);
    setError("");
    try {
      await onSendMessage?.(currentMessage.trim(), files, pastedContent, {
        ...(selectedModel ? { model: selectedModel.modelId || selectedModel.id } : {}),
        ...(selectedModel?.providerId ? { provider: selectedModel.providerId } : {}),
        reasoningEffort: selectedReasoningEffort,
        ...(tools.length ? {
          selectedTools: tools
            .filter((tool) => !tool.disabled && enabledToolIdSet.has(tool.id))
            .map((tool) => tool.id),
        } : {}),
      });
      updateMessage("");
      setActiveSlashStart(null);
      updateFiles(() => []);
      setPastedContent([]);
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

  function updateInlineEditorSelection(): InlineComposerCaret | undefined {
    const editor = inlineEditorRef.current;
    if (!editor) return undefined;
    const caret = readInlineComposerCaret(editor);
    if (!caret) return undefined;
    setInlineCaret((current) => (
      current.offset === caret.offset && current.skillsBefore === caret.skillsBefore ? current : caret
    ));
    updateSlashTrigger(currentMessage, caret.offset);
    return caret;
  }

  function syncInlineEditorInput(): void {
    const editor = inlineEditorRef.current;
    if (!editor) return;
    const content = readInlineComposerContent(editor);
    const caret = readInlineComposerCaret(editor) ?? {
      offset: content.message.length,
      skillsBefore: content.placements.filter((placement) => placement.offset === content.message.length).length,
    };
    const renderedSkillIds = new Set(content.placements.map((placement) => placement.id));
    for (const skill of selectedSkills) {
      if (!renderedSkillIds.has(skill.id)) onRemoveSkill?.(skill.id);
    }
    pendingInlineCaretRef.current = caret;
    setInlineCaret(caret);
    setInlineSkillPlacements(content.placements);
    updateSlashTrigger(content.message, caret.offset);
    updateMessage(content.message);
  }

  function updateSlashTrigger(messageValue: string, caretOffset: number): void {
    const caret = clampOffset(caretOffset, messageValue);
    if (caret > 0 && messageValue[caret - 1] === "/") setSlashMenuDismissed(false);
    setActiveSlashStart((current) => nextSlashTriggerStart(messageValue, caret, current));
  }

  function removeInlineSkill(skillId: string): void {
    const placementIndex = visibleInlineSkillPlacements.findIndex((placement) => placement.id === skillId);
    const placement = visibleInlineSkillPlacements[placementIndex];
    if (!placement) return;
    const skillsBefore = visibleInlineSkillPlacements
      .slice(0, placementIndex)
      .filter((candidate) => candidate.offset === placement.offset)
      .length;
    const caret = { offset: placement.offset, skillsBefore };
    pendingInlineCaretRef.current = caret;
    setInlineCaret(caret);
    setInlineSkillPlacements((current) => current.filter((candidate) => candidate.id !== skillId));
    onRemoveSkill?.(skillId);
  }

  function removeAdjacentInlineSkill(event: KeyboardEvent<HTMLDivElement>): boolean {
    if (event.key !== "Backspace" && event.key !== "Delete") return false;
    const caret = readInlineComposerCaret(event.currentTarget);
    if (!caret) return false;
    const skillsAtCaret = visibleInlineSkillPlacements.filter((placement) => placement.offset === caret.offset);
    const skill = event.key === "Backspace"
      ? skillsAtCaret[caret.skillsBefore - 1]
      : skillsAtCaret[caret.skillsBefore];
    if (!skill) return false;
    event.preventDefault();
    removeInlineSkill(skill.id);
    return true;
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement | HTMLDivElement>) {
    if (event.currentTarget instanceof HTMLDivElement && removeAdjacentInlineSkill(event as KeyboardEvent<HTMLDivElement>)) {
      return;
    }
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
    if (event.key === "Enter" && event.shiftKey && event.currentTarget instanceof HTMLDivElement) {
      event.preventDefault();
      insertPlainTextAtSelection(event.currentTarget, "\n");
      syncInlineEditorInput();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.closest("form")?.requestSubmit();
    }
  }

  function selectSlashOption(option: ComposerSlashMenuOption | undefined) {
    if (!option) return;
    setSlashMenuDismissed(true);
    setActiveSlashStart(null);
    if (option.kind === "skill") {
      if (!slashMatch) return;
      const nextMessage = `${currentMessage.slice(0, slashMatch.start)}${currentMessage.slice(slashMatch.end)}`;
      const nextPlacements = rebaseInlineSkillPlacements(
        visibleInlineSkillPlacements.filter((placement) => placement.id !== option.skill.id),
        slashMatch.start,
        slashMatch.end,
      );
      nextPlacements.push({ id: option.skill.id, offset: slashMatch.start });
      const caret = {
        offset: slashMatch.start,
        skillsBefore: nextPlacements.filter((placement) => placement.offset === slashMatch.start).length,
      };
      pendingInlineCaretRef.current = caret;
      setInlineCaret(caret);
      setInlineSkillPlacements(nextPlacements);
      updateMessage(nextMessage);
      onAddSkill?.(option.skill.id);
      return;
    }
    updateMessage(option.command.prompt);
    if (option.command.submitOnSelect) {
      window.requestAnimationFrame(() => panelRef.current?.closest("form")?.requestSubmit());
      return;
    }
    if (inlineEditorEnabled) {
      const caret = { offset: option.command.prompt.length, skillsBefore: 0 };
      pendingInlineCaretRef.current = caret;
      setInlineCaret(caret);
    } else {
      textareaRef.current?.focus();
    }
  }

  function selectSessionMention(option: ComposerSessionMentionOption | undefined) {
    const match = sessionMentionMatch(currentMessage, composerCaretOffset);
    if (!option || !match) return;
    setSessionMentionMenuDismissed(true);
    const nextMessage = `${currentMessage.slice(0, match.start)}${currentMessage.slice(match.end)}`;
    if (inlineEditorEnabled) {
      const nextPlacements = rebaseInlineSkillPlacements(
        visibleInlineSkillPlacements,
        match.start,
        match.end,
      );
      const caret = {
        offset: match.start,
        skillsBefore: nextPlacements.filter((placement) => placement.offset === match.start).length,
      };
      pendingInlineCaretRef.current = caret;
      setInlineCaret(caret);
      setInlineSkillPlacements(nextPlacements);
    }
    updateMessage(nextMessage);
    onAddSessionMention?.(option.id);
    if (!inlineEditorEnabled) window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement | HTMLDivElement>) {
    const text = event.clipboardData.getData("text");
    if (text.length < PASTE_THRESHOLD) {
      if (event.currentTarget instanceof HTMLDivElement) {
        event.preventDefault();
        insertPlainTextAtSelection(event.currentTarget, text);
        syncInlineEditorInput();
      }
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
      updateFiles((current) => {
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
    updateFiles((current) => current.filter((file) => file.id !== id));
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
      {!error && (disabled || sendDisabled) && (disabledReason || sendDisabledReason) ? (
        <div className="claude-ai-input__notice" role="status">
          <AlertCircle aria-hidden="true" size={15} />
          <span>{disabledReason || sendDisabledReason}</span>
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
            {filteredSlashOptions.map((option, index) => {
              if (option.kind !== "command") return null;
              const { command } = option;
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
                      className="claude-ai-input__slash-option claude-ai-input__slash-option--skill"
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
        {inlineEditorEnabled ? (
          <div
            aria-activedescendant={sessionMentionMenuOpen
              ? `${sessionMentionListboxId}-option-${activeSessionMentionOptionIndex}`
              : slashMenuOpen ? `${slashListboxId}-option-${activeSlashOptionIndex}` : undefined}
            aria-autocomplete="list"
            aria-controls={sessionMentionMenuOpen ? sessionMentionListboxId : slashMenuOpen ? slashListboxId : undefined}
            aria-disabled={disabled || sending}
            aria-expanded={sessionMentionMenuOpen || slashMenuOpen}
            aria-haspopup="listbox"
            aria-label={t("composer.message")}
            aria-multiline="true"
            className="claude-ai-input__textarea claude-ai-input__inline-editor"
            contentEditable={!disabled && !sending}
            data-empty={!currentMessage && !selectedSkills.length}
            data-placeholder={resolvedPlaceholder}
            ref={inlineEditorRef}
            role="textbox"
            spellCheck="true"
            suppressContentEditableWarning
            tabIndex={disabled || sending ? -1 : 0}
            onCompositionEnd={() => {
              inlineEditorComposingRef.current = false;
              syncInlineEditorInput();
            }}
            onCompositionStart={() => {
              inlineEditorComposingRef.current = true;
            }}
            onInput={() => {
              if (!inlineEditorComposingRef.current) syncInlineEditorInput();
            }}
            onKeyDown={handleComposerKeyDown}
            onKeyUp={updateInlineEditorSelection}
            onPaste={handlePaste}
            onPointerUp={updateInlineEditorSelection}
            onClick={(event) => {
              const button = (event.target as Element).closest<HTMLElement>("[data-remove-skill-id]");
              if (button?.dataset.removeSkillId) removeInlineSkill(button.dataset.removeSkillId);
            }}
          />
        ) : (
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
            ref={textareaRef}
            rows={2}
            value={currentMessage}
            onChange={(event) => {
              setTextareaCaretOffset(event.currentTarget.selectionStart);
              updateSlashTrigger(event.currentTarget.value, event.currentTarget.selectionStart);
              updateMessage(event.currentTarget.value);
            }}
            onKeyDown={handleComposerKeyDown}
            onPaste={handlePaste}
            onSelect={(event) => {
              setTextareaCaretOffset(event.currentTarget.selectionStart);
              updateSlashTrigger(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
          />
        )}

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
                  setActiveSlashStart(null);
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
                  setActiveSlashStart(null);
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

function rebaseInlineSkillPlacements(
  placements: readonly InlineSkillPlacement[],
  start: number,
  end: number,
): InlineSkillPlacement[] {
  const removedLength = end - start;
  return placements.map((placement) => {
    if (placement.offset <= start) return placement;
    if (placement.offset >= end) return { ...placement, offset: placement.offset - removedLength };
    return { ...placement, offset: start };
  });
}

function renderInlineComposerDom(
  editor: HTMLDivElement,
  message: string,
  placements: readonly InlineSkillPlacement[],
  skills: readonly ComposerSkillOption[],
  removeLabel: (skill: ComposerSkillOption) => string,
): void {
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const sortedPlacements = placements
    .map((placement, index) => ({ ...placement, index }))
    .sort((left, right) => left.offset - right.offset || left.index - right.index);
  const fragment = document.createDocumentFragment();
  let textOffset = 0;

  for (const placement of sortedPlacements) {
    const skill = skillsById.get(placement.id);
    if (!skill) continue;
    if (placement.offset > textOffset) {
      fragment.append(document.createTextNode(message.slice(textOffset, placement.offset)));
    }

    const token = document.createElement("span");
    token.className = "claude-ai-input__inline-skill";
    token.contentEditable = "false";
    token.dataset.composerSkillId = skill.id;
    token.title = `${skill.label} · ${skill.description} · ${skill.sourceLabel}`;
    token.append(createInlineSkillIcon());

    const label = document.createElement("span");
    label.textContent = skill.label;
    token.append(label);

    const remove = document.createElement("button");
    remove.setAttribute("aria-label", removeLabel(skill));
    remove.dataset.removeSkillId = skill.id;
    remove.type = "button";
    remove.append(createInlineSkillRemoveIcon());
    token.append(remove);
    fragment.append(token);
    textOffset = placement.offset;
  }

  if (textOffset < message.length) fragment.append(document.createTextNode(message.slice(textOffset)));
  editor.replaceChildren(fragment);
}

function createInlineSkillIcon(): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("fill", "none");
  icon.setAttribute("height", "13");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "13");
  for (const points of ["21 16 21 8 12 3 3 8 3 16 12 21 21 16", "3.3 7 12 12 20.7 7", "12 22 12 12"]) {
    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.setAttribute("points", points);
    icon.append(polyline);
  }
  return icon;
}

function createInlineSkillRemoveIcon(): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("fill", "none");
  icon.setAttribute("height", "11");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "11");
  for (const [x1, y1, x2, y2] of [[6, 6, 18, 18], [18, 6, 6, 18]]) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y1", String(y1));
    line.setAttribute("y2", String(y2));
    icon.append(line);
  }
  return icon;
}

function readInlineComposerContent(root: Node): {
  message: string;
  placements: InlineSkillPlacement[];
} {
  let message = "";
  const placements: InlineSkillPlacement[] = [];

  function visit(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      message += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : undefined;
    const skillId = element?.dataset.composerSkillId;
    if (skillId) {
      placements.push({ id: skillId, offset: message.length });
      return;
    }
    if (element?.tagName === "BR") {
      message += "\n";
      return;
    }
    for (const child of node.childNodes) visit(child);
  }

  visit(root);
  return { message, placements };
}

function readInlineComposerCaret(editor: HTMLDivElement): InlineComposerCaret | undefined {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return undefined;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !editor.contains(range.endContainer)) return undefined;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(editor);
  prefix.setEnd(range.endContainer, range.endOffset);
  const content = readInlineComposerContent(prefix.cloneContents());
  return {
    offset: content.message.length,
    skillsBefore: content.placements.filter((placement) => placement.offset === content.message.length).length,
  };
}

function restoreInlineComposerCaret(editor: HTMLDivElement, caret: InlineComposerCaret): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  let textOffset = 0;
  let skillsAtOffset = 0;

  function placeAtEditorBoundary(index: number): void {
    range.setStart(editor, index);
    range.collapse(true);
  }

  function placeInText(node: Node, offset: number): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
      range.setStart(node, Math.min(offset, node.textContent?.length ?? 0));
      range.collapse(true);
      return true;
    }
    let remaining = offset;
    for (const child of node.childNodes) {
      const length = readInlineComposerContent(child).message.length;
      if (remaining <= length && placeInText(child, remaining)) return true;
      remaining -= length;
    }
    return false;
  }

  let placed = false;
  for (const [index, child] of [...editor.childNodes].entries()) {
    const element = child.nodeType === Node.ELEMENT_NODE ? child as HTMLElement : undefined;
    if (element?.dataset.composerSkillId) {
      if (textOffset === caret.offset && skillsAtOffset === caret.skillsBefore) {
        placeAtEditorBoundary(index);
        placed = true;
        break;
      }
      if (textOffset === caret.offset) skillsAtOffset += 1;
      if (textOffset === caret.offset && skillsAtOffset === caret.skillsBefore) {
        placeAtEditorBoundary(index + 1);
        placed = true;
        break;
      }
      continue;
    }

    const textLength = readInlineComposerContent(child).message.length;
    const textEnd = textOffset + textLength;
    const atTextStart = caret.offset === textOffset && caret.skillsBefore === skillsAtOffset;
    const insideText = caret.offset > textOffset && caret.offset < textEnd;
    const atTextEnd = caret.offset === textEnd && caret.skillsBefore === 0;
    if ((atTextStart || insideText || atTextEnd) && placeInText(child, caret.offset - textOffset)) {
      placed = true;
      break;
    }
    textOffset = textEnd;
    skillsAtOffset = 0;
  }
  if (!placed) placeAtEditorBoundary(editor.childNodes.length);
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertPlainTextAtSelection(editor: HTMLDivElement, text: string): void {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  if (!selection || !range || !editor.contains(range.commonAncestorContainer)) {
    editor.append(document.createTextNode(text));
    return;
  }
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
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

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
