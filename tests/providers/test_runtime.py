"""Tests for runtime provider resolution."""

import pytest

from tinybot.config.schema import Config
from tinybot.providers.runtime import resolve_runtime_provider


def test_runtime_resolution_prefers_active_profile():
    config = Config.model_validate(
        {
            "agents": {
                "defaults": {
                    "model": "qwen3-coder-plus",
                    "active_profile": "dashscope-coding",
                },
            },
            "providers": {
                "profiles": {
                    "dashscope-coding": {
                        "provider": "dashscope",
                        "api_key": "profile-key",
                        "api_base": "https://example.test/compatible/v1",
                        "models": ["qwen3-coder-plus"],
                        "manual_models": "manual-a\nmanual-b",
                        "supports_model_discovery": False,
                        "extra_body": {"enable_search": True},
                    },
                },
            },
        }
    )

    resolved = resolve_runtime_provider(config)

    assert resolved.provider_id == "dashscope"
    assert resolved.profile_name == "dashscope-coding"
    assert resolved.source == "profile"
    assert resolved.api_key == "profile-key"
    assert resolved.api_key_source == "config"
    assert resolved.api_base == "https://example.test/compatible/v1"
    assert resolved.models == ("qwen3-coder-plus",)
    assert resolved.manual_model_ids == ("manual-a", "manual-b")
    assert resolved.supports_model_discovery is False
    assert resolved.extra_body == {"enable_search": True}


def test_runtime_resolution_uses_explicit_catalog_provider():
    config = Config.model_validate(
        {
            "agents": {
                "defaults": {
                    "provider": "openrouter",
                    "model": "openai/gpt-4o-mini",
                },
            },
            "providers": {
                "openrouter": {
                    "api_key": "or-key",
                    "api_base": "https://custom-openrouter.test/v1",
                },
            },
        }
    )

    resolved = resolve_runtime_provider(config)

    assert resolved.provider_id == "openrouter"
    assert resolved.source == "explicit"
    assert resolved.api_key == "or-key"
    assert resolved.api_base == "https://custom-openrouter.test/v1"
    assert config.get_provider_name() == "openrouter"


def test_runtime_resolution_infers_from_model_prefix_and_catalog_models():
    prefix_config = Config.model_validate(
        {
            "agents": {"defaults": {"model": "glm-4-plus"}},
            "providers": {"zhipu": {"api_key": "zhipu-key"}},
        }
    )
    curated_config = Config.model_validate(
        {
            "agents": {"defaults": {"model": "moonshot-v1-8k"}},
            "providers": {"moonshot": {"api_key": "moonshot-key"}},
        }
    )

    assert resolve_runtime_provider(prefix_config).provider_id == "zhipu"
    assert resolve_runtime_provider(curated_config).provider_id == "moonshot"


def test_runtime_resolution_uses_environment_key_when_config_key_missing(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "env-openrouter-key")
    config = Config.model_validate(
        {
            "agents": {
                "defaults": {
                    "provider": "openrouter",
                    "model": "openai/gpt-4o-mini",
                },
            },
        }
    )

    resolved = resolve_runtime_provider(config)

    assert resolved.api_key == "env-openrouter-key"
    assert resolved.api_key_source == "env:OPENROUTER_API_KEY"
    assert resolved.api_base == "https://openrouter.ai/api/v1"


def test_runtime_resolution_uses_environment_api_base_when_config_base_missing(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://deepseek-proxy.test/v1")
    config = Config.model_validate(
        {
            "agents": {
                "defaults": {
                    "provider": "deepseek",
                    "model": "deepseek-v4-flash",
                },
            },
            "providers": {"deepseek": {"api_key": "deepseek-key"}},
        }
    )

    resolved = resolve_runtime_provider(config)

    assert resolved.api_base == "https://deepseek-proxy.test/v1"


def test_runtime_resolution_preserves_legacy_builtin_configs():
    config = Config.model_validate(
        {
            "agents": {"defaults": {"provider": "deepseek", "model": "deepseek-chat"}},
            "providers": {
                "deepseek": {"api_key": "deepseek-key"},
                "dashscope": {"api_key": "dashscope-key"},
            },
        }
    )

    resolved = resolve_runtime_provider(config)

    assert resolved.provider_id == "deepseek"
    assert resolved.api_key == "deepseek-key"
    assert config.get_api_key() == "deepseek-key"


@pytest.mark.parametrize(
    ("provider_id", "model", "api_key"),
    [
        ("openai", "gpt-4o-mini", "openai-key"),
        ("deepseek", "deepseek-chat", "deepseek-key"),
        ("dashscope", "qwen-max", "dashscope-key"),
    ],
)
def test_legacy_builtin_provider_configs_still_load_and_resolve(provider_id, model, api_key):
    config = Config.model_validate(
        {
            "agents": {"defaults": {"provider": provider_id, "model": model}},
            "providers": {provider_id: {"api_key": api_key}},
        }
    )

    resolved = resolve_runtime_provider(config)

    assert resolved.provider_id == provider_id
    assert resolved.api_key == api_key
    assert config.get_provider_name() == provider_id
