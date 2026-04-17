"""Factory for creating LLM providers from configuration."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from loguru import logger

from tinybot.providers.registry import find_by_name, PROVIDERS

if TYPE_CHECKING:
    from tinybot.config.schema import Config, ProviderConfig
    from tinybot.providers.base import LLMProvider


class ProviderFactory:
    """Factory for creating LLM provider instances from configuration."""

    @staticmethod
    def create_from_config(
        config: Config,
        model: str | None = None,
        workspace: Path | None = None,
    ) -> LLMProvider | None:
        """Create provider instance from configuration.

        Args:
            config: Configuration object
            model: Optional model override (for multi-model scenarios)
            workspace: Optional workspace path (for OAuth providers)

        Returns:
            LLMProvider instance or None if no valid provider found
        """
        provider_name = config.get_provider_name(model)
        if not provider_name:
            logger.warning("No provider found for model: {}", model or config.agents.defaults.model)
            return None

        spec = find_by_name(provider_name)
        if not spec:
            logger.warning("Provider spec not found for: {}", provider_name)
            return None

        provider_config = config.get_provider(model)
        api_key = provider_config.api_key if provider_config else ""
        api_base = config.get_api_base(model)

        # Handle OAuth providers (GitHub Copilot, OpenAI Codex)
        if spec.is_oauth:
            if not workspace:
                logger.warning("OAuth provider {} requires workspace", provider_name)
                return None
            return ProviderFactory._create_oauth_provider(spec, workspace)

        # Handle local providers (Ollama, OVMS)
        if spec.is_local:
            return ProviderFactory._create_local_provider(
                spec,
                api_base or spec.default_api_base,
                model or config.agents.defaults.model,
            )

        # Standard API providers
        if not api_key:
            logger.warning("No API key for provider: {}", provider_name)
            return None

        return ProviderFactory._create_standard_provider(
            spec,
            api_key,
            api_base,
            model or config.agents.defaults.model,
            provider_config,
        )

    @staticmethod
    def _create_oauth_provider(spec, workspace: Path) -> LLMProvider | None:
        """Create OAuth-based provider (GitHub Copilot, OpenAI Codex)."""
        # OAuth providers have special initialization
        provider_class = spec.provider_class
        if not provider_class:
            return None

        try:
            # OAuth providers typically need workspace for token storage
            return provider_class(workspace=workspace)
        except Exception as e:
            logger.warning("Failed to create OAuth provider {}: {}", spec.name, e)
            return None

    @staticmethod
    def _create_local_provider(
        spec,
        api_base: str | None,
        model: str,
    ) -> LLMProvider | None:
        """Create local provider (Ollama, OVMS)."""
        provider_class = spec.provider_class
        if not provider_class:
            return None

        try:
            return provider_class(
                api_base=api_base,
                model=model,
            )
        except Exception as e:
            logger.warning("Failed to create local provider {}: {}", spec.name, e)
            return None

    @staticmethod
    def _create_standard_provider(
        spec,
        api_key: str,
        api_base: str | None,
        model: str,
        provider_config: ProviderConfig | None,
    ) -> LLMProvider | None:
        """Create standard API provider."""
        provider_class = spec.provider_class
        if not provider_class:
            return None

        extra_headers = provider_config.extra_headers if provider_config else None

        try:
            return provider_class(
                api_key=api_key,
                api_base=api_base,
                model=model,
                extra_headers=extra_headers,
            )
        except Exception as e:
            logger.warning("Failed to create provider {}: {}", spec.name, e)
            return None

    @staticmethod
    def get_available_providers(config: Config) -> list[str]:
        """Get list of providers that have valid configuration.

        Args:
            config: Configuration object

        Returns:
            List of provider names that are properly configured
        """
        available: list[str] = []

        for spec in PROVIDERS:
            provider_config = getattr(config.providers, spec.name, None)
            if not provider_config:
                continue

            # OAuth providers are available if workspace exists
            if spec.is_oauth:
                if config.workspace_path.exists():
                    available.append(spec.name)
                continue

            # Local providers are available if api_base is set
            if spec.is_local:
                if provider_config.api_base or spec.default_api_base:
                    available.append(spec.name)
                continue

            # Standard providers need API key
            if provider_config.api_key:
                available.append(spec.name)

        return available
