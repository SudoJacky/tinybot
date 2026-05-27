"""Tests for provider-aware model listing and validation."""

from tinybot.config.schema import Config
from tinybot.providers.models import (
    list_provider_models,
    validate_model_for_provider,
)


async def test_model_listing_merges_curated_profile_live_and_manual_models_without_duplicates():
    async def fetcher(url, headers):
        return ["qwen-live", "qwen-max"]

    config = Config.model_validate(
        {
            "providers": {
                "profiles": {
                    "dashscope-coding": {
                        "provider": "dashscope",
                        "api_key": "key",
                        "models": ["qwen-profile", "qwen-max"],
                        "manual_models": ["qwen-manual"],
                    },
                },
            },
        }
    )

    result = await list_provider_models(
        config,
        provider_id="dashscope",
        profile_id="dashscope-coding",
        refresh_live=True,
        fetcher=fetcher,
    )

    assert [model.id for model in result.models[:3]] == ["qwen-max", "qwen-plus", "qwen-turbo"]
    assert [model.id for model in result.models if model.id == "qwen-max"][0] == "qwen-max"
    assert {source: result.source_counts[source] for source in ("curated", "profile", "live", "manual")} == {
        "curated": 11,
        "profile": 1,
        "live": 1,
        "manual": 1,
    }
    assert result.ok is True
    assert result.warning is None
    assert result.by_id("qwen-max").sources == ("curated", "profile", "live")


async def test_model_listing_preserves_curated_models_when_live_discovery_fails():
    async def fetcher(url, headers):
        raise RuntimeError("network down")

    config = Config.model_validate(
        {
            "agents": {"defaults": {"provider": "dashscope", "model": "qwen-max"}},
            "providers": {"dashscope": {"api_key": "key"}},
        }
    )

    result = await list_provider_models(
        config,
        provider_id="dashscope",
        refresh_live=True,
        fetcher=fetcher,
    )

    assert result.ok is True
    assert "qwen-max" in [model.id for model in result.models]
    assert result.warning == "live discovery failed: network down"


async def test_model_listing_skips_live_discovery_when_disabled():
    calls = 0

    async def fetcher(url, headers):
        nonlocal calls
        calls += 1
        return ["qwen-live"]

    config = Config.model_validate(
        {
            "providers": {
                "profiles": {
                    "dashscope-coding": {
                        "provider": "dashscope",
                        "api_key": "key",
                        "supports_model_discovery": False,
                    },
                },
            },
        }
    )

    result = await list_provider_models(
        config,
        provider_id="dashscope",
        profile_id="dashscope-coding",
        refresh_live=True,
        fetcher=fetcher,
    )

    assert calls == 0
    assert result.source_counts["live"] == 0


def test_model_validation_warns_known_provider_mismatch():
    config = Config.model_validate(
        {
            "agents": {"defaults": {"provider": "deepseek", "model": "qwen-max"}},
            "providers": {"deepseek": {"api_key": "key"}},
        }
    )

    result = validate_model_for_provider(config, provider_id="deepseek", model="qwen-max")

    assert result.ok is False
    assert "appears to belong to provider 'dashscope'" in result.message


def test_model_validation_accepts_unknown_custom_and_aggregator_models():
    config = Config.model_validate(
        {
            "agents": {"defaults": {"provider": "openrouter", "model": "unknown/model"}},
            "providers": {"openrouter": {"api_key": "key"}},
        }
    )

    assert validate_model_for_provider(config, provider_id="openrouter", model="unknown/model").ok is True
    assert validate_model_for_provider(config, provider_id="custom", model="anything-local").ok is True
