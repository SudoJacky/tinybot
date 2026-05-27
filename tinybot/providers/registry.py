"""
Provider Registry - compatibility view over the provider catalog.

Order matters - it controls match priority and fallback.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic.alias_generators import to_snake

from tinybot.providers.catalog import (
    ProviderCatalogEntry,
    TokenParameter,
    list_catalog_entries,
)


@dataclass(frozen=True)
class ProviderSpec:
    """One LLM provider's metadata. See PROVIDERS below for real examples.

    Placeholders in env_extras values:
      {api_key}  - the user's API key
      {api_base} - api_base from config, or this spec's default_api_base
    """

    # identity
    name: str  # config field name, e.g. "dashscope"
    keywords: tuple[str, ...]  # model-name keywords for matching (lowercase)
    env_key: str  # env var for API key, e.g. "DASHSCOPE_API_KEY"
    display_name: str = ""  # shown in `tinybot status`

    # which provider implementation to use
    # "openai"
    backend: str = "openai"

    # extra env vars, e.g. (("ZHIPUAI_API_KEY", "{api_key}"),)
    env_extras: tuple[tuple[str, str], ...] = ()

    # gateway / local detection
    is_gateway: bool = False  # routes any model (OpenRouter, AiHubMix)
    is_local: bool = False  # local deployment (vLLM, Ollama)
    detect_by_key_prefix: str = ""  # match api_key prefix, e.g. "sk-or-"
    detect_by_base_keyword: str = ""  # match substring in api_base URL
    default_api_base: str = ""  # OpenAI-compatible base URL for this provider

    # gateway behavior
    strip_model_prefix: bool = False  # strip "provider/" before sending to gateway
    supports_max_completion_tokens: bool = False

    # per-model param overrides, e.g. (("model-x", {"temperature": 1.0}),)
    model_overrides: tuple[tuple[str, dict[str, Any]], ...] = ()

    # OAuth-based providers (e.g., OpenAI Codex) don't use API keys
    is_oauth: bool = False

    # Direct providers skip API-key validation (user supplies everything)
    is_direct: bool = False

    # Provider supports cache_control on content blocks (e.g. Anthropic prompt caching)
    supports_prompt_caching: bool = False

    # Rich catalog metadata backing this compatibility spec.
    catalog: ProviderCatalogEntry | None = None

    @property
    def label(self) -> str:
        return self.display_name or self.name.title()


# ---------------------------------------------------------------------------
# PROVIDERS - compatibility registry. Order = catalog priority.
# ---------------------------------------------------------------------------


def _provider_spec_from_catalog(entry: ProviderCatalogEntry) -> ProviderSpec:
    return ProviderSpec(
        name=entry.id,
        keywords=tuple(term.lower() for term in entry.match_terms),
        env_key=entry.primary_api_key_env_var,
        display_name=entry.display_name,
        backend=entry.backend,
        is_gateway=entry.is_gateway,
        is_local=entry.is_local,
        detect_by_key_prefix=entry.detect_by_key_prefix,
        detect_by_base_keyword=entry.detect_by_base_keyword,
        default_api_base=entry.default_api_base,
        strip_model_prefix=entry.request_traits.strip_model_prefix,
        supports_max_completion_tokens=(
            entry.request_traits.token_parameter == TokenParameter.MAX_COMPLETION_TOKENS
        ),
        is_direct=entry.is_custom,
        supports_prompt_caching=entry.request_traits.supports_prompt_caching,
        catalog=entry,
    )


PROVIDERS: tuple[ProviderSpec, ...] = tuple(
    _provider_spec_from_catalog(entry) for entry in list_catalog_entries()
)
# ---------------------------------------------------------------------------
# Lookup helpers
# ---------------------------------------------------------------------------


def find_by_name(name: str) -> ProviderSpec | None:
    """Find a provider spec by config field name, e.g. "dashscope"."""
    normalized = to_snake(name.replace("-", "_"))
    for spec in PROVIDERS:
        if spec.name == normalized:
            return spec
    return None


def create_provider(config: Any, *, on_missing_key: object | None = None) -> Any:
    """Create the LLM provider from *config*.

    This is the single source of truth for provider instantiation, shared by
    the SDK facade (:mod:`tinybot.tinybot`) and the CLI (:mod:`tinybot.cli.commands`).

    Args:
        config: A :class:`~tinybot.config.schema.Config` instance.
        on_missing_key:
            Callable(provider_name: str) -> None invoked when the provider
            requires an API key but none is configured.  If *None* (default)
            a :class:`ValueError` is raised instead.

    Returns:
        A configured :class:`~tinybot.providers.openai_provider.OpenAIProvider`.
    """
    from tinybot.providers.base import GenerationSettings
    from tinybot.providers.openai_provider import OpenAIProvider
    from tinybot.providers.runtime import resolve_runtime_provider

    model = config.agents.defaults.model
    resolved = resolve_runtime_provider(config, model=model)
    provider_name = resolved.provider_id
    p = resolved.provider_config
    api_key = resolved.api_key
    spec = find_by_name(provider_name) if provider_name else None
    backend = spec.backend if spec else "openai"

    # --- validation ---
    if backend == "openai" and not model.startswith("bedrock/"):
        needs_key = not api_key
        exempt = spec and (spec.is_oauth or spec.is_local or spec.is_direct)
        if needs_key and not exempt:
            if on_missing_key is not None:
                on_missing_key(provider_name)  # type: ignore[operator]
            else:
                raise ValueError(
                    f"No API key configured for provider '{provider_name}'."
                )

    # --- instantiation ---
    provider = OpenAIProvider(
        api_key=api_key,
        api_base=config.get_api_base(model),
        default_model=model,
        enable_search=p.enable_search if p else False,
        spec=spec,
        resolved_provider=resolved,
    )

    defaults = config.agents.defaults
    provider.generation = GenerationSettings(
        temperature=defaults.temperature,
        max_tokens=defaults.max_tokens,
        reasoning_effort=defaults.reasoning_effort,
    )
    return provider
