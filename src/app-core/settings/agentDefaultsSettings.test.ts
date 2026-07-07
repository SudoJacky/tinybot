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
          maxToolIterations: 12,
          reasoningEffort: "medium",
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
        reasoningEffort: "medium",
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
      reasoningEffort: "medium",
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
      reasoningEffort: "high",
    })).toEqual({
      agents: {
        defaults: {
          timezone: "UTC",
          temperature: 0.2,
          maxTokens: 2048,
          contextWindowTokens: 64000,
          contextWindowStrategy: "compact",
          maxToolIterations: 8,
          reasoningEffort: "high",
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
      reasoningEffort: "medium",
    })).toEqual({
      temperature: "Temperature must be between 0 and 2.",
      maxTokens: "Max output tokens must be a positive integer.",
      contextWindowTokens: "Context window budget must be a positive integer.",
      contextWindowStrategy: "Context window strategy must be discard or compact.",
      maxToolIterations: "Max tool iterations must be a positive integer.",
    });
  });
});
