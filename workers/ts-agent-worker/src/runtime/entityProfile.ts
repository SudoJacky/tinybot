import { createHash } from "node:crypto";

import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { ModelProvider } from "../model/provider.ts";

export type UserProfile = Record<string, unknown>;

export type UserProfileExtractor = {
  extract(request: UserProfileExtractionRequest): Promise<UserProfile> | UserProfile;
};

export type UserProfileExtractionRequest = {
  userMessage: string;
  assistantMessage: string;
  currentProfile: UserProfile;
  model: string;
};

export class ProviderBackedUserProfileExtractor implements UserProfileExtractor {
  private readonly provider: ModelProvider;

  constructor(provider: ModelProvider) {
    this.provider = provider;
  }

  async extract(request: UserProfileExtractionRequest): Promise<UserProfile> {
    if (!request.userMessage.trim()) {
      return {};
    }
    const response = await this.provider.complete([
      { role: "system", content: ENTITY_EXTRACT_SYSTEM },
      { role: "user", content: `USER: ${request.userMessage}\nASSISTANT: ${request.assistantMessage}` },
    ], { model: request.model });
    return userProfileFromProviderText(response.content);
  }
}

export function turnFingerprint(userMessage: string): string {
  const normalized = userMessage.trim().toLowerCase().split(/\s+/u).filter(Boolean).join(" ");
  return createHash("sha1").update(normalized, "utf8").digest("hex");
}

export function shouldExtractUserProfile(userMessage: string, currentProfile: UserProfile = {}): boolean {
  const text = userMessage.trim();
  if (!text) {
    return false;
  }
  const lowered = text.toLowerCase();
  if (ENTITY_SIGNAL_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u.test(text)) {
    return true;
  }
  if (/\b\d{11}\b/u.test(text)) {
    return true;
  }
  if (Object.keys(currentProfile).length > 0) {
    if (!currentProfile.name && (text.includes("叫我") || lowered.includes("my name is"))) {
      return true;
    }
    if (!currentProfile.preferences && ["喜欢", "偏好", "习惯"].some((token) => text.includes(token))) {
      return true;
    }
  }
  return /\b(my|i)\b/u.test(lowered) && text.length >= 48;
}

export function mergeUserProfile(current: UserProfile, extracted: UserProfile): UserProfile {
  if (Object.keys(extracted).length === 0) {
    return current;
  }
  const merged: UserProfile = { ...current };
  for (const key of ["name", "communication_style"]) {
    const value = extracted[key];
    if (value) {
      merged[key] = value;
    }
  }
  for (const key of ["preferences", "mentioned_entities", "key_facts"]) {
    const value = extracted[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const existingItems = Array.isArray(merged[key]) ? [...merged[key]] : [];
    const existing = new Set(existingItems);
    for (const item of value) {
      if (!existing.has(item)) {
        existingItems.push(item);
        existing.add(item);
      }
    }
    merged[key] = existingItems;
  }
  return merged;
}

export function latestUserAssistantTurn(messages: AgentMessage[]): { userMessage: string; assistantMessage: string } | null {
  const profileMessages = messages.filter((message) => !isProfileExtractionControlMessage(message));
  const userIndex = profileMessages.map((message) => message.role).lastIndexOf("user");
  if (userIndex < 0) {
    return null;
  }
  let assistant: AgentMessage | undefined;
  for (let index = profileMessages.length - 1; index > userIndex; index -= 1) {
    if (profileMessages[index]?.role === "assistant") {
      assistant = profileMessages[index];
      break;
    }
  }
  return {
    userMessage: profileMessages[userIndex]?.content ?? "",
    assistantMessage: assistant?.content ?? "",
  };
}

function isProfileExtractionControlMessage(message: AgentMessage): boolean {
  if (message.role === "tool") {
    return true;
  }
  const metadata = message.metadata ?? {};
  if (
    metadata._delegate_event === true
    || metadata._task_event === true
    || metadata._agent_ui_internal === true
    || metadata._tool_result === true
    || metadata._approval_status === "approval_required"
  ) {
    return true;
  }
  const content = message.content.trim();
  return content === "Waiting for approval." || content === "Approved." || content === "Denied.";
}

function userProfileFromProviderText(text: string): UserProfile {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) {
    return {};
  }
  try {
    const parsed = JSON.parse(match[0]);
    return isUserProfile(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isUserProfile(value: unknown): value is UserProfile {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ENTITY_SIGNAL_PATTERNS = [
  /\b(my name is|call me|please call me|i am|i'm|i prefer|i like|i use|i work as|i live in|i'm from)\b/iu,
  /(我叫|叫我|我是|我在|我住在|我来自|我做|我从事|我主要用|我常用|我喜欢|我偏好|我习惯|我不喜欢|我讨厌|请叫我)/u,
  /(名字|昵称|称呼|偏好|习惯|邮箱|email|e-mail|电话|手机号|微信|qq|职业|岗位|学校|专业)/iu,
];

const ENTITY_EXTRACT_SYSTEM = `You are an entity extractor. Given a conversation turn, extract structured facts about the user as JSON.

Rules:
1. Only extract EXPLICITLY stated facts - never infer or guess.
2. Output a single JSON object with these keys (omit empty keys):
   - "name": the user's name (if mentioned)
   - "preferences": list of stated preferences (colors, styles, tools, etc.)
   - "mentioned_entities": list of named things (people, pets, projects, companies, etc.) with brief context
   - "communication_style": one of "casual", "formal", "technical", "brief"
   - "key_facts": list of any other important facts about the user
3. If nothing can be extracted, output: {}
4. Keep values concise - no full sentences, just key facts.`;
