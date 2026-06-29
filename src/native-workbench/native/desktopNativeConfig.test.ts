import { describe, expect, test, vi } from "vitest";

import { configFromEditorSnapshot, createDesktopNativeConfigApi } from "./desktopNativeConfig";

describe("desktop native config API", () => {
  test("loads effective public config through the Rust config editor snapshot", async () => {
    const invokeMock = vi.fn(async () => ({
      revision: "hash:new",
      effectivePublicConfig: { agents: { defaults: { provider: "openai" } } },
      origins: { "agents.defaults.provider": "file" },
      diagnostics: [],
      secretPresence: { "providers.openai.api_key": true },
      configPath: "D:/home/.tinybot/config.json",
    }));
    const invoke = invokeMock as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    const api = createDesktopNativeConfigApi({ invoke });

    await expect(api.get()).resolves.toEqual({
      agents: { defaults: { provider: "openai" } },
      revision: "hash:new",
      configMetadata: {
        revision: "hash:new",
        configPath: "D:/home/.tinybot/config.json",
        origins: { "agents.defaults.provider": "file" },
        diagnostics: [],
        secretPresence: { "providers.openai.api_key": true },
      },
    });
    expect(invokeMock).toHaveBeenCalledWith("get_config_editor_snapshot");
  });

  test("uses snake case snapshot fields for compatibility", () => {
    expect(configFromEditorSnapshot({
      revision: "hash:snake",
      effective_public_config: { desktop: { native: true } },
      config_path: "D:/home/.tinybot/config.json",
      secret_presence: {},
    })).toEqual({
      desktop: { native: true },
      revision: "hash:snake",
      configMetadata: {
        revision: "hash:snake",
        configPath: "D:/home/.tinybot/config.json",
        origins: undefined,
        diagnostics: undefined,
        secretPresence: {},
      },
    });
  });
});
