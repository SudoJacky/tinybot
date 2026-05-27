"""Runtime provider resolution from config, catalog metadata, and env vars."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from pydantic.alias_generators import to_snake

from tinybot.providers.catalog import (
    ApiMode,
    ProviderCatalogEntry,
    RequestTraits,
    find_catalog_entry,
    infer_provider_from_model,
    list_catalog_entries,
)

if TYPE_CHECKING:
    from tinybot.config.schema import Config, ProviderConfig, ProviderProfileConfig


@dataclass(frozen=True)
class ResolvedRuntimeProvider:
    """Provider configuration resolved for one model call."""

    provider_id: str | None
    model: str
    catalog: ProviderCatalogEntry | None = None
    provider_config: ProviderConfig | ProviderProfileConfig | None = None
    profile_name: str | None = None
    source: str = "unresolved"
    api_mode: ApiMode | None = None
    api_key: str | None = None
    api_key_source: str | None = None
    api_base: str | None = None
    models: tuple[str, ...] = ()
    manual_model_ids: tuple[str, ...] = ()
    supports_model_discovery: bool = True
    request_traits: RequestTraits = field(default_factory=RequestTraits)
    extra_body: dict[str, Any] = field(default_factory=dict)
    warnings: tuple[str, ...] = ()


def _normalize_provider_id(value: str | None) -> str | None:
    if value is None:
        return None
    catalog = find_catalog_entry(value)
    if catalog:
        return catalog.id
    normalized = to_snake(str(value).strip().lower().replace("-", "_"))
    return normalized or None


def _provider_config(config: Config, provider_id: str | None) -> ProviderConfig | None:
    if not provider_id:
        return None
    value = getattr(config.providers, provider_id, None)
    if value is None:
        value = (getattr(config.providers, "model_extra", None) or {}).get(provider_id)
    if value is None:
        return None
    if isinstance(value, dict):
        from tinybot.config.schema import ProviderConfig

        return ProviderConfig.model_validate(value)
    return value


def _env_api_key(catalog: ProviderCatalogEntry | None) -> tuple[str | None, str | None]:
    if catalog is None:
        return None, None
    for env_name in catalog.api_key_env_vars:
        value = os.environ.get(env_name)
        if value:
            return value, f"env:{env_name}"
    return None, None


def _env_api_base(catalog: ProviderCatalogEntry | None) -> str | None:
    if catalog is None:
        return None
    for env_name in catalog.api_base_env_vars:
        value = os.environ.get(env_name)
        if value:
            return value
    return None


def _configured_or_env_key(
    provider_config: ProviderConfig | ProviderProfileConfig | None,
    catalog: ProviderCatalogEntry | None,
) -> tuple[str | None, str | None]:
    configured = getattr(provider_config, "api_key", None) if provider_config else None
    if configured:
        return configured, "config"
    return _env_api_key(catalog)


def _as_tuple(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return tuple(part.strip() for part in value.replace("\n", ",").split(",") if part.strip())
    if isinstance(value, list | tuple):
        return tuple(str(item).strip() for item in value if str(item).strip())
    return ()


def _extra_body(provider_config: ProviderConfig | ProviderProfileConfig | None) -> dict[str, Any]:
    value = getattr(provider_config, "extra_body", None) if provider_config else None
    return dict(value) if isinstance(value, dict) else {}


def _supports_model_discovery(
    provider_config: ProviderConfig | ProviderProfileConfig | None,
    catalog: ProviderCatalogEntry | None,
) -> bool:
    configured = getattr(provider_config, "supports_model_discovery", None)
    if configured is not None:
        return bool(configured)
    return catalog.supports_model_discovery if catalog else True


def _resolve_entry(
    *,
    config: Config,
    provider_id: str | None,
    model: str,
    source: str,
    profile_name: str | None = None,
    provider_config: ProviderConfig | ProviderProfileConfig | None = None,
) -> ResolvedRuntimeProvider:
    catalog = find_catalog_entry(provider_id) if provider_id else None
    normalized_id = catalog.id if catalog else provider_id
    provider_config = provider_config if provider_config is not None else _provider_config(config, normalized_id)
    api_key, api_key_source = _configured_or_env_key(provider_config, catalog)
    api_base = (
        getattr(provider_config, "api_base", None)
        or _env_api_base(catalog)
        or (catalog.default_api_base if catalog else None)
        or None
    )
    models = _as_tuple(getattr(provider_config, "models", None))
    manual_model_ids = _as_tuple(getattr(provider_config, "manual_models", None))

    return ResolvedRuntimeProvider(
        provider_id=normalized_id,
        model=model,
        catalog=catalog,
        provider_config=provider_config,
        profile_name=profile_name,
        source=source,
        api_mode=catalog.api_mode if catalog else None,
        api_key=api_key,
        api_key_source=api_key_source,
        api_base=api_base,
        models=models,
        manual_model_ids=manual_model_ids,
        supports_model_discovery=_supports_model_discovery(provider_config, catalog),
        request_traits=catalog.request_traits if catalog else RequestTraits(),
        extra_body=_extra_body(provider_config),
    )


def _has_usable_config(config: Config, entry: ProviderCatalogEntry) -> bool:
    provider_config = _provider_config(config, entry.id)
    if provider_config and (
        getattr(provider_config, "api_key", None)
        or getattr(provider_config, "api_base", None)
        or entry.is_local
    ):
        return True
    env_key, _ = _env_api_key(entry)
    return bool(env_key or entry.is_local)


def resolve_runtime_provider(
    config: Config,
    *,
    model: str | None = None,
    provider: str | None = None,
) -> ResolvedRuntimeProvider:
    """Resolve the effective runtime provider for a model call."""

    selected_model = model or config.agents.defaults.model

    explicit_override = _normalize_provider_id(provider)
    if explicit_override and explicit_override != "auto":
        return _resolve_entry(
            config=config,
            provider_id=explicit_override,
            model=selected_model,
            source="explicit",
        )

    active_profile = (config.agents.defaults.active_profile or "").strip()
    if active_profile:
        profile = config.providers.profiles.get(active_profile)
        if profile:
            return _resolve_entry(
                config=config,
                provider_id=_normalize_provider_id(profile.provider),
                model=selected_model,
                source="profile",
                profile_name=active_profile,
                provider_config=profile,
            )

    explicit_provider = _normalize_provider_id(config.agents.defaults.provider)
    if explicit_provider and explicit_provider != "auto":
        return _resolve_entry(
            config=config,
            provider_id=explicit_provider,
            model=selected_model,
            source="explicit",
        )

    inferred = infer_provider_from_model(selected_model)
    if inferred:
        return _resolve_entry(
            config=config,
            provider_id=inferred.id,
            model=selected_model,
            source="model",
        )

    for entry in list_catalog_entries():
        if _has_usable_config(config, entry):
            return _resolve_entry(
                config=config,
                provider_id=entry.id,
                model=selected_model,
                source="credentials",
            )

    return ResolvedRuntimeProvider(provider_id=None, model=selected_model)
