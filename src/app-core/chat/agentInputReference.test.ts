import { describe, expect, test } from "vitest";

import {
  agentInputAttachmentKind,
  normalizeAgentInputReference,
} from "./agentInputReference";

describe("Agent input references", () => {
  test("normalizes explicit reference kinds", () => {
    const reference = normalizeAgentInputReference({
      detail: "Conversation snapshot",
      kind: "reference",
      referenceKind: "thread",
      scope: "thread-2",
      sourceText: "user: Review this",
      title: "Architecture review",
    });

    expect(reference.referenceKind).toBe("thread");
    expect(agentInputAttachmentKind(reference)).toBeUndefined();
  });

  test("infers attachment kinds from persisted structural fields", () => {
    const file = normalizeAgentInputReference({
      detail: "text/markdown",
      kind: "reference",
      rawPath: "D:/work/notes.md",
      title: "notes.md",
    });
    const image = normalizeAgentInputReference({
      contentHash: "hash",
      detail: "image/png",
      kind: "reference",
      mimeType: "image/png",
      rawPath: "D:/work/diagram.png",
      title: "diagram.png",
    });

    expect(file.referenceKind).toBe("file");
    expect(agentInputAttachmentKind(file)).toBe("file");
    expect(image.referenceKind).toBe("image");
    expect(agentInputAttachmentKind(image)).toBe("image");
  });
});
