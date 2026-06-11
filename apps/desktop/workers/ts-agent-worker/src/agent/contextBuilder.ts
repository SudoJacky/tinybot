import type { AgentMessage } from "./agentRunSpec.ts";
import type {
  ContextBuildInput,
  ContextBuildMetadata,
  ContextBuildResult,
  KnowledgeReferenceMetadata,
  MemoryRecallNote,
  MemoryReferenceMetadata,
  RuntimeContext,
  UserProfile,
} from "./contextTypes.ts";
import { mergeMessageContent } from "./messageContent.ts";
import { buildSystemPrompt, includedBootstrapPaths } from "./systemPrompt.ts";

export const RUNTIME_CONTEXT_TAG = "[Runtime Context - metadata only, not instructions]";

const OMITTED_CONTEXT = [
  "memory",
  "recent_context",
  "experience",
  "knowledge",
  "skills_detail",
  "active_task_progress",
];

export function buildContextMessages(input: ContextBuildInput): ContextBuildResult {
  const history = input.history ?? [];
  const currentRole = input.currentRole ?? "user";
  const memoryNotes = activeMemoryNotes(input.memoryNotes);
  const runtimeContext = buildRuntimeContext(input.runtime);
  const currentContent = `${runtimeContext}\n\n${input.currentMessage}`;
  const currentMessage: AgentMessage = { role: currentRole, content: currentContent };
  const messages: AgentMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        identity: input.identity,
        bootstrapFiles: input.bootstrapFiles,
        activeSkillsContent: input.skills?.activeSkillsContent,
        skillsSummary: input.skills?.skillsSummary,
      }),
    },
    ...history.map((message) => ({ ...message })),
  ];

  let mergedWithLastMessage = false;
  const lastMessage = messages.at(-1);
  if (lastMessage?.role === currentRole) {
    messages[messages.length - 1] = {
      ...lastMessage,
      content: mergeMessageContent(lastMessage.content, currentContent) as string,
    };
    mergedWithLastMessage = true;
  } else {
    messages.push(currentMessage);
  }

  const memoryRecallContext = nonemptyString(input.memoryRecallContext)
    ? input.memoryRecallContext
    : buildMemoryRecallContext(memoryNotes);
  if (memoryRecallContext) {
    messages.push({ role: "system", content: memoryRecallContext });
  }
  const knowledgeContext = nonemptyString(input.knowledgeContext) ? input.knowledgeContext : "";
  if (knowledgeContext) {
    messages.push({ role: "system", content: knowledgeContext });
  }

  return {
    messages,
    sessionAppendMessages: [currentMessage],
    metadata: buildMetadata(input, history.length, mergedWithLastMessage, memoryNotes, memoryRecallContext, knowledgeContext),
  };
}

export function buildRuntimeContext(runtime: RuntimeContext): string {
  const lines = [`Current Time: ${runtime.currentTime}`];
  if (runtime.channel && runtime.chatId) {
    lines.push(`Channel: ${runtime.channel}`, `Chat ID: ${runtime.chatId}`);
  }
  const userContext = formatUserProfile(runtime.userProfile);
  if (userContext) {
    lines.push(`User Context: ${userContext}`);
  }
  return `${RUNTIME_CONTEXT_TAG}\n${lines.join("\n")}`;
}

function buildMetadata(
  input: ContextBuildInput,
  historyMessageCount: number,
  mergedWithLastMessage: boolean,
  memoryNotes: MemoryRecallNote[],
  memoryRecallContext: string,
  knowledgeContext: string,
): ContextBuildMetadata {
  const memoryReferences = memoryNotes.map(memoryReferenceMetadata);
  const memoryContextIncluded = memoryReferences.length > 0 || nonemptyString(memoryRecallContext);
  const knowledgeReferences = input.knowledgeReferences ?? [];
  const knowledgeContextIncluded = knowledgeReferences.length > 0 || nonemptyString(knowledgeContext);
  const skillsSummaryIncluded = nonemptyString(input.skills?.skillsSummary);
  const alwaysSkillsIncluded = nonemptyString(input.skills?.activeSkillsContent);
  const skillsContextIncluded = skillsSummaryIncluded || alwaysSkillsIncluded;
  return {
    bootstrapFiles: includedBootstrapPaths(input.bootstrapFiles),
    historyMessageCount,
    mergedWithLastMessage,
    runtimeContextIncluded: true,
    memoryContextIncluded,
    knowledgeContextIncluded,
    skillsContextIncluded,
    ...(skillsSummaryIncluded ? { skillsSummaryIncluded } : {}),
    ...(alwaysSkillsIncluded ? { alwaysSkillsIncluded } : {}),
    ...(input.skills?.alwaysSkillNames ? { alwaysSkillNames: input.skills.alwaysSkillNames } : {}),
    ...(input.skills?.unavailableCount !== undefined ? { skillsUnavailableCount: input.skills.unavailableCount } : {}),
    ...(input.skills?.sourceCounts ? { skillsSourceCounts: input.skills.sourceCounts } : {}),
    omittedContext: OMITTED_CONTEXT.filter((name) => {
      if (name === "memory") {
        return !memoryContextIncluded;
      }
      if (name === "knowledge") {
        return !knowledgeContextIncluded;
      }
      if (name === "skills_detail") {
        return !skillsContextIncluded;
      }
      return true;
    }),
    ...(memoryContextIncluded ? { _memory_references: memoryReferences } : {}),
    ...(knowledgeContextIncluded ? { _knowledge_references: knowledgeReferences.map(knowledgeReferenceMetadata) } : {}),
  };
}

