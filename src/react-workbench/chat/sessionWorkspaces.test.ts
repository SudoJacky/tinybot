import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../services";
import {
  GENERAL_SESSION_WORKSPACE_KEY,
  groupSessionsByWorkspace,
  sessionWorkspaceName,
} from "./sessionWorkspaces";

function session(
  id: string,
  updatedAtMs: number,
  workingDirectory?: string,
): SessionSummary {
  return {
    id,
    title: id,
    updatedAtMs,
    ...(workingDirectory ? { workingDirectory } : {}),
  };
}

describe("session workspace projection", () => {
  it("groups equivalent Windows directories without changing the session order", () => {
    const groups = groupSessionsByWorkspace([
      session("tinybot-new", 30, "D:\\Code\\py\\tinybot\\"),
      session("general", 25),
      session("tinybot-old", 20, "d:/code/py/tinybot"),
      session("virtual-home", 10, "D:\\Code\\VirtualHome"),
    ]);

    expect(groups).toEqual([
      expect.objectContaining({
        label: "tinybot",
        sessions: [
          expect.objectContaining({ id: "tinybot-new" }),
          expect.objectContaining({ id: "tinybot-old" }),
        ],
        workingDirectory: "D:\\Code\\py\\tinybot",
      }),
      expect.objectContaining({
        key: GENERAL_SESSION_WORKSPACE_KEY,
        label: "常规会话",
        sessions: [expect.objectContaining({ id: "general" })],
      }),
      expect.objectContaining({
        label: "VirtualHome",
        sessions: [expect.objectContaining({ id: "virtual-home" })],
      }),
    ]);
  });

  it("derives a useful label for Windows, Unix, and root directories", () => {
    expect(sessionWorkspaceName("D:\\Code\\py\\tinybot\\")).toBe("tinybot");
    expect(sessionWorkspaceName("/work/projects/tinybot/")).toBe("tinybot");
    expect(sessionWorkspaceName("D:\\")).toBe("D:");
  });
});
