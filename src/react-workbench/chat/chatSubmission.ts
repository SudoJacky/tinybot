import type { TFunction } from "i18next";
import type { AgentInputReference } from "../../app-core/chat/agentInputReference";
import type { DesktopChatInput } from "../../app-core/chat/desktopCommand";
import { submitComposerText } from "../../app-core/chat/chatInputState";
import type { QueuedInput } from "../../app-core/chat/chatUiProjection";
import type {
  ComposerFileReference,
  ComposerSendOptions,
  PastedContent,
} from "../../components/ui/claude-style-ai-input";
import { formatFileMetadata } from "../../components/ui/composerFileMetadata";

export const MAX_COMPOSER_SESSION_REFERENCES = 4;
const MAX_COMPOSER_SESSION_CONTEXT_BYTES = 48 * 1024;
const SESSION_TRANSCRIPT_OMISSION = "\n\n[... middle conversation content omitted to fit the context limit ...]\n\n";

export type ComposerMentionedSession = {
  id: string;
  title: string;
  updatedAtMs: number;
};

export type QueuedComposerInput = QueuedInput & { turnInput: DesktopChatInput };

export type PreparedChatSubmission =
  | { kind: "compact" }
  | { kind: "empty" }
  | { kind: "queue_limit_reached" }
  | { input: QueuedComposerInput; kind: "queue_input"; visibleText: string }
  | { kind: "send_message"; turnInput: DesktopChatInput; visibleText: string };

export type PrepareChatSubmissionInput = {
  availableSessionIds: ReadonlySet<string>;
  files: readonly ComposerFileReference[];
  isRunning: boolean;
  loadSessionTranscript: (sessionId: string) => Promise<string>;
  message: string;
  now: () => string;
  options: ComposerSendOptions;
  pastedContent: readonly PastedContent[];
  queuedInputs: readonly QueuedInput[];
  selectedSessionIds: readonly string[];
  sessions: readonly ComposerMentionedSession[];
  t: TFunction<"chat">;
};

export async function prepareChatSubmission(
  input: PrepareChatSubmissionInput,
): Promise<PreparedChatSubmission> {
  const compactRequested = input.message.trim() === "/compact";
  if (compactRequested) {
    if (
      input.files.length
      || input.pastedContent.length
      || input.selectedSessionIds.length
    ) {
      throw new Error(input.t("errors.compactWithAttachments"));
    }
    return { kind: "compact" };
  }

  const mentionedSessions = input.selectedSessionIds.map((sessionId) => {
    const session = input.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || !input.availableSessionIds.has(sessionId)) {
      throw new Error(input.t("composer.sessionMention.unavailable"));
    }
    return session;
  });
  const references = [
    ...input.files.map(nativeReferenceFromComposerFile),
    ...await nativeReferencesFromComposerSessions(
      mentionedSessions,
      input.loadSessionTranscript,
      input.t,
    ),
  ];
  const fallbackMessage = input.files.length
    ? input.t("composer.attachedFilesPrompt")
    : mentionedSessions.length
      ? input.t("composer.sessionMention.attachedPrompt")
      : "";
  const visibleText = formatComposerMessage(
    input.message || fallbackMessage,
    input.pastedContent,
    input.t,
  );
  if (!visibleText) return { kind: "empty" };

  const queuedResult = submitComposerText({
    content: visibleText,
    isRunning: input.isRunning,
    now: input.now(),
    queuedInputs: [...input.queuedInputs],
  });
  if (queuedResult.kind === "queue_limit_reached") {
    return { kind: "queue_limit_reached" };
  }
  const content = queuedResult.kind === "send_message"
    ? queuedResult.content
    : queuedResult.input.content;
  const turnInput = createComposerChatInput(content, input.options, references);
  if (queuedResult.kind === "queue_input") {
    return {
      input: { ...queuedResult.input, turnInput },
      kind: "queue_input",
      visibleText,
    };
  }
  return { kind: "send_message", turnInput, visibleText };
}

function createComposerChatInput(
  text: string,
  options: ComposerSendOptions,
  references: AgentInputReference[],
): DesktopChatInput {
  return {
    text,
    ...(options.model ? { model: options.model } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(references.length ? { references } : {}),
  };
}

function nativeReferenceFromComposerFile(file: ComposerFileReference): AgentInputReference {
  const managedImage = file.mimeType.startsWith("image/") && Boolean(file.contentHash);
  return {
    ...(managedImage && file.contentHash ? {
      contentHash: file.contentHash,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
    } : {}),
    detail: formatFileMetadata(file.mimeType, file.sizeBytes),
    kind: "reference",
    rawPath: file.path,
    title: file.name,
    type: managedImage ? "tinyos.image" : "tinyos.file",
  };
}

async function nativeReferencesFromComposerSessions(
  sessions: readonly ComposerMentionedSession[],
  loadTranscript: (sessionId: string) => Promise<string>,
  t: TFunction<"chat">,
): Promise<AgentInputReference[]> {
  const selected = sessions.slice(0, MAX_COMPOSER_SESSION_REFERENCES);
  if (!selected.length) return [];
  const transcriptBudget = Math.floor(MAX_COMPOSER_SESSION_CONTEXT_BYTES / selected.length);
  return Promise.all(selected.map(async (session) => {
    let transcript: string;
    try {
      transcript = await loadTranscript(session.id);
    } catch (error) {
      console.error("[chat-submission] session-reference.load.failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: session.id,
      });
      throw error;
    }
    return {
      detail: t("composer.sessionMention.referenceDetail"),
      kind: "reference" as const,
      revision: String(session.updatedAtMs),
      scope: session.id,
      sourceText: truncateUtf8Middle(
        transcript || t("composer.sessionMention.emptyTranscript"),
        transcriptBudget,
      ),
      title: session.title,
      type: "tinyos.thread",
    };
  }));
}

function truncateUtf8Middle(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const markerBytes = encoder.encode(SESSION_TRANSCRIPT_OMISSION).byteLength;
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  const prefixBudget = Math.floor(contentBudget / 3);
  const suffixBudget = contentBudget - prefixBudget;
  return `${utf8Prefix(value, prefixBudget, encoder)}${SESSION_TRANSCRIPT_OMISSION}${utf8Suffix(value, suffixBudget, encoder)}`;
}

function utf8Prefix(value: string, maxBytes: number, encoder: TextEncoder): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const nextBytes = encoder.encode(character).byteLength;
    if (bytes + nextBytes > maxBytes) break;
    output += character;
    bytes += nextBytes;
  }
  return output;
}

function utf8Suffix(value: string, maxBytes: number, encoder: TextEncoder): string {
  const output: string[] = [];
  let bytes = 0;
  for (const character of Array.from(value).reverse()) {
    const nextBytes = encoder.encode(character).byteLength;
    if (bytes + nextBytes > maxBytes) break;
    output.push(character);
    bytes += nextBytes;
  }
  return output.reverse().join("");
}

function formatComposerMessage(
  message: string,
  pastedContent: readonly PastedContent[],
  t: TFunction<"chat">,
): string {
  const segments = [message.trim()].filter(Boolean);
  for (const pasted of pastedContent) {
    segments.push(`${t("composer.pastedContentLabel")}:\n${pasted.content}`);
  }
  return segments.join("\n\n");
}
