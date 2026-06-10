import type { AgentMessage } from "./agentRunSpec.ts";
import type { ContextBuildInput, ContextBuildMetadata, ContextBuildResult, RuntimeContext, UserProfile } from "./contextTypes.ts";
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
  const runtimeContext = buildRuntimeContext(input.runtime);
  const currentContent = `${runtimeContext}\n\n${input.currentMessage}`;
  const messages: AgentMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        identity: input.identity,
        bootstrapFiles: input.bootstrapFiles,
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
    messages.push({ role: currentRole, content: currentContent });
  }

  return {
    messages,
    metadata: buildMetadata(input, history.length, mergedWithLastMessage),
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
): ContextBuildMetadata {
  return {
    bootstrapFiles: includedBootstrapPaths(input.bootstrapFiles),
    historyMessageCount,
    mergedWithLastMessage,
    runtimeContextIncluded: true,
    memoryContextIncluded: false,
    knowledgeContextIncluded: false,
    skillsContextIncluded: false,
    omittedContext: [...OMITTED_CONTEXT],
  };
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
