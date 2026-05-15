"""Message Bus architecture policy."""

from __future__ import annotations

from typing import Any

from tinybot.cowork.policies.base import ArchitectureRuntimePolicy, EnvelopeRoutingDecision, ProjectionResult, TopologyResult


class MessageBusPolicy(ArchitectureRuntimePolicy):
    architecture = "message_bus"
    display_name = "Message Bus"
    runtime_profile = "message_bus"

    def topology(self, session: Any, *, branch_id: str = "default") -> TopologyResult:
        result = super().topology(session, branch_id=branch_id)
        payload = dict(result.payload)
        payload["routes"] = [
            {
                "id": record.id,
                "kind": self._route_type(record),
                "from": record.sender_id,
                "to": list(record.recipient_ids),
                "topic": record.topic,
                "event_type": record.event_type,
                "request_type": record.request_type,
                "correlation_id": record.correlation_id,
                "lineage_id": record.lineage_id,
                "reply_to_envelope_id": record.reply_to_envelope_id,
                "delivery_reason": self._delivery_reason(record),
                "status": record.status,
            }
            for record in getattr(session, "mailbox", {}).values()
        ]
        payload["stores"] = [
            {
                "id": "message_bus",
                "kind": "bus_envelope_store",
                "envelope_count": len(getattr(session, "mailbox", {}) or {}),
            }
        ]
        payload["loops"] = [
            {
                "id": "publish_route_correlate",
                "kind": "message_bus_loop",
                "label": "Publish envelopes, route by topic or direct recipient, correlate replies",
                "status": getattr(session, "status", "active"),
            }
        ]
        payload["metadata"] = {
            **payload.get("metadata", {}),
            "router_is_runtime_layer": True,
            "subscriber_count": len(self._subscriber_projection(session)),
        }
        return TopologyResult(status="available", reason="Message Bus topology projects envelopes, routes, and subscribers.", payload=payload)

    def route_envelope(self, session: Any, envelope: Any) -> EnvelopeRoutingDecision:
        known = set(getattr(session, "agents", {}) or {}) | {"user"}
        explicit = [recipient for recipient in dict.fromkeys(getattr(envelope, "recipient_ids", []) or []) if recipient in known]
        labels = self._envelope_labels(envelope)
        route_type = "direct_route" if explicit else "topic_route" if labels else "policy_route"
        recipients = explicit or self._subscribed_recipients(session, envelope)
        if not recipients:
            recipients = self._fallback_recipients(session, envelope)
            route_type = "policy_route"
        reason = self._route_reason(route_type, labels, explicit)
        return EnvelopeRoutingDecision(
            status="available",
            reason=reason,
            payload={
                "recipients": recipients,
                "route_type": route_type,
                "delivery_reason": reason,
                "labels": sorted(labels),
                "correlation_id": getattr(envelope, "correlation_id", None),
                "lineage_id": getattr(envelope, "lineage_id", None) or getattr(envelope, "correlation_id", None),
                "reply_to_envelope_id": getattr(envelope, "reply_to_envelope_id", None),
            },
        )

    def build_projection(self, session: Any, *, branch_id: str = "default") -> ProjectionResult:
        result = super().build_projection(session, branch_id=branch_id)
        payload = dict(result.payload)
        envelopes = [
            {
                "id": record.id,
                "sender_id": record.sender_id,
                "recipient_ids": list(record.recipient_ids),
                "topic": record.topic,
                "event_type": record.event_type,
                "request_type": record.request_type,
                "route_type": self._route_type(record),
                "delivery_reason": self._delivery_reason(record),
                "correlation_id": record.correlation_id,
                "lineage_id": record.lineage_id,
                "reply_to_envelope_id": record.reply_to_envelope_id,
                "status": record.status,
                "created_at": record.created_at,
            }
            for record in sorted(getattr(session, "mailbox", {}).values(), key=lambda item: item.created_at)[-40:]
        ]
        payload["sections"] = [
            {
                "id": "subscribers",
                "title": "Subscribers",
                "items": self._subscriber_projection(session),
            },
            {
                "id": "bus_envelopes",
                "title": "Bus Envelopes",
                "items": envelopes,
            },
        ]
        payload["metadata"] = {
            **payload.get("metadata", {}),
            "topic_count": len({item.get("topic") for item in envelopes if item.get("topic")}),
            "direct_route_count": len([item for item in envelopes if item.get("route_type") == "direct_route"]),
        }
        return ProjectionResult(status="available", reason="Message Bus projection exposes topic flow, envelopes, and reply correlation.", payload=payload)

    @staticmethod
    def _lead_agent_id(session: Any) -> str:
        agents = getattr(session, "agents", {}) or {}
        for candidate in ("coordinator", "lead", "team_lead", "team-lead"):
            if candidate in agents:
                return candidate
        return next(iter(agents), "user")

    @staticmethod
    def _envelope_labels(envelope: Any) -> set[str]:
        labels = {
            str(getattr(envelope, "topic", "") or "").lower(),
            str(getattr(envelope, "event_type", "") or "").lower(),
            str(getattr(envelope, "request_type", "") or "").lower(),
            str(getattr(envelope, "kind", "") or "").lower(),
        }
        return {label for label in labels if label}

    @classmethod
    def _subscribed_recipients(cls, session: Any, envelope: Any) -> list[str]:
        labels = cls._envelope_labels(envelope)
        if not labels:
            return []
        recipients: list[str] = []
        for agent in getattr(session, "agents", {}).values():
            if agent.id == getattr(envelope, "sender_id", ""):
                continue
            subscriptions = {str(item or "").lower() for item in getattr(agent, "subscriptions", [])}
            if labels & subscriptions:
                recipients.append(agent.id)
        return recipients

    @classmethod
    def _fallback_recipients(cls, session: Any, envelope: Any) -> list[str]:
        agents = getattr(session, "agents", {}) or {}
        sender_id = getattr(envelope, "sender_id", "")
        lead_id = cls._lead_agent_id(session)
        if sender_id == "user":
            return [lead_id] if lead_id != "user" else []
        if getattr(envelope, "visibility", "") == "user":
            return ["user"] if sender_id == lead_id else [lead_id]
        if getattr(envelope, "visibility", "") == "group":
            return [agent_id for agent_id in agents if agent_id != sender_id]
        return ["user"] if sender_id == lead_id else [lead_id]

    @staticmethod
    def _route_reason(route_type: str, labels: set[str], explicit: list[str]) -> str:
        if route_type == "direct_route":
            return f"Direct recipient route to {', '.join(explicit)}."
        if route_type == "topic_route":
            return f"Topic route matched labels: {', '.join(sorted(labels))}."
        return "Policy fallback route used because no explicit recipient or subscription matched."

    @staticmethod
    def _route_type(record: Any) -> str:
        if getattr(record, "reply_to_envelope_id", None):
            return "reply_route"
        if getattr(record, "topic", "") or getattr(record, "event_type", ""):
            return "topic_route"
        return "direct_route"

    @classmethod
    def _delivery_reason(cls, record: Any) -> str:
        route_type = cls._route_type(record)
        if route_type == "reply_route":
            return f"Reply correlated to {record.reply_to_envelope_id}."
        if route_type == "topic_route":
            labels = [value for value in (record.topic, record.event_type, record.request_type, record.kind) if value]
            return f"Topic labels matched subscribers: {', '.join(labels)}."
        return "Direct recipient envelope."

    @staticmethod
    def _subscriber_projection(session: Any) -> list[dict[str, Any]]:
        items = []
        for agent in getattr(session, "agents", {}).values():
            items.append(
                {
                    "agent_id": agent.id,
                    "name": agent.name,
                    "subscriptions": list(getattr(agent, "subscriptions", []) or []),
                    "role": "runtime_router" if agent.id == "router" else "subscriber",
                    "status": agent.status,
                }
            )
        return items
