export type ProviderCategory = "built_in" | "aggregator" | "local" | "custom";
export type ProviderStatus = "ready" | "needs_key" | "no_models" | "unavailable" | "unsupported";
export type ApiMode = "openai_chat_completions" | "unsupported";
export type TokenParameter = "max_tokens" | "max_completion_tokens";
export type TemperaturePolicy = "standard" | "omit_for_reasoning" | "omit";

export type RequestTraits = {
  tokenParameter: TokenParameter;
  temperaturePolicy: TemperaturePolicy;
  stripModelPrefix: boolean;
  extraBodyDefaults: Record<string, unknown>;
  supportsPromptCaching: boolean;
};

export type ProviderCatalogEntry = {
  id: string;
  displayName: string;
  aliases: string[];
  categories: ProviderCategory[];
  defaultApiBase?: string;
  apiKeyEnvVars: string[];
  apiBaseEnvVars: string[];
  apiMode: ApiMode;
  supportsModelDiscovery: boolean;
  curatedModelIds: string[];
  modelPrefixes: string[];
  requestTraits: RequestTraits;
  backend: "openai";
  detectByKeyPrefix?: string;
  detectByBaseKeyword?: string;
};

const DEFAULT_REQUEST_TRAITS: RequestTraits = {
  tokenParameter: "max_tokens",
  temperaturePolicy: "standard",
  stripModelPrefix: false,
  extraBodyDefaults: {},
  supportsPromptCaching: false,
};

const OPENROUTER_MODELS = [
  "anthropic/claude-opus-4.7",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-sonnet-4.6",
  "moonshotai/kimi-k2.6",
  "openrouter/pareto-code",
  "qwen/qwen3.7-max",
  "anthropic/claude-haiku-4.5",
  "openai/gpt-5.5",
  "openai/gpt-5.5-pro",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-nano",
  "openai/gpt-5.3-codex",
];

const VERCEL_AI_GATEWAY_MODELS = [
  "moonshotai/kimi-k2.6",
  "alibaba/qwen3.6-plus",
  "zai/glm-5.1",
  "minimax/minimax-m2.7",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4.7",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "google/gemini-3.1-pro-preview",
];

