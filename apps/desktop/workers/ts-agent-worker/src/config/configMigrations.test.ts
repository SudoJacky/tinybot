import { describe, expect, test } from "vitest";

import { applyConfigMigrations } from "./configMigrations.ts";
import { parseTinybotConfig } from "./configSchema.ts";

describe("configMigrations", () => {
  test("moves legacy tools.exec.restrictToWorkspace to tools.restrictToWorkspace", () => {
    const raw = {
      tools: {
        exec: {
          enable: true,
          restrictToWorkspace: false,
        },
      },
    };

    const migrated = applyConfigMigrations(raw);

    expect(migrated).toEqual({
      tools: {
        exec: {
          enable: true,
        },
        restrictToWorkspace: false,
      },
    });
    expect(raw.tools.exec).toHaveProperty("restrictToWorkspace", false);
  });

  test("does not overwrite canonical tools.restrictToWorkspace", () => {
    const migrated = applyConfigMigrations({
      tools: {
        restrictToWorkspace: true,
        exec: {
          restrictToWorkspace: false,
        },
      },
    });

    expect(migrated).toEqual({
      tools: {
        restrictToWorkspace: true,
        exec: {
          restrictToWorkspace: false,
        },
      },
    });
  });

  test("parseTinybotConfig consumes migrated restrictToWorkspace value", () => {
    const config = parseTinybotConfig({
      tools: {
        exec: {
          restrictToWorkspace: false,
        },
      },
    });

    expect(config.tools.restrictToWorkspace).toBe(false);
    expect(config.tools.exec).not.toHaveProperty("restrictToWorkspace");
  });
});
