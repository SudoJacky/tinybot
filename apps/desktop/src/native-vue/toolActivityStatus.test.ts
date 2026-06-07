// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import {
  formatMaybeJson,
  getToolStatusLabel,
  getToolStatusTone,
  isPendingToolApproval,
  normalizeToolStatus,
} from "./toolActivityStatus";

describe("tool activity status helpers", () => {
  test.each([
    ["approval_required", undefined, "blocked", "Pending approval", "pending"],
    ["waiting_approval", "running", "blocked", "Pending approval", "pending"],
    ["approved", "success", "completed", "Completed", "success"],
    ["denied", "failed", "denied", "Denied", "denied"],
    [undefined, "cancelled", "cancelled", "Cancelled", "denied"],
    [undefined, "error", "failed", "Failed", "error"],
    [undefined, "running", "running", "Running", "running"],
  ])("normalizes approval=%s status=%s", (approvalStatus, status, normalized, label, tone) => {
    const result = normalizeToolStatus({ approvalStatus, status });

    expect(result.status).toBe(normalized);
    expect(getToolStatusLabel(result)).toBe(label);
    expect(getToolStatusTone(result)).toBe(tone);
  });

  test("detects pending approvals from either status field", () => {
    expect(isPendingToolApproval({ approvalStatus: "approval_required" })).toBe(true);
    expect(isPendingToolApproval({ status: "blocked" })).toBe(true);
    expect(isPendingToolApproval({ approvalStatus: "approved", status: "completed" })).toBe(false);
  });

  test("pretty prints JSON while leaving plain text untouched", () => {
    expect(formatMaybeJson("{\"query\":\"tinybot\",\"limit\":2}")).toBe("{\n  \"query\": \"tinybot\",\n  \"limit\": 2\n}");
    expect(formatMaybeJson("plain result")).toBe("plain result");
    expect(formatMaybeJson("")).toBe("");
  });
});
