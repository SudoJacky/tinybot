"""Canonical Cowork architecture names and legacy aliases."""

from __future__ import annotations

from typing import Any


ADAPTIVE_STARTER = "adaptive_starter"

CANONICAL_ARCHITECTURES = {
    ADAPTIVE_STARTER,
    "supervisor",
    "orchestrator",
    "team",
    "generator_verifier",
    "message_bus",
    "shared_state",
    "peer_handoff",
    "swarm",
}

LEGACY_ARCHITECTURE_ALIASES = {
    "hybrid": ADAPTIVE_STARTER,
}

ACCEPTED_ARCHITECTURE_VALUES = CANONICAL_ARCHITECTURES | set(LEGACY_ARCHITECTURE_ALIASES)


def normalize_architecture_name(value: Any) -> str:
    """Return the canonical Cowork architecture name for user or stored input."""
    name = str(value or ADAPTIVE_STARTER).strip().lower().replace("-", "_")
    name = LEGACY_ARCHITECTURE_ALIASES.get(name, name)
    return name if name in CANONICAL_ARCHITECTURES else ADAPTIVE_STARTER


def architecture_fallback_diagnostic(value: Any, *, path: str = "workflow_mode") -> dict[str, Any] | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    name = raw.lower().replace("-", "_")
    if name in ACCEPTED_ARCHITECTURE_VALUES:
        return None
    return {
        "severity": "warning",
        "code": "unknown_architecture_fallback",
        "message": f"Unknown Cowork architecture '{raw}' was normalized to '{ADAPTIVE_STARTER}'.",
        "path": path,
        "value": raw,
    }


def architecture_label(value: Any) -> str:
    labels = {
        ADAPTIVE_STARTER: "Adaptive Starter",
        "supervisor": "Supervisor",
        "orchestrator": "Orchestrator",
        "team": "Agent Team",
        "generator_verifier": "Generator-Verifier",
        "message_bus": "Message Bus",
        "shared_state": "Shared State",
        "peer_handoff": "Peer Handoff",
        "swarm": "Swarm",
    }
    return labels.get(normalize_architecture_name(value), "Adaptive Starter")
