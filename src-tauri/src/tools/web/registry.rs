use crate::protocol::capability::WorkerCapability;
use crate::tools::registry::{
    runtime_policy, tool, ToolCancellationMode, ToolContributor, ToolExposure, ToolRegistryEntry,
};
use serde_json::json;

#[derive(Debug)]
pub(crate) struct WebToolContributor;

impl ToolContributor for WebToolContributor {
    fn id(&self) -> &str {
        "builtin.web"
    }

    fn contribute(&self) -> Vec<ToolRegistryEntry> {
        let action_schema = json!({
            "type": "object",
            "required": ["type"],
            "properties": {
                "type": {
                    "type": "string",
                    "description": "Use clickTarget with targetRef for semantic targets. Use click only with x and y coordinates. URL navigation belongs in web.open.",
                    "enum": ["back", "forward", "reload", "stop", "click", "clickTarget", "type", "fill", "key", "scroll", "wait", "userHandoff", "resume"]
                },
                "x": { "type": "number" },
                "y": { "type": "number" },
                "targetRef": { "type": "string", "description": "Opaque targetRef from the latest returned snapshot." },
                "text": { "type": "string" },
                "key": { "type": "string" },
                "deltaX": { "type": "number" },
                "deltaY": { "type": "number" },
                "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 15000 },
                "reason": { "type": "string" }
            },
            "additionalProperties": false
        });
        vec![
            tool(
                "web.open",
                "web",
                "Open a web page",
                "Open a URL in this chat's shared browser and return the current page snapshot and snapshotId. Session and tab setup are handled automatically.",
                ToolExposure::Model,
                false,
                runtime_policy(false, ToolCancellationMode::DetachForbidden, false, true),
                vec![
                    WorkerCapability::BrowserObserve,
                    WorkerCapability::BrowserInteract,
                ],
                json!({
                    "type": "object",
                    "required": ["url"],
                    "properties": {
                        "url": { "type": "string" }
                    },
                    "additionalProperties": false
                }),
            ),
            tool(
                "web.read",
                "web",
                "Read the current web page",
                "Return the latest page snapshot and snapshotId. Pass the last snapshotId for a compact unchanged response when the page has not changed.",
                ToolExposure::Model,
                false,
                runtime_policy(false, ToolCancellationMode::DetachForbidden, false, true),
                vec![WorkerCapability::BrowserObserve],
                json!({
                    "type": "object",
                    "properties": {
                        "snapshotId": { "type": "string" }
                    },
                    "additionalProperties": false
                }),
            ),
            tool(
                "web.act",
                "web",
                "Act on the current web page",
                "Perform one action against the current page. Put action fields inside the action object; use clickTarget with targetRef for semantic targets. Use web.open, not web.act, for URL navigation. Always pass the latest snapshotId. Stale actions are not executed and return the latest snapshot.",
                ToolExposure::Model,
                false,
                runtime_policy(false, ToolCancellationMode::DetachForbidden, false, true),
                vec![
                    WorkerCapability::BrowserObserve,
                    WorkerCapability::BrowserInteract,
                ],
                json!({
                    "type": "object",
                    "required": ["snapshotId", "action"],
                    "properties": {
                        "snapshotId": { "type": "string" },
                        "action": action_schema
                    },
                    "additionalProperties": false
                }),
            ),
        ]
    }
}
