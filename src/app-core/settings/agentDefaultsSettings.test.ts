import { describe, expect, test } from "vitest";
import {
  buildAgentDefaultsPatch,
  buildAgentDefaultsSettings,
  listSupportedTimeZones,
  validateAgentDefaultsInput,
} from "./agentDefaultsSettings";

describe("agent defaults settings", () => {
  test("builds form values from backend config", () => {
    const settings = buildAgentDefaultsSettings({
      revision: "hash:1",
      agents: {
        defaults: {
          activeProfile: "deepseek-default",
          model: "deepseek-v4-pro",
          timezone: "Asia/Singapore",
          temperature: 0.4,
          maxTokens: 4096,
          contextWindowTokens: 128000,
          contextWindowStrategy: "compact",
          maxIterations: 12,
        },
      },
    }, "Europe/Paris");

    expect(settings).toMatchObject({
      revision: "hash:1",
      fallbackContextWindowTokens: 128000,
      values: {
        timezone: "Asia/Singapore",
        maxTokens: "4096",
        contextWindowStrategy: "compact",
        maxToolIterations: "12",
      },
    });
  });

  test("fills runtime default values when backend config omits them", () => {
    const settings = buildAgentDefaultsSettings({
      agents: {
        defaults: {
          activeProfile: "deepseek-default",
          model: "deepseek-v4-pro",
        },
      },
    }, "Asia/Shanghai");

    expect(settings.values).toMatchObject({
      timezone: "Asia/Shanghai",
      maxTokens: "8192",
      contextWindowStrategy: "compact",
      maxToolIterations: "200",
    });
    expect(settings.fallbackContextWindowTokens).toBe(128000);
  });

  test("builds agent defaults patch from valid form values", () => {
    expect(buildAgentDefaultsPatch({
      timezone: "UTC",
      maxTokens: "2048",
      contextWindowStrategy: "compact",
      maxToolIterations: "8",
    })).toEqual({
      agents: {
        defaults: {
          timezone: "UTC",
          maxTokens: 2048,
          contextWindowStrategy: "compact",
          maxIterations: 8,
        },
      },
    });
  });

  test("validates numeric agent defaults before save", () => {
    expect(validateAgentDefaultsInput({
      timezone: "UTC",
      maxTokens: "0",
      contextWindowStrategy: "invalid",
      maxToolIterations: "-1",
    })).toEqual({
      maxTokens: "max-tokens",
      contextWindowStrategy: "context-strategy",
      maxToolIterations: "max-tool-iterations",
    });
  });

  test("rejects an invalid timezone before save", () => {
    expect(validateAgentDefaultsInput({
      timezone: "Shanghai",
      maxTokens: "2048",
      contextWindowStrategy: "compact",
      maxToolIterations: "8",
    })).toEqual({ timezone: "timezone" });
  });

  test("lists the configured, Windows, UTC, and standard IANA timezones", () => {
    const timezones = listSupportedTimeZones("Europe/Paris", "Asia/Shanghai");

    expect(timezones.slice(0, 3)).toEqual(["Europe/Paris", "Asia/Shanghai", "UTC"]);
    expect(timezones.length).toBeGreaterThan(3);
  });
});
