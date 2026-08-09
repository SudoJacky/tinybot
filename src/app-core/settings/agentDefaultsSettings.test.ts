import { describe, expect, test } from "vitest";
import {
  buildAgentDefaultsPatch,
  buildAgentDefaultsSettings,
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
    });

    expect(settings).toMatchObject({
      revision: "hash:1",
      activeProfileId: "deepseek-default",
      defaultModel: "deepseek-v4-pro",
      values: {
        timezone: "Asia/Singapore",
        temperature: "0.4",
        maxTokens: "4096",
        contextWindowTokens: "128000",
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
    });

    expect(settings.values).toMatchObject({
      maxTokens: "8192",
      contextWindowTokens: "128000",
      contextWindowStrategy: "discard",
      maxToolIterations: "200",
    });
  });

  test("builds agent defaults patch from valid form values", () => {
    expect(buildAgentDefaultsPatch({
      timezone: "UTC",
      temperature: "0.2",
      maxTokens: "2048",
      contextWindowTokens: "64000",
      contextWindowStrategy: "compact",
      maxToolIterations: "8",
    })).toEqual({
      agents: {
        defaults: {
          timezone: "UTC",
          temperature: 0.2,
          maxTokens: 2048,
          contextWindowTokens: 64000,
          contextWindowStrategy: "compact",
          maxIterations: 8,
        },
      },
    });
  });

  test("rejects non-numeric temperature values before save", () => {
    expect(validateAgentDefaultsInput({
      timezone: "UTC",
      temperature: "abc",
      maxTokens: "2048",
      contextWindowTokens: "64000",
      contextWindowStrategy: "compact",
      maxToolIterations: "8",
    })).toEqual({
      temperature: "temperature-number",
    });
    expect(buildAgentDefaultsPatch({
      timezone: "UTC",
      temperature: "abc",
      maxTokens: "",
      contextWindowTokens: "",
      contextWindowStrategy: "discard",
      maxToolIterations: "",
    })).toEqual({
      agents: {
        defaults: {
          timezone: "UTC",
          contextWindowStrategy: "discard",
        },
      },
    });
  });

  test("validates numeric agent defaults before save", () => {
    expect(validateAgentDefaultsInput({
      timezone: "UTC",
      temperature: "3",
      maxTokens: "0",
      contextWindowTokens: "1.5",
      contextWindowStrategy: "invalid",
      maxToolIterations: "-1",
    })).toEqual({
      temperature: "temperature-range",
      maxTokens: "max-tokens",
      contextWindowTokens: "context-budget",
      contextWindowStrategy: "context-strategy",
      maxToolIterations: "max-tool-iterations",
    });
  });
});
