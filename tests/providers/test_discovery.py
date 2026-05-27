"""Tests for provider model discovery helpers."""

from tinybot.providers.discovery import (
    candidate_model_endpoints,
    extract_model_ids,
    probe_openai_compatible_models,
)


def test_candidate_model_endpoints_try_base_and_v1_variants():
    assert candidate_model_endpoints("https://api.example.test") == (
        ("https://api.example.test/models", "https://api.example.test", False),
        ("https://api.example.test/v1/models", "https://api.example.test/v1", True),
    )
    assert candidate_model_endpoints("https://api.example.test/v1") == (
        ("https://api.example.test/v1/models", "https://api.example.test/v1", False),
        ("https://api.example.test/models", "https://api.example.test", True),
    )


def test_extract_model_ids_filters_vercel_language_tool_models():
    payload = {
        "data": [
            {"id": "openai/gpt-5.4", "type": "language", "tags": ["tool-use"]},
            {"id": "image-model", "type": "image", "tags": ["tool-use"]},
            {"id": "language-no-tools", "type": "language", "tags": ["vision"]},
        ],
    }

    assert extract_model_ids(payload, provider_id="vercel") == ["openai/gpt-5.4"]


async def test_probe_openai_compatible_models_falls_back_to_v1_base():
    calls: list[str] = []

    async def fetch_json(url, headers):
        calls.append(url)
        if url == "https://api.example.test/models":
            raise RuntimeError("not found")
        return {"data": [{"id": "model-a"}]}

    result = await probe_openai_compatible_models(
        api_base="https://api.example.test",
        headers={"Accept": "application/json"},
        fetch_json=fetch_json,
    )

    assert calls == ["https://api.example.test/models", "https://api.example.test/v1/models"]
    assert result.models == ("model-a",)
    assert result.url == "https://api.example.test/v1/models"
    assert result.suggested_api_base == "https://api.example.test/v1"
    assert result.used_fallback is True
