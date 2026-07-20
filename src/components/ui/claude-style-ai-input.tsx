"use client";

import type { ChangeEvent, ClipboardEvent, FormEvent, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TokenUsage } from "../../app-core/chat/chatRunModel";
import {
  AlertCircle,
  Archive,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  FileText,
  ImageIcon,
  Music,
  Plus,
  SlidersHorizontal,
  Square,
  TerminalSquare,
  Video,
  X,
} from "lucide-react";

export interface FileWithPreview {
  id: string;
  file: File;
  preview?: string;
  type: string;
  uploadStatus: "pending" | "uploading" | "complete" | "error";
  uploadProgress?: number;
  abortController?: AbortController;
  textContent?: string;
}

export interface PastedContent {
  id: string;
  content: string;
  timestamp: Date;
  wordCount: number;
}

export interface ModelOption {
  id: string;
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

export interface ComposerSendOptions {
  model?: string;
}

export interface ComposerContextReference {
  detail: string;
  id: string;
  kind: "file" | "terminal" | "reference";
  label: string;
}

export interface ClaudeStyleAiInputProps {
  className?: string;
  contextReferences?: ComposerContextReference[];
  onSendMessage?: (
    message: string,
    files: FileWithPreview[],
    pastedContent: PastedContent[],
    options: ComposerSendOptions,
  ) => void | Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
  placeholder?: string;
  maxFiles?: number;
  maxFileSize?: number;
  acceptedFileTypes?: string[];
  models?: ModelOption[];
  defaultModel?: string;
  onModelChange?: (modelId: string) => void;
  onClearContextReferences?: () => void;
  onRemoveContextReference?: (id: string) => void;
  contextUsage?: TokenUsage;
  tools?: ComposerToolOption[];
  responding?: boolean;
  canStopResponding?: boolean;
  stopUnavailableReason?: string;
  onStopResponding?: () => void | Promise<void>;
  value?: string;
  onValueChange?: (value: string) => void;
}

const MAX_FILES = 10;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const PASTE_THRESHOLD = 200;
const EMPTY_MODELS: ModelOption[] = [];
const EMPTY_TOOLS: ComposerToolOption[] = [];

let generatedId = 0;

function nextInputId(prefix: string): string {
  generatedId += 1;
  return `${prefix}-${generatedId}`;
}

export function ClaudeStyleAiInput({
  acceptedFileTypes = [],
  canStopResponding = true,
  className,
  contextReferences = [],
  contextUsage,
  defaultModel,
  disabled = false,
  disabledReason,
  maxFileSize = MAX_FILE_SIZE,
  maxFiles = MAX_FILES,
  models = EMPTY_MODELS,
  onModelChange,
  onClearContextReferences,
  onRemoveContextReference,
  onSendMessage,
  onStopResponding,
  onValueChange,
  placeholder = "Message Tinybot",
  responding = false,
  stopUnavailableReason,
  tools = EMPTY_TOOLS,
  value,
}: ClaudeStyleAiInputProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const toolMenuRef = useRef<HTMLDivElement | null>(null);
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<FileWithPreview[]>([]);
  const [pastedContent, setPastedContent] = useState<PastedContent[]>([]);
  const [selectedModelId, setSelectedModelId] = useState(defaultModel ?? models[0]?.id ?? "");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [enabledToolIds, setEnabledToolIds] = useState<string[]>(() => tools.filter((tool) => tool.enabled).map((tool) => tool.id));
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const currentMessage = value ?? message;
  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? models[0],
    [models, selectedModelId],
  );
  const contextUsageView = useMemo(() => buildContextUsageView(contextUsage), [contextUsage]);
  const enabledToolIdSet = useMemo(() => new Set(enabledToolIds), [enabledToolIds]);
  const canSend = !disabled && !sending && Boolean(currentMessage.trim() || files.length || pastedContent.length || contextReferences.length);

  function updateMessage(nextMessage: string): void {
    setMessage(nextMessage);
    onValueChange?.(nextMessage);
  }

  useEffect(() => {
    const nextModelId = defaultModel || models[0]?.id || "";
    setSelectedModelId((current) => {
      if (current && models.some((model) => model.id === current)) {
        return current;
      }
      return nextModelId;
    });
  }, [defaultModel, models]);

