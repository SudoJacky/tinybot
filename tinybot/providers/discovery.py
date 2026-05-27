"""OpenAI-compatible provider model discovery helpers."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

JsonFetcher = Callable[[str, Mapping[str, str]], Awaitable[Any]]


@dataclass(frozen=True)
class ModelDiscoveryResult:
    """Result from probing a provider model listing endpoint."""

    models: tuple[str, ...]
    url: str
    resolved_api_base: str
    suggested_api_base: str | None = None
    used_fallback: bool = False


def join_models_url(api_base: str | None) -> str:
    """Return the OpenAI-compatible /models URL for an API base."""

    base = (api_base or "").strip().rstrip("/")
    if not base:
        return ""
    return f"{base}/models"


def candidate_model_endpoints(api_base: str | None) -> tuple[tuple[str, str, bool], ...]:
    """Return model endpoint candidates as (url, resolved_base, fallback_used)."""

    normalized = (api_base or "").strip().rstrip("/")
    if not normalized:
        return ()

    if normalized.endswith("/v1"):
        alternate_base = normalized[:-3].rstrip("/")
    else:
        alternate_base = f"{normalized}/v1"

    candidates = [(join_models_url(normalized), normalized, False)]
    if alternate_base and alternate_base != normalized:
        candidates.append((join_models_url(alternate_base), alternate_base, True))
    return tuple((url, base, fallback) for url, base, fallback in candidates if url)


def extract_model_ids(payload: Any, *, provider_id: str | None = None) -> list[str]:
    """Extract model ids from common /models response shapes."""

    if isinstance(payload, dict):
        raw_items = payload.get("data") or payload.get("models") or payload.get("items") or []
    elif isinstance(payload, list):
        raw_items = payload
    else:
        raw_items = []

    models: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        model_id = ""
        if isinstance(item, str):
            model_id = item
        elif isinstance(item, dict):
            if provider_id == "vercel":
                model_type = item.get("type")
                tags = item.get("tags")
                if model_type and model_type != "language":
                    continue
                if tags and "tool-use" not in tags:
                    continue
            value = item.get("id") or item.get("name") or item.get("model")
            if value:
                model_id = str(value)
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        models.append(model_id)
    return models


async def _fetch_json(url: str, headers: Mapping[str, str]) -> Any:
    import aiohttp

    timeout = aiohttp.ClientTimeout(total=15)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url, headers=dict(headers)) as response:
            text = await response.text()
            if response.status >= 400:
                raise RuntimeError(f"/models returned HTTP {response.status}")
            try:
                return json.loads(text)
            except Exception as exc:
                raise RuntimeError("invalid /models response") from exc


async def fetch_openai_compatible_models(
    url: str,
    headers: dict[str, str],
) -> list[str]:
    """Fetch and parse model ids from an OpenAI-compatible /models endpoint."""

    models = extract_model_ids(await _fetch_json(url, headers))
    if not models:
        raise RuntimeError("no models found in /models response")
    return models


async def probe_openai_compatible_models(
    *,
    api_base: str | None,
    headers: Mapping[str, str],
    provider_id: str | None = None,
    fetch_json: JsonFetcher = _fetch_json,
) -> ModelDiscoveryResult:
    """Probe a provider's /models endpoint, trying both base and /v1 variants."""

    candidates = candidate_model_endpoints(api_base)
    if not candidates:
        raise RuntimeError("api_base is required")

    errors: list[str] = []
    for url, resolved_base, used_fallback in candidates:
        try:
            body = await fetch_json(url, headers)
            models = extract_model_ids(body, provider_id=provider_id)
            if not models:
                raise RuntimeError("no models found in /models response")
            original_base = (api_base or "").strip().rstrip("/")
            suggested_base = resolved_base if used_fallback and resolved_base != original_base else None
            return ModelDiscoveryResult(
                models=tuple(models),
                url=url,
                resolved_api_base=resolved_base,
                suggested_api_base=suggested_base,
                used_fallback=used_fallback,
            )
        except Exception as exc:
            errors.append(f"{url}: {exc}")

    raise RuntimeError("; ".join(errors) if errors else "model discovery failed")