const CATALOG: ProviderCatalogEntry[] = [
  entry({
    id: "openai",
    displayName: "OpenAI",
    aliases: ["gpt", "chatgpt"],
    defaultApiBase: "https://api.openai.com/v1",
    apiKeyEnvVars: ["OPENAI_API_KEY"],
    apiBaseEnvVars: ["OPENAI_BASE_URL"],
    curatedModelIds: [
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5-mini",
      "gpt-5.3-codex",
      "gpt-4.1",
      "gpt-4o",
      "gpt-4o-mini",
    ],
    modelPrefixes: ["gpt", "o1", "o3", "o4"],
    requestTraits: {
      tokenParameter: "max_completion_tokens",
      temperaturePolicy: "omit_for_reasoning",
    },
  }),
  entry({
    id: "deepseek",
    displayName: "DeepSeek",
    aliases: ["deep seek"],
    defaultApiBase: "https://api.deepseek.com",
    apiKeyEnvVars: ["DEEPSEEK_API_KEY"],
    apiBaseEnvVars: ["DEEPSEEK_BASE_URL"],
    curatedModelIds: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    modelPrefixes: ["deepseek"],
  }),
  entry({
    id: "dashscope",
    displayName: "DashScope",
    aliases: ["alibaba", "alibaba cloud", "aliyun", "qwen"],
    defaultApiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnvVars: ["DASHSCOPE_API_KEY"],
    apiBaseEnvVars: ["DASHSCOPE_BASE_URL"],
    curatedModelIds: [
      "qwen-max",
      "qwen-plus",
      "qwen-turbo",
      "qwen3-coder-plus",
      "qwen3.6-plus",
      "kimi-k2.5",
      "qwen3.5-plus",
      "qwen3-coder-next",
      "glm-5",
      "glm-4.7",
      "MiniMax-M2.5",
    ],
    modelPrefixes: ["qwen", "alibaba"],
  }),
  entry({
    id: "openrouter",
    displayName: "OpenRouter",
    aliases: ["open router"],
    categories: ["built_in", "aggregator"],
    defaultApiBase: "https://openrouter.ai/api/v1",
    apiKeyEnvVars: ["OPENROUTER_API_KEY", "OPENAI_API_KEY"],
    apiBaseEnvVars: ["OPENROUTER_BASE_URL"],
    curatedModelIds: OPENROUTER_MODELS,
    modelPrefixes: ["openrouter", "anthropic", "openai", "google", "qwen", "moonshotai", "x-ai", "z-ai"],
    requestTraits: { stripModelPrefix: true },
    detectByKeyPrefix: "sk-or-",
    detectByBaseKeyword: "openrouter.ai",
  }),
  entry({
    id: "ollama",
    displayName: "Ollama",
    aliases: ["local ollama"],
    categories: ["local"],
    defaultApiBase: "http://127.0.0.1:11434/v1",
    apiKeyEnvVars: [],
    curatedModelIds: ["llama3.1", "qwen2.5", "mistral"],
    modelPrefixes: ["ollama", "llama", "mistral"],
    detectByBaseKeyword: "11434",
  }),
  entry({
    id: "lm_studio",
    displayName: "LM Studio",
    aliases: ["lm-studio", "lmstudio"],
    categories: ["local"],
    defaultApiBase: "http://127.0.0.1:1234/v1",
    apiKeyEnvVars: ["LM_API_KEY"],
    apiBaseEnvVars: ["LM_BASE_URL"],
    modelPrefixes: ["lmstudio", "lm_studio"],
    detectByBaseKeyword: "1234",
  }),
  entry({
    id: "custom",
    displayName: "Custom OpenAI-compatible",
    aliases: ["custom", "openai compatible", "compatible endpoint"],
    categories: ["custom"],
    apiKeyEnvVars: [],
  }),
  entry({
    id: "siliconflow",
    displayName: "SiliconFlow",
    aliases: ["silicon flow"],
    defaultApiBase: "https://api.siliconflow.cn/v1",
    apiKeyEnvVars: ["SILICONFLOW_API_KEY"],
    apiBaseEnvVars: ["SILICONFLOW_BASE_URL"],
    curatedModelIds: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-V3.2", "Qwen/Qwen3.5-397B-A17B"],
    modelPrefixes: ["siliconflow", "deepseek-ai", "Qwen"],
    detectByBaseKeyword: "siliconflow.cn",
  }),
  entry({
    id: "moonshot",
    displayName: "Moonshot AI",
    aliases: ["moonshot", "kimi", "kimi-coding", "kimi-coding-cn", "kimi-for-coding"],
    defaultApiBase: "https://api.moonshot.cn/v1",
    apiKeyEnvVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
    apiBaseEnvVars: ["MOONSHOT_BASE_URL", "KIMI_BASE_URL"],
    curatedModelIds: ["kimi-k2.6", "kimi-k2.5", "kimi-for-coding", "kimi-k2-thinking", "moonshot-v1-8k"],
    modelPrefixes: ["moonshot", "kimi"],
    detectByBaseKeyword: "moonshot.cn",
  }),
  entry({
    id: "zhipu",
    displayName: "Zhipu AI",
    aliases: ["zai", "z-ai", "z.ai", "zhipu", "glm", "bigmodel"],
    defaultApiBase: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnvVars: ["ZHIPUAI_API_KEY", "ZHIPU_API_KEY", "GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"],
    apiBaseEnvVars: ["ZHIPU_BASE_URL", "GLM_BASE_URL"],
    curatedModelIds: ["glm-5.1", "glm-5", "glm-5v-turbo", "glm-5-turbo", "glm-4.7", "glm-4.5", "glm-4-plus"],
    modelPrefixes: ["glm"],
    detectByBaseKeyword: "bigmodel.cn",
  }),
  entry({
    id: "vercel",
    displayName: "Vercel AI Gateway",
    aliases: ["ai-gateway", "aigateway", "vercel-ai-gateway"],
    categories: ["built_in", "aggregator"],
    defaultApiBase: "https://ai-gateway.vercel.sh/v1",
    apiKeyEnvVars: ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"],
    apiBaseEnvVars: ["AI_GATEWAY_BASE_URL", "VERCEL_AI_GATEWAY_BASE_URL"],
    curatedModelIds: VERCEL_AI_GATEWAY_MODELS,
    modelPrefixes: ["vercel", "alibaba", "zai", "minimax", "anthropic", "openai", "google", "xai"],
    requestTraits: { stripModelPrefix: true },
    detectByBaseKeyword: "ai-gateway.vercel.sh",
  }),
  entry({
    id: "opencode",
    displayName: "OpenCode Zen",
    aliases: ["opencode-zen", "zen"],
    categories: ["built_in", "aggregator"],
    apiKeyEnvVars: ["OPENCODE_ZEN_API_KEY"],
    apiBaseEnvVars: ["OPENCODE_ZEN_BASE_URL"],
    curatedModelIds: [
      "kimi-k2.5",
      "gpt-5.4-pro",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.2",
      "gpt-5.2-codex",
      "gpt-5.1",
      "gpt-5.1-codex",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "gemini-3.1-pro",
      "gemini-3-flash",
      "minimax-m2.7",
      "glm-5",
      "qwen3-coder",
    ],
    modelPrefixes: ["opencode", "kimi", "gpt", "claude", "gemini", "glm", "qwen"],
  }),
  entry({
    id: "opencode_go",
    displayName: "OpenCode Go",
    aliases: ["opencode-go", "opencode-go-sub"],
    categories: ["built_in", "aggregator"],
    apiKeyEnvVars: ["OPENCODE_GO_API_KEY"],
    apiBaseEnvVars: ["OPENCODE_GO_BASE_URL"],
    curatedModelIds: ["kimi-k2.6", "kimi-k2.5", "glm-5.1", "glm-5", "mimo-v2.5-pro", "mimo-v2.5", "minimax-m2.7", "qwen3.6-plus"],
    modelPrefixes: ["opencode", "kimi", "glm", "mimo", "minimax", "qwen"],
  }),
  entry({
    id: "kilocode",
    displayName: "KiloCode",
    aliases: ["kilo", "kilo-code", "kilo-gateway"],
    categories: ["built_in", "aggregator"],
    apiKeyEnvVars: ["KILOCODE_API_KEY"],
    apiBaseEnvVars: ["KILOCODE_BASE_URL"],
    curatedModelIds: ["anthropic/claude-opus-4.6", "anthropic/claude-sonnet-4.6", "openai/gpt-5.4", "google/gemini-3-pro-preview"],
    modelPrefixes: ["kilo", "anthropic", "openai", "google"],
  }),
  entry({
    id: "huggingface",
    displayName: "Hugging Face",
    aliases: ["hf", "hugging-face", "huggingface-hub"],
    categories: ["built_in", "aggregator"],
    defaultApiBase: "https://router.huggingface.co/v1",
    apiKeyEnvVars: ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
    apiBaseEnvVars: ["HF_BASE_URL", "HUGGINGFACE_BASE_URL"],
    curatedModelIds: ["moonshotai/Kimi-K2.5", "Qwen/Qwen3.5-397B-A17B", "deepseek-ai/DeepSeek-V3.2", "MiniMaxAI/MiniMax-M2.5"],
    modelPrefixes: ["huggingface", "moonshotai", "Qwen", "deepseek-ai", "MiniMaxAI", "zai-org"],
    detectByBaseKeyword: "huggingface.co",
  }),
  entry({
    id: "novita",
    displayName: "Novita AI",
    aliases: ["novita-ai", "novitaai"],
    categories: ["built_in", "aggregator"],
    defaultApiBase: "https://api.novita.ai/v3/openai",
    apiKeyEnvVars: ["NOVITA_API_KEY"],
    apiBaseEnvVars: ["NOVITA_BASE_URL"],
    curatedModelIds: ["moonshotai/kimi-k2.5", "minimax/minimax-m2.7", "zai-org/glm-5", "deepseek/deepseek-v3-0324"],
    modelPrefixes: ["novita", "moonshotai", "minimax", "zai-org", "deepseek", "qwen"],
    detectByBaseKeyword: "novita.ai",
  }),
  entry({
    id: "nvidia",
    displayName: "NVIDIA NIM",
    aliases: ["nim", "nvidia-nim", "build-nvidia", "nemotron"],
    defaultApiBase: "https://integrate.api.nvidia.com/v1",
    apiKeyEnvVars: ["NVIDIA_API_KEY"],
    apiBaseEnvVars: ["NVIDIA_BASE_URL"],
    curatedModelIds: ["nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-nano-30b-a3b", "qwen/qwen3.5-397b-a17b"],
    modelPrefixes: ["nvidia", "nemotron"],
    detectByBaseKeyword: "nvidia.com",
  }),
  entry({
    id: "xiaomi",
    displayName: "Xiaomi MiMo",
    aliases: ["mimo", "xiaomi-mimo"],
    apiKeyEnvVars: ["XIAOMI_API_KEY"],
    apiBaseEnvVars: ["XIAOMI_BASE_URL"],
    curatedModelIds: ["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2-pro", "mimo-v2-omni", "mimo-v2-flash"],
    modelPrefixes: ["mimo", "xiaomi"],
  }),
  entry({
    id: "tencent_tokenhub",
    displayName: "Tencent TokenHub",
    aliases: ["tencent-tokenhub", "tencent", "tokenhub", "tencent-cloud", "tencentmaas"],
    apiKeyEnvVars: ["TOKENHUB_API_KEY", "TENCENT_API_KEY"],
    apiBaseEnvVars: ["TOKENHUB_BASE_URL"],
    curatedModelIds: ["hy3-preview"],
    modelPrefixes: ["hy3", "tencent", "tokenhub"],
  }),
  entry({
    id: "arcee",
    displayName: "Arcee AI",
    aliases: ["arcee-ai", "arceeai"],
    defaultApiBase: "https://api.arcee.ai/api/v1",
    apiKeyEnvVars: ["ARCEE_API_KEY"],
    apiBaseEnvVars: ["ARCEE_BASE_URL"],
    curatedModelIds: ["trinity-large-thinking", "trinity-large-preview", "trinity-mini"],
    modelPrefixes: ["trinity", "arcee"],
    detectByBaseKeyword: "arcee.ai",
  }),
  entry({
    id: "gmi",
    displayName: "GMI Cloud",
    aliases: ["gmi-cloud", "gmicloud"],
    defaultApiBase: "https://api.gmi-serving.com/v1",
    apiKeyEnvVars: ["GMI_API_KEY"],
    apiBaseEnvVars: ["GMI_BASE_URL"],
    curatedModelIds: ["zai-org/GLM-5.1-FP8", "deepseek-ai/DeepSeek-V3.2", "moonshotai/Kimi-K2.5", "openai/gpt-5.4"],
    modelPrefixes: ["gmi", "zai-org", "deepseek-ai", "moonshotai", "google", "anthropic", "openai"],
    detectByBaseKeyword: "gmi-serving.com",
  }),
  entry({
    id: "ollama_cloud",
    displayName: "Ollama Cloud",
    aliases: ["ollama-cloud"],
    defaultApiBase: "https://ollama.com/v1",
    apiKeyEnvVars: ["OLLAMA_API_KEY"],
    apiBaseEnvVars: ["OLLAMA_BASE_URL"],
    modelPrefixes: ["ollama-cloud"],
    detectByBaseKeyword: "ollama.com",
  }),
];

