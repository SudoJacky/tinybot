"""OpenAI-compatible HTTP API for tinybot."""

from tinybot.api.knowledge import register_knowledge_routes
from tinybot.api.server import create_app

__all__ = ["create_app", "register_knowledge_routes"]
