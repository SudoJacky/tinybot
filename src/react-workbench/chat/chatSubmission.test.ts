import type { TFunction } from "i18next";
import { describe, expect, test, vi } from "vitest";
import type { QueuedInput } from "../../app-core/chat/chatUiProjection";
import {
  prepareChatSubmission,
  type PrepareChatSubmissionInput,
} from "./chatSubmission";

describe("prepareChatSubmission", () => {
  test("builds one canonical input from files, paste, and bounded session transcripts", async () => {
    const longTranscript = "前".repeat(30_000);
    const prepared = await prepareChatSubmission(input({
      files: [{ id: "file-1", mimeType: "text/plain", name: "notes.txt", path: "D:\\notes.txt", sizeBytes: 12 }],
      loadSessionTranscript: vi.fn(async () => longTranscript),
      message: "Review these references",
      options: { model: "gpt-5", provider: "openai", reasoningEffort: "high" },
      pastedContent: [{ content: "pasted detail", id: "paste-1", timestamp: new Date(0), wordCount: 2 }],
      selectedSkillIds: ["apple-design"],
      selectedSessionIds: ["session-2"],
    }));

    expect(prepared.kind).toBe("send_message");
    if (prepared.kind !== "send_message") throw new Error("Expected send_message.");
    expect(prepared.turnInput).toMatchObject({
      model: "gpt-5",
      provider: "openai",
      reasoningEffort: "high",
      selectedSkills: ["apple-design"],
      text: "Review these references\n\nPasted content:\npasted detail",
    });
    expect(prepared.turnInput.references).toEqual([
      expect.objectContaining({ rawPath: "D:\\notes.txt", type: "tinyos.file" }),
      expect.objectContaining({ scope: "session-2", title: "Architecture review", type: "tinyos.thread" }),
    ]);
    const transcript = prepared.turnInput.references?.[1]?.sourceText ?? "";
    expect(transcript).toContain("middle conversation content omitted");
    expect(new TextEncoder().encode(transcript).byteLength).toBeLessThanOrEqual(48 * 1024);
  });

  test("rejects unavailable session mentions before loading transcripts", async () => {
    const loadSessionTranscript = vi.fn(async () => "transcript");

    await expect(prepareChatSubmission(input({
      availableSessionIds: new Set(),
      loadSessionTranscript,
      selectedSessionIds: ["session-2"],
    }))).rejects.toThrow("Session mention unavailable");
    expect(loadSessionTranscript).not.toHaveBeenCalled();
  });

  test("persists managed images as typed local attachment references", async () => {
    const prepared = await prepareChatSubmission(input({
      files: [{
        contentHash: "abc123",
        id: "image-1",
        mimeType: "image/png",
        name: "diagram.png",
        path: "C:\\Users\\tester\\.tinybot\\chat-attachments\\images\\abc123.png",
        sizeBytes: 2048,
      }],
      message: "Explain this diagram",
    }));

    expect(prepared.kind).toBe("send_message");
    if (prepared.kind !== "send_message") throw new Error("Expected send_message.");
    expect(prepared.turnInput.references).toEqual([{
      contentHash: "abc123",
      detail: "PNG - 2 KB",
      kind: "reference",
      mimeType: "image/png",
      rawPath: "C:\\Users\\tester\\.tinybot\\chat-attachments\\images\\abc123.png",
      sizeBytes: 2048,
      title: "diagram.png",
      type: "tinyos.image",
    }]);
  });

  test("returns a queue input with its canonical turn input when the session is running", async () => {
    const prepared = await prepareChatSubmission(input({
      isRunning: true,
      message: "continue after this turn",
      now: () => "2026-08-15T11:00:00.000Z",
      options: { model: "gpt-5" },
    }));

    expect(prepared).toEqual({
      input: {
        content: "continue after this turn",
        createdAt: "2026-08-15T11:00:00.000Z",
        id: "queued-2026-08-15T11:00:00.000Z",
        mode: "queued",
        status: "queued",
        turnInput: { model: "gpt-5", text: "continue after this turn" },
      },
      kind: "queue_input",
      visibleText: "continue after this turn",
    });
  });

  test("reports compact, empty, and queue-limit outcomes without page-side reconstruction", async () => {
    const now = vi.fn(() => "2026-08-15T10:00:00.000Z");
    await expect(prepareChatSubmission(input({
      files: [{ id: "file-1", mimeType: "text/plain", name: "notes.txt", path: "notes.txt", sizeBytes: 12 }],
      message: "/compact",
    }))).rejects.toThrow("Compact cannot include attachments");
    await expect(prepareChatSubmission(input({ now }))).resolves.toEqual({ kind: "empty" });
    expect(now).not.toHaveBeenCalled();
    await expect(prepareChatSubmission(input({
      isRunning: true,
      message: "sixth",
      queuedInputs: Array.from({ length: 5 }, (_, index) => queuedInput(index)),
    }))).resolves.toEqual({ kind: "queue_limit_reached" });
    await expect(prepareChatSubmission(input({ message: "/compact" }))).resolves.toEqual({ kind: "compact" });
  });

  test("uses selected Skills as request context without copying their content into the message", async () => {
    const prepared = await prepareChatSubmission(input({
      message: "Polish this interaction",
      selectedSkillIds: ["apple-design"],
    }));

    expect(prepared).toEqual({
      kind: "send_message",
      turnInput: {
        selectedSkills: ["apple-design"],
        text: "Polish this interaction",
      },
      visibleText: "Polish this interaction",
    });

    await expect(prepareChatSubmission(input({
      message: "",
      selectedSkillIds: ["apple-design"],
    }))).resolves.toMatchObject({
      kind: "send_message",
      turnInput: {
        selectedSkills: ["apple-design"],
        text: "Use the selected Skills",
      },
    });
    await expect(prepareChatSubmission(input({
      message: "/compact",
      selectedSkillIds: ["apple-design"],
    }))).rejects.toThrow("Compact cannot include attachments");
  });
});

function input(overrides: Partial<PrepareChatSubmissionInput> = {}): PrepareChatSubmissionInput {
  return {
    availableSessionIds: new Set(["session-2"]),
    files: [],
    isRunning: false,
    loadSessionTranscript: vi.fn(async () => "transcript"),
    message: "",
    now: () => "2026-08-15T10:00:00.000Z",
    options: {},
    pastedContent: [],
    queuedInputs: [],
    selectedSkillIds: [],
    selectedSessionIds: [],
    sessions: [{ id: "session-2", title: "Architecture review", updatedAtMs: 42 }],
    t,
    ...overrides,
  };
}

const t = ((key: string) => ({
  "composer.attachedFilesPrompt": "Review attached files",
  "composer.pastedContentLabel": "Pasted content",
  "composer.skill.attachedPrompt": "Use the selected Skills",
  "composer.sessionMention.attachedPrompt": "Review attached sessions",
  "composer.sessionMention.emptyTranscript": "Empty transcript",
  "composer.sessionMention.referenceDetail": "Referenced conversation",
  "composer.sessionMention.unavailable": "Session mention unavailable",
  "errors.compactWithAttachments": "Compact cannot include attachments",
}[key] ?? key)) as TFunction<"chat">;

function queuedInput(index: number): QueuedInput {
  return {
    content: `queued ${index}`,
    createdAt: `2026-08-15T10:00:0${index}.000Z`,
    id: `queued-${index}`,
    mode: "queued",
    status: "queued",
  };
}
