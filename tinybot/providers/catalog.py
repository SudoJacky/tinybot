"""Provider catalog metadata and lookup helpers."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import StrEnum
from types import MappingProxyType
from typing import Any


class ProviderCategory(StrEnum):
    """High-level provider categories used by config, CLI, and UI."""

    BUILT_IN = "built_in"
    AGGREGATOR = "aggregator"
    LOCAL = "local"
    CUSTOM = "custom"


class ProviderStatus(StrEnum):
    """Provider readiness states used by future status payloads."""

    READY = "ready"
    NEEDS_KEY = "needs_key"
    NO_MODELS = "no_models"
    UNAVAILABLE = "unavailable"
    UNSUPPORTED = "unsupported"


class ApiMode(StrEnum):
    """Runtime API transport modes."""

    OPENAI_CHAT_COMPLETIONS = "openai_chat_completions"
    UNSUPPORTED = "unsupported"


class TokenParameter(StrEnum):
    """OpenAI-compatible token limit parameter names."""

    MAX_TOKENS = "max_tokens"
    MAX_COMPLETION_TOKENS = "max_completion_tokens"


class TemperaturePolicy(StrEnum):
    """Provider/model temperature handling policy."""

    STANDARD = "standard"
    OMIT_FOR_REASONING = "omit_for_reasoning"
    OMIT = "omit"


@dataclass(frozen=True)
class RequestTraits:
    """Provider-specific OpenAI-compatible request behavior."""

    token_parameter: TokenParameter = TokenParameter.MAX_TOKENS
    temperature_policy: TemperaturePolicy = TemperaturePolicy.STANDARD
    strip_model_prefix: bool = False
    extra_body_defaults: MappingProxyType[str, Any] = field(
        default_factory=lambda: MappingProxyType({})
    )
    supports_prompt_caching: bool = False


@dataclass(frozen=True)
class ProviderCatalogEntry:
    """Immutable provider catalog entry."""

    id: str
    display_name: str
    aliases: tuple[str, ...] = ()
    categories: tuple[ProviderCategory, ...] = (ProviderCategory.BUILT_IN,)
    default_api_base: str = ""
    api_key_env_vars: tuple[str, ...] = ()
    api_base_env_vars: tuple[str, ...] = ()
    api_mode: ApiMode = ApiMode.OPENAI_CHAT_COMPLETIONS
    supports_model_discovery: bool = True
    curated_model_ids: tuple[str, ...] = ()
    model_prefixes: tuple[str, ...] = ()
    request_traits: RequestTraits = field(default_factory=RequestTraits)
    backend: str = "openai"
    detect_by_key_prefix: str = ""
    detect_by_base_keyword: str = ""

    @property
    def primary_api_key_env_var(self) -> str:
        return self.api_key_env_vars[0] if self.api_key_env_vars else ""

    @property
    def is_gateway(self) -> bool:
        return ProviderCategory.AGGREGATOR in self.categories

    @property
    def is_local(self) -> bool:
        return ProviderCategory.LOCAL in self.categories

    @property
    def is_custom(self) -> bool:
        return ProviderCategory.CUSTOM in self.categories

    @property
    def match_terms(self) -> tuple[str, ...]:
        return _dedupe((
            self.id,
            self.display_name,
            *self.aliases,
            *self.model_prefixes,
            *self.curated_model_ids,
        ))


def _dedupe(values: tuple[str, ...]) -> tuple[str, ...]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = value.strip()
        if not normalized:
            continue
        key = normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(normalized)
    return tuple(result)


def _extra_body_defaults(**values: Any) -> MappingProxyType[str, Any]:
    return MappingProxyType(dict(values))


def _normalize(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", value.strip().lower())
    return normalized.strip("_")


_OPENROUTER_MODELS = (
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
    "xiaomi/mimo-v2.5-pro",
    "tencent/hy3-preview",
    "google/gemini-3-pro-image-preview",
    "google/gemini-3-flash-preview",
    "google/gemini-3.1-pro-preview",
    "google/gemini-3.1-flash-lite-preview",
    "qwen/qwen3.6-35b-a3b",
    "stepfun/step-3.5-flash",
    "minimax/minimax-m2.7",
    "z-ai/glm-5.1",
    "x-ai/grok-4.3",
    "nvidia/nemotron-3-super-120b-a12b",
    "deepseek/deepseek-v4-pro",
    "openrouter/elephant-alpha",
    "openrouter/owl-alpha",
    "tencent/hy3-preview:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "inclusionai/ring-2.6-1t:free",
)

_VERCEL_AI_GATEWAY_MODELS = (
    "moonshotai/kimi-k2.6",
    "alibaba/qwen3.6-plus",
    "zai/glm-5.1",
    "minimax/minimax-m2.7",
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-opus-4.7",
    "anthropic/claude-opus-4.6",
    "anthropic/claude-haiku-4.5",
    "openai/gpt-5.4",
    "openai/gpt-5.4-mini",
    "openai/gpt-5.3-codex",
    "google/gemini-3.1-pro-preview",
    "google/gemini-3-flash",
    "google/gemini-3.1-flash-lite-preview",
    "xai/grok-4.20-reasoning",
)


_CATALOG: tuple[ProviderCatalogEntry, ...] = (
    ProviderCatalogEntry(
        id="openai",
        display_name="OpenAI",
        aliases=("gpt", "chatgpt"),
        default_api_base="https://api.openai.com/v1",
        api_key_env_vars=("OPENAI_API_KEY",),
        api_base_env_vars=("OPENAI_BASE_URL",),
        curated_model_ids=(
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
        ),
        model_prefixes=("gpt", "o1", "o3", "o4"),
        request_traits=RequestTraits(
            token_parameter=TokenParameter.MAX_COMPLETION_TOKENS,
            temperature_policy=TemperaturePolicy.OMIT_FOR_REASONING,
        ),
    ),
    ProviderCatalogEntry(
        id="deepseek",
        display_name="DeepSeek",
        aliases=("deep seek",),
        default_api_base="https://api.deepseek.com",
        api_key_env_vars=("DEEPSEEK_API_KEY",),
        api_base_env_vars=("DEEPSEEK_BASE_URL",),
        curated_model_ids=(
            "deepseek-v4-pro",
            "deepseek-v4-flash",
            "deepseek-chat",
            "deepseek-reasoner",
        ),
        model_prefixes=("deepseek",),
    ),
    ProviderCatalogEntry(
        id="dashscope",
        display_name="DashScope",
        aliases=("alibaba", "alibaba cloud", "aliyun", "qwen"),
        default_api_base="https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_key_env_vars=("DASHSCOPE_API_KEY",),
        api_base_env_vars=("DASHSCOPE_BASE_URL",),
        curated_model_ids=(
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
        ),
        model_prefixes=("qwen", "alibaba"),
    ),
    ProviderCatalogEntry(
        id="openrouter",
        display_name="OpenRouter",
        aliases=("open router",),
        categories=(ProviderCategory.BUILT_IN, ProviderCategory.AGGREGATOR),
        default_api_base="https://openrouter.ai/api/v1",
        api_key_env_vars=("OPENROUTER_API_KEY", "OPENAI_API_KEY"),
        api_base_env_vars=("OPENROUTER_BASE_URL",),
        curated_model_ids=_OPENROUTER_MODELS,
        model_prefixes=(
            "openrouter",
            "anthropic",
            "openai",
            "google",
            "qwen",
            "moonshotai",
            "x-ai",
            "z-ai",
        ),
        request_traits=RequestTraits(strip_model_prefix=True),
        detect_by_key_prefix="sk-or-",
        detect_by_base_keyword="openrouter.ai",
    ),
    ProviderCatalogEntry(
        id="ollama",
        display_name="Ollama",
        aliases=("local ollama",),
        categories=(ProviderCategory.LOCAL,),
        default_api_base="http://127.0.0.1:11434/v1",
        api_key_env_vars=(),
        curated_model_ids=("llama3.1", "qwen2.5", "mistral"),
        model_prefixes=("ollama", "llama", "mistral"),
        detect_by_base_keyword="11434",
    ),
    ProviderCatalogEntry(
        id="lm_studio",
        display_name="LM Studio",
        aliases=("lm-studio", "lmstudio"),
        categories=(ProviderCategory.LOCAL,),
        default_api_base="http://127.0.0.1:1234/v1",
        api_key_env_vars=("LM_API_KEY",),
        api_base_env_vars=("LM_BASE_URL",),
        curated_model_ids=(),
        model_prefixes=("lmstudio", "lm_studio"),
        detect_by_base_keyword="1234",
    ),
    ProviderCatalogEntry(
        id="custom",
        display_name="Custom OpenAI-compatible",
        aliases=("custom", "openai compatible", "compatible endpoint"),
        categories=(ProviderCategory.CUSTOM,),
        api_key_env_vars=(),
        supports_model_discovery=True,
    ),
    ProviderCatalogEntry(
        id="siliconflow",
        display_name="SiliconFlow",
        aliases=("silicon flow",),
        default_api_base="https://api.siliconflow.cn/v1",
        api_key_env_vars=("SILICONFLOW_API_KEY",),
        api_base_env_vars=("SILICONFLOW_BASE_URL",),
        curated_model_ids=(
            "deepseek-ai/DeepSeek-V3",
            "deepseek-ai/DeepSeek-V3.2",
            "Qwen/Qwen3.5-397B-A17B",
            "Qwen/Qwen3.5-35B-A3B",
            "Qwen/Qwen2.5-72B-Instruct",
        ),
        model_prefixes=("siliconflow", "deepseek-ai", "Qwen"),
        detect_by_base_keyword="siliconflow.cn",
    ),
    ProviderCatalogEntry(
        id="moonshot",
        display_name="Moonshot AI",
        aliases=("moonshot", "kimi", "kimi-coding", "kimi-coding-cn", "kimi-for-coding"),
        default_api_base="https://api.moonshot.cn/v1",
        api_key_env_vars=("MOONSHOT_API_KEY", "KIMI_API_KEY"),
        api_base_env_vars=("MOONSHOT_BASE_URL", "KIMI_BASE_URL"),
        curated_model_ids=(
            "kimi-k2.6",
            "kimi-k2.5",
            "kimi-for-coding",
            "kimi-k2-thinking",
            "kimi-k2-thinking-turbo",
            "kimi-k2-turbo-preview",
            "kimi-k2-0905-preview",
            "moonshot-v1-8k",
            "moonshot-v1-32k",
        ),
        model_prefixes=("moonshot", "kimi"),
        detect_by_base_keyword="moonshot.cn",
    ),
    ProviderCatalogEntry(
        id="zhipu",
        display_name="Zhipu AI",
        aliases=("zai", "z-ai", "z.ai", "zhipu", "glm", "bigmodel"),
        default_api_base="https://open.bigmodel.cn/api/paas/v4",
        api_key_env_vars=("ZHIPUAI_API_KEY", "ZHIPU_API_KEY", "GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"),
        api_base_env_vars=("ZHIPU_BASE_URL", "GLM_BASE_URL"),
        curated_model_ids=(
            "glm-5.1",
            "glm-5",
            "glm-5v-turbo",
            "glm-5-turbo",
            "glm-4.7",
            "glm-4.5",
            "glm-4.5-flash",
            "glm-4-plus",
            "glm-4-air",
            "glm-4-flash",
        ),
        model_prefixes=("glm",),
        detect_by_base_keyword="bigmodel.cn",
    ),
    ProviderCatalogEntry(
        id="modelscope",
        display_name="ModelScope",
        aliases=("model scope",),
        default_api_base="https://api-inference.modelscope.cn/v1",
        api_key_env_vars=("MODELSCOPE_API_KEY",),
        api_base_env_vars=("MODELSCOPE_BASE_URL",),
        curated_model_ids=("Qwen/Qwen2.5-72B-Instruct", "deepseek-ai/DeepSeek-V3"),
        model_prefixes=("modelscope",),
        detect_by_base_keyword="modelscope.cn",
    ),
    ProviderCatalogEntry(
        id="stepfun",
        display_name="StepFun",
        aliases=("step", "stepfun-coding-plan"),
        default_api_base="https://api.stepfun.ai/step_plan/v1",
        api_key_env_vars=("STEPFUN_API_KEY",),
        api_base_env_vars=("STEPFUN_BASE_URL",),
        curated_model_ids=("step-3.5-flash", "step-3.5-flash-2603"),
        model_prefixes=("step", "stepfun"),
        detect_by_base_keyword="stepfun.ai",
    ),
    ProviderCatalogEntry(
        id="vercel",
        display_name="Vercel AI Gateway",
        aliases=("ai-gateway", "aigateway", "vercel-ai-gateway"),
        categories=(ProviderCategory.BUILT_IN, ProviderCategory.AGGREGATOR),
        default_api_base="https://ai-gateway.vercel.sh/v1",
        api_key_env_vars=("AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"),
        api_base_env_vars=("AI_GATEWAY_BASE_URL", "VERCEL_AI_GATEWAY_BASE_URL"),
        curated_model_ids=_VERCEL_AI_GATEWAY_MODELS,
        model_prefixes=("vercel", "alibaba", "zai", "minimax", "anthropic", "openai", "google", "xai"),
        request_traits=RequestTraits(strip_model_prefix=True),
        detect_by_base_keyword="ai-gateway.vercel.sh",
    ),
    ProviderCatalogEntry(
        id="opencode",
        display_name="OpenCode Zen",
        aliases=("opencode-zen", "zen"),
        categories=(ProviderCategory.BUILT_IN, ProviderCategory.AGGREGATOR),
        api_key_env_vars=("OPENCODE_ZEN_API_KEY",),
        api_base_env_vars=("OPENCODE_ZEN_BASE_URL",),
        curated_model_ids=(
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
        ),
        model_prefixes=("opencode", "kimi", "gpt", "claude", "gemini", "glm", "qwen"),
    ),
    ProviderCatalogEntry(
        id="opencode_go",
        display_name="OpenCode Go",
        aliases=("opencode-go", "opencode-go-sub"),
        categories=(ProviderCategory.BUILT_IN, ProviderCategory.AGGREGATOR),
        api_key_env_vars=("OPENCODE_GO_API_KEY",),
        api_base_env_vars=("OPENCODE_GO_BASE_URL",),
        curated_model_ids=(
            "kimi-k2.6",
            "kimi-k2.5",
            "glm-5.1",
            "glm-5",
            "mimo-v2.5-pro",
            "mimo-v2.5",
            "mimo-v2-pro",
            "mimo-v2-omni",
            "minimax-m2.7",
            "minimax-m2.5",
            "qwen3.6-plus",
            "qwen3.5-plus",
        ),
        model_prefixes=("opencode", "kimi", "glm", "mimo", "minimax", "qwen"),
    ),
    ProviderCatalogEntry(
        id="kilocode",
        display_name="KiloCode",
        aliases=("kilo", "kilo-code", "kilo-gateway"),
        categories=(ProviderCategory.BUILT_IN, ProviderCategory.AGGREGATOR),
        api_key_env_vars=("KILOCODE_API_KEY",),
        api_base_env_vars=("KILOCODE_BASE_URL",),
        curated_model_ids=(
            "anthropic/claude-opus-4.6",
            "anthropic/claude-sonnet-4.6",
            "openai/gpt-5.4",
            "google/gemini-3-pro-preview",
            "google/gemini-3-flash-preview",
        ),
        model_prefixes=("kilo", "anthropic", "openai", "google"),
    ),
    ProviderCatalogEntry(
        id="huggingface",
        display_name="Hugging Face",
        aliases=("hf", "hugging-face", "huggingface-hub"),
        categories=(ProviderCategory.BUILT_IN, ProviderCategory.AGGREGATOR),
        default_api_base="https://router.huggingface.co/v1",
        api_key_env_vars=("HF_TOKEN", "HUGGINGFACE_API_KEY"),
        api_base_env_vars=("HF_BASE_URL", "HUGGINGFACE_BASE_URL"),
        curated_model_ids=(
            "moonshotai/Kimi-K2.5",
            "Qwen/Qwen3.5-397B-A17B",
            "Qwen/Qwen3.5-35B-A3B",
            "deepseek-ai/DeepSeek-V3.2",
            "MiniMaxAI/MiniMax-M2.5",
            "zai-org/GLM-5",
            "XiaomiMiMo/MiMo-V2-Flash",
            "moonshotai/Kimi-K2-Thinking",
            "moonshotai/Kimi-K2.6",
        ),
        model_prefixes=("huggingface", "moonshotai", "Qwen", "deepseek-ai", "MiniMaxAI", "zai-org"),
        detect_by_base_keyword="huggingface.co",
    ),
    ProviderCatalogEntry(
        id="novita",
        display_name="Novita AI",
        aliases=("novita-ai", "novitaai"),
        categories=(ProviderCategory.BUILT_IN, ProviderCategory.AGGREGATOR),
        default_api_base="https://api.novita.ai/v3/openai",
        api_key_env_vars=("NOVITA_API_KEY",),
        api_base_env_vars=("NOVITA_BASE_URL",),
        curated_model_ids=(
            "moonshotai/kimi-k2.5",
            "minimax/minimax-m2.7",
            "zai-org/glm-5",
            "deepseek/deepseek-v3-0324",
            "deepseek/deepseek-r1-0528",
            "qwen/qwen3-235b-a22b-fp8",
        ),
        model_prefixes=("novita", "moonshotai", "minimax", "zai-org", "deepseek", "qwen"),
        detect_by_base_keyword="novita.ai",
    ),
    ProviderCatalogEntry(
        id="nvidia",
        display_name="NVIDIA NIM",
        aliases=("nim", "nvidia-nim", "build-nvidia", "nemotron"),
        default_api_base="https://integrate.api.nvidia.com/v1",
        api_key_env_vars=("NVIDIA_API_KEY",),
        api_base_env_vars=("NVIDIA_BASE_URL",),
        curated_model_ids=(
            "nvidia/nemotron-3-super-120b-a12b",
            "nvidia/nemotron-3-nano-30b-a3b",
            "nvidia/llama-3.3-nemotron-super-49b-v1.5",
            "qwen/qwen3.5-397b-a17b",
            "deepseek-ai/deepseek-v3.2",
            "moonshotai/kimi-k2.6",
            "minimaxai/minimax-m2.5",
            "z-ai/glm5",
            "openai/gpt-oss-120b",
        ),
        model_prefixes=("nvidia", "nemotron"),
        detect_by_base_keyword="nvidia.com",
    ),
    ProviderCatalogEntry(
        id="xiaomi",
        display_name="Xiaomi MiMo",
        aliases=("mimo", "xiaomi-mimo"),
        api_key_env_vars=("XIAOMI_API_KEY",),
        api_base_env_vars=("XIAOMI_BASE_URL",),
        curated_model_ids=("mimo-v2.5-pro", "mimo-v2.5", "mimo-v2-pro", "mimo-v2-omni", "mimo-v2-flash"),
        model_prefixes=("mimo", "xiaomi"),
    ),
    ProviderCatalogEntry(
        id="tencent_tokenhub",
        display_name="Tencent TokenHub",
        aliases=("tencent-tokenhub", "tencent", "tokenhub", "tencent-cloud", "tencentmaas"),
        api_key_env_vars=("TOKENHUB_API_KEY", "TENCENT_API_KEY"),
        api_base_env_vars=("TOKENHUB_BASE_URL",),
        curated_model_ids=("hy3-preview",),
        model_prefixes=("hy3", "tencent", "tokenhub"),
    ),
    ProviderCatalogEntry(
        id="arcee",
        display_name="Arcee AI",
        aliases=("arcee-ai", "arceeai"),
        default_api_base="https://api.arcee.ai/api/v1",
        api_key_env_vars=("ARCEE_API_KEY",),
        api_base_env_vars=("ARCEE_BASE_URL",),
        curated_model_ids=("trinity-large-thinking", "trinity-large-preview", "trinity-mini"),
        model_prefixes=("trinity", "arcee"),
        detect_by_base_keyword="arcee.ai",
    ),
    ProviderCatalogEntry(
        id="gmi",
        display_name="GMI Cloud",
        aliases=("gmi-cloud", "gmicloud"),
        default_api_base="https://api.gmi-serving.com/v1",
        api_key_env_vars=("GMI_API_KEY",),
        api_base_env_vars=("GMI_BASE_URL",),
        curated_model_ids=(
            "zai-org/GLM-5.1-FP8",
            "deepseek-ai/DeepSeek-V3.2",
            "moonshotai/Kimi-K2.5",
            "google/gemini-3.1-flash-lite-preview",
            "anthropic/claude-sonnet-4.6",
            "openai/gpt-5.4",
        ),
        model_prefixes=("gmi", "zai-org", "deepseek-ai", "moonshotai", "google", "anthropic", "openai"),
        detect_by_base_keyword="gmi-serving.com",
    ),
    ProviderCatalogEntry(
        id="ollama_cloud",
        display_name="Ollama Cloud",
        aliases=("ollama-cloud",),
        default_api_base="https://ollama.com/v1",
        api_key_env_vars=("OLLAMA_API_KEY",),
        api_base_env_vars=("OLLAMA_BASE_URL",),
        curated_model_ids=(),
        model_prefixes=("ollama-cloud",),
        detect_by_base_keyword="ollama.com",
    ),
)

_ALIAS_INDEX: dict[str, ProviderCatalogEntry] = {}
for _entry in _CATALOG:
    for _term in (_entry.id, _entry.display_name, *_entry.aliases):
        _ALIAS_INDEX.setdefault(_normalize(_term), _entry)


def list_catalog_entries() -> tuple[ProviderCatalogEntry, ...]:
    """Return catalog entries in match-priority order."""

    return _CATALOG


def find_catalog_entry(name: str | None) -> ProviderCatalogEntry | None:
    """Find a catalog entry by id, display name, or alias."""

    if not name:
        return None
    return _ALIAS_INDEX.get(_normalize(name))


def infer_provider_from_model(model: str | None) -> ProviderCatalogEntry | None:
    """Infer a provider from a model id, provider prefix, alias, or curated model."""

    if not model:
        return None
    model_lower = model.strip().lower()
    if not model_lower:
        return None

    prefix = model_lower.split("/", 1)[0] if "/" in model_lower else ""
    if prefix:
        prefixed = find_catalog_entry(prefix)
        if prefixed:
            return prefixed

    for entry in _CATALOG:
        if model_lower in {item.lower() for item in entry.curated_model_ids}:
            return entry

    normalized_model = _normalize(model_lower)
    for entry in _CATALOG:
        for term in (*entry.model_prefixes, *entry.aliases):
            normalized_term = _normalize(term)
            if normalized_term and (
                normalized_model == normalized_term
                or normalized_model.startswith(f"{normalized_term}_")
                or normalized_term in normalized_model
            ):
                return entry
    return None
