"""Provider-aware model listing and validation."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
import os
from typing import Any

from tinybot.providers.catalog import (
    ProviderCatalogEntry,
    find_catalog_entry,
    infer_provider_from_model,
)
from tinybot.providers.discovery import (
    fetch_openai_compatible_models,
    join_models_url,
    probe_openai_compatible_models,
)
from tinybot.providers.runtime import resolve_runtime_provider

ModelFetcher = Callable[[str, dict[str, str]], Awaitable[list[str]]]


@dataclass(frozen=True)
class ProviderModel:
    id: str
    sources: tuple[str, ...]


@dataclass(frozen=True)
class ProviderModelList:
    ok: bool
    models: tuple[ProviderModel, ...]
    source_counts: dict[str, int]
    warning: str | None = None
    url: str | None = None

    def by_id(self, model_id: str) -> ProviderModel:
        for model in self.models:
            if model.id == model_id:
                return model
        raise KeyError(model_id)


@dataclass(frozen=True)
class ModelValidationResult:
    ok: bool
    message: str | None = None


def _add_models(
    merged: dict[str, list[str]],
    source_counts: dict[str, int],
    source: str,
    model_ids: tuple[str, ...] | list[str],
) -> None:
    for model_id in model_ids:
        clean = str(model_id).strip()
        if not clean:
            continue
        sources = merged.setdefault(clean, [])
        if source in sources:
            continue
        sources.append(source)
        if len(sources) == 1:
            source_counts[source] += 1


def _configured_models(provider_config: Any) -> tuple[str, ...]:
    models = getattr(provider_config, "models", None)
    if not models:
        return ()
    return tuple(str(model).strip() for model in models if str(model).strip())


def _manual_models(provider_config: Any, manual_model_ids: tuple[str, ...]) -> tuple[str, ...]:
    configured = getattr(provider_config, "manual_models", None) or ()
    return tuple(
        str(model).strip()
        for model in (*configured, *manual_model_ids)
        if str(model).strip()
    )


def _live_discovery_allowed(
    *,
    catalog: ProviderCatalogEntry | None,
    supports_model_discovery: bool,
    api_key: str | None,
    api_base: str | None,
) -> tuple[bool, str | None]:
    if not supports_model_discovery:
        return False, None
    if not api_base:
        return False, "live discovery skipped: api_base is required"
    key_required = bool(catalog and catalog.api_key_env_vars and not catalog.is_local)
    if key_required and not api_key:
        return False, "live discovery skipped: api key is required"
    return True, None


def _model_request_headers(api_key: str | None) -> dict[str, str]:
    headers = {
        "Accept": "application/json",
        "User-Agent": "tinybot/provider-model-discovery",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


async def list_provider_models(
    config: Any,
    *,
    provider_id: str,
    profile_id: str | None = None,
    api_key: str | None = None,
    api_base: str | None = None,
    manual_model_ids: tuple[str, ...] = (),
    refresh_live: bool = False,
    fetcher: ModelFetcher = fetch_openai_compatible_models,
) -> ProviderModelList:
    """Merge curated, profile, live, and manual model ids for a provider."""

    profile = config.providers.profiles.get(profile_id) if config and profile_id else None
    effective_provider_id = provider_id or (profile.provider if profile else "")
    resolved = resolve_runtime_provider(
        config,
        provider=effective_provider_id,
    )
    if profile:
        provider_config = profile
        catalog = find_catalog_entry(profile.provider)
        supports_model_discovery = profile.supports_model_discovery
        resolved_api_key = ""
        if catalog:
            for env_name in catalog.api_key_env_vars:
                resolved_api_key = os.environ.get(env_name, "")
                if resolved_api_key:
                    break
        effective_api_key = api_key or profile.api_key or resolved_api_key or None
        effective_api_base = api_base or profile.api_base or (catalog.default_api_base if catalog else None)
    else:
        provider_config = resolved.provider_config
        catalog = resolved.catalog or find_catalog_entry(effective_provider_id)
        supports_model_discovery = resolved.supports_model_discovery
        effective_api_key = api_key or resolved.api_key
        effective_api_base = api_base or resolved.api_base or (catalog.default_api_base if catalog else None)

    merged: dict[str, list[str]] = {}
    source_counts = {"curated": 0, "profile": 0, "live": 0, "manual": 0}
    if catalog:
        _add_models(merged, source_counts, "curated", catalog.curated_model_ids)
    _add_models(merged, source_counts, "profile", _configured_models(provider_config))
    _add_models(merged, source_counts, "manual", _manual_models(provider_config, manual_model_ids))

    warning: str | None = None
    models_url = join_models_url(effective_api_base)
    if refresh_live:
        allowed, skipped_warning = _live_discovery_allowed(
            catalog=catalog,
            supports_model_discovery=supports_model_discovery,
            api_key=effective_api_key,
            api_base=effective_api_base,
        )
        if allowed:
            headers = _model_request_headers(effective_api_key)
            try:
                if fetcher is fetch_openai_compatible_models:
                    probe = await probe_openai_compatible_models(
                        api_base=effective_api_base,
                        headers=headers,
                        provider_id=catalog.id if catalog else effective_provider_id,
                    )
                    live_models = list(probe.models)
                    models_url = probe.url
                    if probe.suggested_api_base:
                        warning = f"live discovery used fallback base URL: {probe.suggested_api_base}"
                else:
                    live_models = await fetcher(models_url, headers)
                _add_models(merged, source_counts, "live", live_models)
            except Exception as exc:
                warning = f"live discovery failed: {exc}"
        else:
            warning = skipped_warning

    models = tuple(
        ProviderModel(id=model_id, sources=tuple(sources))
        for model_id, sources in merged.items()
    )
    return ProviderModelList(
        ok=bool(models),
        models=models,
        source_counts=source_counts,
        warning=warning,
        url=models_url or None,
    )


def validate_model_for_provider(
    config: Any,
    *,
    provider_id: str,
    model: str,
) -> ModelValidationResult:
    """Validate a model id against resolved provider context."""

    catalog = find_catalog_entry(provider_id)
    inferred = infer_provider_from_model(model)
    if catalog and inferred and inferred.id != catalog.id:
        if catalog.is_custom or catalog.is_local or catalog.is_gateway:
            return ModelValidationResult(ok=True)
        return ModelValidationResult(
            ok=False,
            message=(
                f"Model '{model}' appears to belong to provider "
                f"'{inferred.id}', not '{catalog.id}'."
            ),
        )
    return ModelValidationResult(ok=True)
