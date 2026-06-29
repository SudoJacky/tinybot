import { describe, expect, test } from "vitest";

import { buildApprovalFingerprint, buildSessionApprovalFingerprint } from "./approvalFingerprint";

describe("approvalFingerprint", () => {
  test("normalizes exec command whitespace and case for exact fingerprints", () => {
    expect(buildApprovalFingerprint("exec", { command: "  NPM   TEST -- security/approvalClassifier.test.ts " }, "shell")).toBe(
      "exec:npm test -- security/approvalclassifier.test.ts",
    );
  });

  test("keeps exec session approvals exact to the normalized command", () => {
    const command = "custom-tool " + "a".repeat(100);

    expect(buildSessionApprovalFingerprint("exec", { command }, "shell")).toBe(`exec:${command}`);
    expect(buildSessionApprovalFingerprint("exec", { command: `${command} --delete` }, "shell")).toBe(
      `exec:${command} --delete`,
    );
  });

  test("normalizes file paths for once and session fingerprints", () => {
    expect(buildApprovalFingerprint("write_file", { path: "Notes\\TODAY.md", content: "hello" }, "filesystem_write"))
      .toBe("write_file:notes/today.md");
    expect(buildSessionApprovalFingerprint("write_file", { path: "Notes\\TODAY.md", content: "changed" }, "filesystem_write"))
      .toBe("write_file:notes/today.md");
  });

  test("hashes stable JSON independent of argument key order", () => {
    const first = buildApprovalFingerprint("mcp_filesystem_read", { path: "README.md", limit: 5 }, "mcp");
    const second = buildApprovalFingerprint("mcp_filesystem_read", { limit: 5, path: "README.md" }, "mcp");

    expect(first).toBe(second);
    expect(first).toMatch(/^mcp_filesystem_read:[a-f0-9]{12}$/);
  });

  test("uses category and tool name for broader non-file session approvals", () => {
    expect(buildSessionApprovalFingerprint("save_experience", { text: "remember this" }, "persistent_data")).toBe(
      "persistent_data:save_experience",
    );
  });
});
