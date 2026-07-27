import { describe, expect, test } from "vitest";
import {
  buildDesktopFileTaskOperation,
  buildDesktopProviderModelDiscoveryTaskOperation,
} from "./desktopTaskCenterSources";
import { buildDesktopTaskCenterItems } from "./desktopTaskCenter";

describe("desktop task center source projections", () => {
  test("projects provider model discovery into provider task operations", () => {
    expect(
      [
        buildDesktopProviderModelDiscoveryTaskOperation({
          provider: "openai",
          profile: "work",
          status: "refreshing",
          updatedAt: "2026-05-31T13:00:00Z",
        }),
        buildDesktopProviderModelDiscoveryTaskOperation({
          provider: "deepseek",
          profile: "default",
          status: "completed",
          models: ["deepseek-chat", "deepseek-reasoner"],
        }),
        buildDesktopProviderModelDiscoveryTaskOperation({
          provider: "anthropic",
          status: "failed",
          error: "HTTP 401",
        }),
      ],
    ).toEqual([
      {
        id: "provider:openai:work:models",
        title: "Refresh OpenAI models",
        status: "refreshing",
        detail: "Profile work",
        canonical: { module: "settings", entityId: "openai", href: "/settings" },
        diagnostics: "",
        retryable: false,
        updatedAt: "2026-05-31T13:00:00Z",
      },
      {
        id: "provider:deepseek:default:models",
        title: "Refresh Deepseek models",
        status: "completed",
        detail: "2 models loaded",
        canonical: { module: "settings", entityId: "deepseek", href: "/settings" },
        diagnostics: "",
        retryable: false,
        updatedAt: "",
      },
      {
        id: "provider:anthropic:default:models",
        title: "Refresh Anthropic models",
        status: "failed",
        detail: "Profile default",
        canonical: { module: "settings", entityId: "anthropic", href: "/settings" },
        diagnostics: "HTTP 401",
        retryable: true,
        updatedAt: "",
      },
    ]);
  });

  test("projects file operations into task center items", () => {
    const taskItems = buildDesktopTaskCenterItems({
      fileOperations: [
        buildDesktopFileTaskOperation({
          id: "workspace:AGENTS.md:save",
          title: "Save AGENTS.md",
          status: "saving",
          path: "AGENTS.md",
        }),
        buildDesktopFileTaskOperation({
          id: "workspace:AGENTS.md:save",
          title: "Save AGENTS.md",
          status: "failed",
          path: "AGENTS.md",
          detail: "Save conflict",
          error: "HTTP 409",
          retryable: true,
        }),
      ],
    });

    expect(taskItems.map((item) => [item.id, item.source, item.state, item.title, item.actions.map((action) => action.id).join(",")])).toEqual([
      ["file:workspace:AGENTS.md:save", "file", "failed", "Save AGENTS.md", "retry,open,inspect,copyDiagnostics,dismiss"],
      ["file:workspace:AGENTS.md:save", "file", "active", "Save AGENTS.md", "open,inspect"],
    ]);
  });
});
