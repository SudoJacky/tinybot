"use client";

import type { ChangeEvent, ClipboardEvent, FormEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
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

export interface ClaudeStyleAiInputProps {
  className?: string;
  onSendMessage?: (
    message: string,
    files: FileWithPreview[],
    pastedContent: PastedContent[],
  ) => void | Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  maxFiles?: number;
  maxFileSize?: number;
  acceptedFileTypes?: string[];
  models?: ModelOption[];
  defaultModel?: string;
  onModelChange?: (modelId: string) => void;
}

const MAX_FILES = 10;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const PASTE_THRESHOLD = 200;
const DEFAULT_MODELS_INTERNAL: ModelOption[] = [
  {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    description: "Balanced model",
    badge: "Latest",
  },
  {
    id: "claude-opus-3.5",
    name: "Claude Opus 3.5",
    description: "Highest intelligence",
  },
  {
    id: "claude-haiku-3",
    name: "Claude Haiku 3",
    description: "Fastest responses",
  },
];

let generatedId = 0;

function nextInputId(prefix: string): string {
  generatedId += 1;
  return `${prefix}-${generatedId}`;
}

export function ClaudeStyleAiInput({
  acceptedFileTypes = [],
  className,
  defaultModel,
  disabled = false,
  maxFileSize = MAX_FILE_SIZE,
  maxFiles = MAX_FILES,
  models = DEFAULT_MODELS_INTERNAL,
  onModelChange,
  onSendMessage,
  placeholder = "Message Tinybot",
}: ClaudeStyleAiInputProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<FileWithPreview[]>([]);
  const [pastedContent, setPastedContent] = useState<PastedContent[]>([]);
  const [selectedModelId, setSelectedModelId] = useState(defaultModel ?? models[0]?.id ?? "");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? models[0],
    [models, selectedModelId],
  );
  const canSend = !disabled && !sending && Boolean(message.trim() || files.length || pastedContent.length);

  useEffect(() => {
    if (defaultModel) {
      setSelectedModelId(defaultModel);
    }
  }, [defaultModel]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend) {
      return;
    }
    setSending(true);
    setError("");
    try {
      await onSendMessage?.(message.trim(), files, pastedContent);
      setMessage("");
      setFiles([]);
      setPastedContent([]);
    } catch {
      setError("Message could not be sent.");
    } finally {
      setSending(false);
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

      {files.length || pastedContent.length ? (
        <div className="claude-ai-input__attachments" aria-label="Composer attachments">
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
              detail={`${getFileTypeLabel(item.type)} · ${formatFileSize(item.file.size)}`}
              icon={getFileIcon(item.type)}
              key={item.id}
              label={item.file.name}
              onRemove={() => removeFile(item.id)}
              removeLabel={`Remove ${item.file.name}`}
            />
          ))}
        </div>
      ) : null}

      <div className="claude-ai-input__panel">
        <textarea
          aria-label="Message"
          className="claude-ai-input__textarea"
          disabled={disabled || sending}
          placeholder={placeholder}
          rows={2}
          value={message}
          onChange={(event) => setMessage(event.currentTarget.value)}
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
            <button
              aria-label="Model settings"
              className="claude-ai-input__icon-button"
              disabled={disabled}
              title="Model settings"
              type="button"
            >
              <SlidersHorizontal aria-hidden="true" size={18} />
            </button>
            <div className="claude-ai-input__model">
              <button
                aria-expanded={modelMenuOpen}
                aria-haspopup="listbox"
                aria-label="Select model"
                className="claude-ai-input__model-trigger"
                disabled={disabled}
                type="button"
                onClick={() => setModelMenuOpen((open) => !open)}
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
          </div>

          <button
            aria-label="Send message"
            className="claude-ai-input__send"
            disabled={!canSend}
            title="Send message"
            type="submit"
          >
            <ArrowUp aria-hidden="true" size={18} />
          </button>
        </div>
      </div>
    </form>
  );
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