  useEffect(() => {
    setEnabledToolIds(tools.filter((tool) => tool.enabled).map((tool) => tool.id));
  }, [tools]);

  useEffect(() => {
    if (!modelMenuOpen && !toolMenuOpen) {
      return;
    }
    function closeMenus(event: PointerEvent) {
      const target = event.target as Node;
      if (!modelMenuRef.current?.contains(target)) {
        setModelMenuOpen(false);
      }
      if (!toolMenuRef.current?.contains(target)) {
        setToolMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeMenus, true);
    return () => document.removeEventListener("pointerdown", closeMenus, true);
  }, [modelMenuOpen, toolMenuOpen]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend) {
      return;
    }
    setSending(true);
    setError("");
    try {
      await onSendMessage?.(currentMessage.trim(), files, pastedContent, {
        ...(selectedModel?.id ? { model: selectedModel.id } : {}),
      });
      updateMessage("");
      setFiles([]);
      setPastedContent([]);
      onClearContextReferences?.();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Message could not be sent.");
    } finally {
      setSending(false);
    }
  }

  async function handleStopResponding() {
    setError("");
    try {
      await onStopResponding?.();
    } catch {
      setError("Generation could not be stopped.");
    }
  }

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
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

  function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.currentTarget.files ?? []);
    if (!selectedFiles.length) {
      return;
    }
    setError("");
    setFiles((current) => {
      const remainingSlots = Math.max(0, maxFiles - current.length);
      const nextFiles: FileWithPreview[] = [];
      for (const file of selectedFiles.slice(0, remainingSlots)) {
        if (file.size > maxFileSize) {
          setError(`${file.name} is larger than ${formatFileSize(maxFileSize)}.`);
          continue;
        }
        if (!fileMatchesAcceptedTypes(file, acceptedFileTypes)) {
          setError(`${file.name} is not an accepted file type.`);
          continue;
        }
        nextFiles.push({
          id: nextInputId("file"),
          file,
          type: file.type || inferTypeFromName(file.name),
          uploadStatus: "complete",
          uploadProgress: 100,
        });
      }
      if (selectedFiles.length > remainingSlots) {
        setError(`Only ${maxFiles} files can be attached.`);
      }
      return [...current, ...nextFiles];
    });
    event.currentTarget.value = "";
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
    onModelChange?.(modelId);
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
      aria-label="Message composer"
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
      {files.length || pastedContent.length || contextReferences.length ? (
        <div className="claude-ai-input__attachments" aria-label="Composer attachments">
          {contextReferences.map((reference) => (
            <AttachmentChip
              detail={reference.detail}
              icon={reference.kind === "terminal" ? <TerminalSquare aria-hidden="true" size={16} /> : <FileText aria-hidden="true" size={16} />}
              key={reference.id}
              label={reference.label}
              onRemove={() => onRemoveContextReference?.(reference.id)}
              removeLabel={`Remove ${reference.label}`}
            />
          ))}
          {pastedContent.map((item) => (
            <AttachmentChip
              detail={`${item.wordCount} words`}
              icon={<Copy aria-hidden="true" size={16} />}
              key={item.id}
              label="Pasted text"
              onRemove={() => removePastedContent(item.id)}
              removeLabel="Remove pasted content"
            />
          ))}
          {files.map((item) => (
            <AttachmentChip
              detail={`${getFileTypeLabel(item.type)} - ${formatFileSize(item.file.size)}`}
              icon={getFileIcon(item.type)}
              key={item.id}
              label={item.file.name}
              onRemove={() => removeFile(item.id)}
              removeLabel={`Remove ${item.file.name}`}
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
        <textarea
          aria-label="Message"
          className="claude-ai-input__textarea"
          disabled={disabled || sending}
          placeholder={placeholder}
          rows={2}
          value={currentMessage}
          onChange={(event) => updateMessage(event.currentTarget.value)}
          onKeyDown={handleTextareaKeyDown}
          onPaste={handlePaste}
        />

        <div className="claude-ai-input__toolbar">
          <div className="claude-ai-input__tools">
            <input
              ref={fileInputRef}
              aria-label="File attachments"
              className="claude-ai-input__file-input"
              multiple
              type="file"
              accept={acceptedFileTypes.join(",") || undefined}
              onChange={handleFilesSelected}
            />
            <button
              aria-label="Attach files"
              className="claude-ai-input__icon-button"
              disabled={disabled || files.length >= maxFiles}
              title="Attach files"
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus aria-hidden="true" size={18} />
            </button>
            <div ref={toolMenuRef} className="claude-ai-input__tool">
              <button
                aria-expanded={toolMenuOpen}
                aria-haspopup="menu"
                aria-label="Tools"
                className="claude-ai-input__icon-button"
                disabled={disabled || !tools.length}
                title="Tools"
                type="button"
                onClick={() => {
                  setToolMenuOpen((open) => !open);
                  setModelMenuOpen(false);
                }}
              >
                <SlidersHorizontal aria-hidden="true" size={18} />
              </button>
              {toolMenuOpen ? (
                <div className="claude-ai-input__tool-menu" role="menu" aria-label="Tools">
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
                        <em>{checked ? "On" : "Off"}</em>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            <div ref={modelMenuRef} className="claude-ai-input__model">
              <button
                aria-expanded={modelMenuOpen}
                aria-haspopup="listbox"
                aria-label="Select model"
                className="claude-ai-input__model-trigger"
                disabled={disabled || !models.length}
                type="button"
                onClick={() => {
                  setModelMenuOpen((open) => !open);
                  setToolMenuOpen(false);
                }}
              >
                <span>{selectedModel?.name ?? "Model"}</span>
                <ChevronDown aria-hidden="true" size={16} />
              </button>
              {modelMenuOpen ? (
                <div className="claude-ai-input__model-menu" role="listbox" aria-label="Models">
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
              ) : null}
            </div>
            {contextUsageView ? <ContextUsageIndicator view={contextUsageView} /> : null}
          </div>

          {responding ? (
            <button
              aria-label={canStopResponding ? "Stop generation" : `Stop generation unavailable: ${stopUnavailableReason || "unsupported"}`}
              className="claude-ai-input__send"
              disabled={disabled || !canStopResponding}
              title={canStopResponding ? "Stop generation" : stopUnavailableReason || "Stopping is unavailable"}
              type="button"
              onClick={() => void handleStopResponding()}
            >
              <Square aria-hidden="true" size={15} />
            </button>
          ) : (
            <button
              aria-label="Send message"
              className="claude-ai-input__send"
              disabled={!canSend}
              title={canSend ? "Send message" : disabledReason || "输入内容后发送"}
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
        <strong>Context window</strong>
        <span>{view.percent}% used ({view.leftPercent}% left)</span>
        <span>{view.tokenLabel}</span>
        {view.strategy ? <span>Strategy: {view.strategy}</span> : null}
      </span>
    </div>
  );
}

function buildContextUsageView(usage: TokenUsage | undefined): ContextUsageView | undefined {
  if (!usage) {
    return {
      ariaLabel: "Context window 0% used, 100% left",
      leftPercent: 100,
      percent: 0,
      state: "normal",
      tokenLabel: "0 tokens used",
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
    ? `${formatTokenCount(usedTokens)} / ${formatTokenCount(windowTokens)} tokens used`
    : "Token budget reported by provider";
  return {
    ariaLabel: `Context window ${percent}% used, ${leftPercent}% left`,
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

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function inferTypeFromName(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase();
  return extension ? `.${extension}` : "application/octet-stream";
}

function fileMatchesAcceptedTypes(file: File, acceptedFileTypes: string[]): boolean {
  if (!acceptedFileTypes.length) {
    return true;
  }
  const lowerName = file.name.toLowerCase();
  return acceptedFileTypes.some((acceptedType) => {
    const normalized = acceptedType.toLowerCase();
    if (normalized.endsWith("/*")) {
      return file.type.toLowerCase().startsWith(normalized.slice(0, -1));
    }
    if (normalized.startsWith(".")) {
      return lowerName.endsWith(normalized);
    }
    return file.type.toLowerCase() === normalized;
  });
}
