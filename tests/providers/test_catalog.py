"""Tests for provider catalog metadata and lookup helpers."""

from tinybot.providers.catalog import (
    ApiMode,
    ProviderCategory,
    RequestTraits,
    find_catalog_entry,
    infer_provider_from_model,
    list_catalog_entries,
)


def test_catalog_contains_initial_builtin_local_and_custom_providers():
    provider_ids = {entry.id for entry in list_catalog_entries()}

    assert {
        "openai",
        "deepseek",
        "dashscope",
        "openrouter",
        "ollama",
        "lm_studio",
        "custom",
    } <= provider_ids


def test_catalog_contains_additional_openai_compatible_providers():
    provider_ids = {entry.id for entry in list_catalog_entries()}

    assert {
        "siliconflow",
        "moonshot",
        "zhipu",
        "modelscope",
        "stepfun",
        "vercel",
        "opencode",
        "opencode_go",
        "kilocode",
        "huggingface",
        "novita",
        "nvidia",
        "xiaomi",
        "tencent_tokenhub",
        "arcee",
        "gmi",
        "ollama_cloud",
    } <= provider_ids


def test_catalog_entry_exposes_metadata_and_request_traits():
    dashscope = find_catalog_entry("DashScope")

    assert dashscope is not None
    assert dashscope.display_name == "DashScope"
    assert dashscope.default_api_base == "https://dashscope.aliyuncs.com/compatible-mode/v1"
    assert dashscope.api_key_env_vars == ("DASHSCOPE_API_KEY",)
    assert dashscope.api_base_env_vars == ("DASHSCOPE_BASE_URL",)
    assert dashscope.api_mode == ApiMode.OPENAI_CHAT_COMPLETIONS
    assert dashscope.supports_model_discovery is True
    assert ProviderCategory.BUILT_IN in dashscope.categories
    assert "qwen-max" in dashscope.curated_model_ids
    assert isinstance(dashscope.request_traits, RequestTraits)


def test_catalog_lookup_matches_ids_display_names_aliases_and_model_prefixes():
    assert find_catalog_entry("lm-studio").id == "lm_studio"
    assert find_catalog_entry("Open Router").id == "openrouter"
    assert find_catalog_entry("ai-gateway").id == "vercel"
    assert find_catalog_entry("opencode-go").id == "opencode_go"
    assert find_catalog_entry("tokenhub").id == "tencent_tokenhub"
    assert find_catalog_entry("kimi").id == "moonshot"
    assert infer_provider_from_model("openrouter/openai/gpt-4o-mini").id == "openrouter"
    assert infer_provider_from_model("qwen-max").id == "dashscope"
    assert infer_provider_from_model("glm-4-plus").id == "zhipu"
    assert infer_provider_from_model("nvidia/nemotron-3-super-120b-a12b").id == "nvidia"