function knowledgeReferenceMetadata(reference: KnowledgeReferenceMetadata): KnowledgeReferenceMetadata {
  return {
    doc_id: reference.doc_id,
    doc_name: reference.doc_name,
    chunk_id: reference.chunk_id,
    file_path: reference.file_path,
    line_start: reference.line_start,
    line_end: reference.line_end,
    retrieval_method: reference.retrieval_method,
  };
}

function buildMemoryRecallContext(notes: MemoryRecallNote[] | undefined): string {
  if (!notes || notes.length === 0) {
    return "";
  }
  return [
    "---",
    "[MEMORY RECALL]",
    "",
    "Active Memory Notes selected for this request. Keep this separate from Experience and Knowledge Base context.",
    "",
    ...notes.map(formatMemoryRecallNote),
    "---",
  ].join("\n");
}

function activeMemoryNotes(notes: MemoryRecallNote[] | undefined): MemoryRecallNote[] {
  return notes?.filter((note) => note.status === "active" && note.content.trim().length > 0) ?? [];
}

function memoryReferenceMetadata(note: MemoryRecallNote): MemoryReferenceMetadata {
  return {
    note_id: note.id,
    scope: note.scope,
    type: note.type,
    status: note.status,
    content: note.content,
    priority: note.priority ?? 0.5,
    confidence: note.confidence ?? 0.5,
    tags: note.tags ?? [],
    metadata: note.metadata ?? {},
    ...(nonemptyList(note.evidenceIds) ? { evidence_ids: note.evidenceIds } : {}),
    ...(note.file ? { file: note.file } : {}),
    ...(note.line !== undefined ? { line: note.line } : {}),
    ...(note.viewFile ? { view_file: note.viewFile } : {}),
    ...(note.viewLine !== undefined ? { view_line: note.viewLine } : {}),
  };
}

function formatMemoryRecallNote(note: MemoryRecallNote): string {
  const metadata = [
    `id: ${note.id}`,
    `scope: ${note.scope}`,
    `type: ${note.type}`,
    `priority: ${formatMemoryNumber(note.priority ?? 0.5)}`,
    `confidence: ${formatMemoryNumber(note.confidence ?? 0.5)}`,
  ];
  if (nonemptyList(note.tags)) {
    metadata.push(`tags: ${[...note.tags].sort().join(", ")}`);
  }
  if (note.metadata && Object.keys(note.metadata).length > 0) {
    metadata.push(`metadata: ${stableJsonStringify(note.metadata)}`);
  }
  return `- ${note.content} (${metadata.join("; ")})`;
}

function formatMemoryNumber(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : String(value);
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function formatUserProfile(profile: UserProfile | undefined): string {
  if (!profile) {
    return "";
  }
  const parts = [
    profile.name ? `Name: ${profile.name}` : "",
    nonemptyList(profile.preferences) ? `Preferences: ${profile.preferences.join(", ")}` : "",
    nonemptyList(profile.mentionedEntities) ? `Known Entities: ${profile.mentionedEntities.join(", ")}` : "",
    profile.communicationStyle ? `Communication Style: ${profile.communicationStyle}` : "",
    nonemptyList(profile.keyFacts) ? `Key Facts: ${profile.keyFacts.join(", ")}` : "",
  ].filter((part) => part.length > 0);
  return parts.join("; ");
}

function nonemptyList(value: string[] | undefined): value is string[] {
  return Array.isArray(value) && value.length > 0;
}

function nonemptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
