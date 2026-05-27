import assert from "node:assert/strict";
import { buildProviderCardViewModel, filterProviderCards } from "./provider-cards.js";

const providers = [
  {
    id: "dashscope",
    displayName: "DashScope",
    aliases: ["qwen"],
    categories: ["built_in"],
    builtIn: true,
    status: "ready",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    credential: { state: "configured", envVars: ["DASHSCOPE_API_KEY"] },
    models: { count: 4 },
    default: { isDefault: true, model: "qwen-max" },
    actions: { models: true, settings: true, useAsDefault: true },
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    aliases: ["open router"],
    categories: ["built_in", "aggregator"],
    builtIn: true,
    status: "needs_key",
    credential: { state: "missing", envVars: ["OPENROUTER_API_KEY"] },
    models: { count: 2 },
  },
  {
    id: "local_lab",
    displayName: "Local Lab",
    categories: ["custom"],
    custom: true,
    status: "no_models",
    credential: { state: "not_required", envVars: [] },
    models: { count: 0 },
  },
];

const dashscope = buildProviderCardViewModel(providers[0]);
assert.equal(dashscope.title, "DashScope");
assert.deepEqual(dashscope.badges, ["Built-in"]);
assert.equal(dashscope.credentialText, "API key configured");
assert.equal(dashscope.defaultModel, "qwen-max");

assert.deepEqual(filterProviderCards(providers, { query: "qwen" }).map((item) => item.id), ["dashscope"]);
assert.deepEqual(filterProviderCards(providers, { filter: "needs_setup" }).map((item) => item.id), ["openrouter", "local_lab"]);
assert.deepEqual(filterProviderCards(providers, { filter: "custom" }).map((item) => item.id), ["local_lab"]);