const ALIAS_INDEX = new Map<string, ProviderCatalogEntry>();
for (const catalogEntry of CATALOG) {
  for (const term of [catalogEntry.id, catalogEntry.displayName, ...catalogEntry.aliases]) {
    ALIAS_INDEX.set(normalize(term), catalogEntry);
  }
}

export function listCatalogEntries(): ProviderCatalogEntry[] {
  return CATALOG;
}

export function findCatalogEntry(name: string | null | undefined): ProviderCatalogEntry | undefined {
  if (!name) {
    return undefined;
  }
  return ALIAS_INDEX.get(normalize(name));
}

export function inferProviderFromModel(model: string | null | undefined): ProviderCatalogEntry | undefined {
  const modelLower = model?.trim().toLowerCase();
  if (!modelLower) {
    return undefined;
  }
  const slashPrefix = modelLower.includes("/") ? modelLower.split("/", 1)[0] : "";
  const prefixed = slashPrefix ? findCatalogEntry(slashPrefix) : undefined;
  if (prefixed) {
    return prefixed;
  }
  for (const catalogEntry of CATALOG) {
    if (catalogEntry.curatedModelIds.some((item) => item.toLowerCase() === modelLower)) {
      return catalogEntry;
    }
  }
  const normalizedModel = normalize(modelLower);
  for (const catalogEntry of CATALOG) {
    for (const term of [...catalogEntry.modelPrefixes, ...catalogEntry.aliases]) {
      const normalizedTerm = normalize(term);
      if (
        normalizedTerm &&
        (normalizedModel === normalizedTerm ||
          normalizedModel.startsWith(`${normalizedTerm}_`) ||
          normalizedModel.includes(normalizedTerm))
      ) {
        return catalogEntry;
      }
    }
  }
  return undefined;
}

export function isGatewayProvider(entry: ProviderCatalogEntry | undefined): boolean {
  return Boolean(entry?.categories.includes("aggregator"));
}

export function isLocalProvider(entry: ProviderCatalogEntry | undefined): boolean {
  return Boolean(entry?.categories.includes("local"));
}

export function isCustomProvider(entry: ProviderCatalogEntry | undefined): boolean {
  return Boolean(entry?.categories.includes("custom"));
}

function entry(value: Partial<ProviderCatalogEntry> & Pick<ProviderCatalogEntry, "id" | "displayName">): ProviderCatalogEntry {
  return {
    aliases: [],
    categories: ["built_in"],
    apiKeyEnvVars: [],
    apiBaseEnvVars: [],
    apiMode: "openai_chat_completions",
    supportsModelDiscovery: true,
    curatedModelIds: [],
    modelPrefixes: [],
    backend: "openai",
    ...value,
    requestTraits: { ...DEFAULT_REQUEST_TRAITS, ...(value.requestTraits ?? {}) },
  };
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
