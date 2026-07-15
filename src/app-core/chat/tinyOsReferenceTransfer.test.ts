import { describe, expect, it, vi } from "vitest";

import {
  readTinyOsReferenceTransfer,
  TINYOS_REFERENCE_MIME,
  tinyOsReferenceAcceptedBy,
  writeTinyOsReferenceTransfer,
  type TinyOsCrossAppReference,
} from "./tinyOsReferenceTransfer";

describe("TinyOS reference transfer", () => {
  it("round-trips a typed file context reference", () => {
    const stored = new Map<string, string>();
    const transfer = {
      effectAllowed: "none" as DataTransfer["effectAllowed"],
      getData: (type: string) => stored.get(type) ?? "",
      setData: (type: string, value: string) => stored.set(type, value),
    };
    const reference: TinyOsCrossAppReference = {
      kind: "context",
      reference: {
        kind: "file",
        path: "src/app.ts",
        provenance: { kind: "canonical", sourceItemId: "item-1", turnId: "turn-1" },
        startLine: 2,
      },
    };

    writeTinyOsReferenceTransfer(transfer, reference);

    expect(transfer.effectAllowed).toBe("copy");
    expect(stored.has(TINYOS_REFERENCE_MIME)).toBe(true);
    expect(readTinyOsReferenceTransfer(transfer)).toEqual({ reference, status: "accepted" });
  });

  it("rejects malformed payloads instead of guessing", () => {
    expect(readTinyOsReferenceTransfer({ getData: () => "not-json" })).toEqual({
      reason: "The TinyOS reference payload is not valid JSON.",
      status: "rejected",
    });
    expect(readTinyOsReferenceTransfer({ getData: () => JSON.stringify({ schemaVersion: "tinyos.reference.v2" }) })).toEqual({
      reason: "The TinyOS reference payload does not match tinyos.reference.v1.",
      status: "rejected",
    });
  });

  it("rejects unsupported targets without invoking a dispatcher", () => {
    const dispatch = vi.fn();
    const result = tinyOsReferenceAcceptedBy({ itemId: "item-1", kind: "evidence", title: "Result", turnId: "turn-1" }, "chat");
    if (result.status === "accepted") dispatch(result.reference);

    expect(result).toEqual({
      reason: "Chat accepts file and terminal context, not evidence references.",
      status: "rejected",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
