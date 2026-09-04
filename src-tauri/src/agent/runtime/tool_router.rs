use crate::tools::registry::{
    ToolCancellationMode, ToolExecutionTarget, ToolExposure, ToolRegistryEntry, ToolRuntimePolicy,
};
use crate::tools::registry::{MCP_CALL_TOOL_METHOD, UPDATE_PLAN_METHOD};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Clone, Debug, PartialEq)]
pub(super) struct AgentToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Clone, Debug)]
pub(super) struct NativeToolRouter {
    entries: Vec<ToolRegistryEntry>,
    activated_tool_ids: BTreeSet<String>,
}

impl NativeToolRouter {
    pub(super) fn new(entries: Vec<ToolRegistryEntry>) -> Self {
        Self {
            entries,
            activated_tool_ids: BTreeSet::new(),
        }
    }

    pub(super) fn tool_definitions(&self) -> Result<Vec<AgentToolDefinition>, String> {
        let provider_names = self.provider_name_map(&self.activated_tool_ids)?;
        let mut definitions = Vec::new();
        for entry in self.visible_entries(&self.activated_tool_ids) {
            let provider_name = provider_names
                .iter()
                .find_map(|(provider_name, method)| {
                    (*method == entry.method.as_str()).then_some(provider_name)
                })
                .expect("validated provider name map should contain every visible tool");
            definitions.push(registry_entry_to_tool_definition(entry, provider_name));
        }
        Ok(definitions)
    }

    pub(super) fn configure_for_turn(
        &mut self,
        selected_tools: Option<&[String]>,
    ) -> Result<(), String> {
        let mut selected_tool_ids = BTreeSet::new();
        if let Some(selected_tools) = selected_tools {
            for selected in selected_tools {
                let selected = selected.trim();
                let Some(entry) = self
                    .entries
                    .iter()
                    .find(|entry| entry.tool_id == selected || entry.method == selected)
                else {
                    return Err(format!("unknown selected tool: {selected}"));
                };
                if !entry.available {
                    return Err(format!("selected tool is unavailable: {}", entry.tool_id));
                }
                if !selected_tool_ids.insert(entry.tool_id.clone()) {
                    return Err(format!(
                        "selected tools contain duplicate entry: {}",
                        entry.tool_id
                    ));
                }
            }
            let has_concrete_mcp_tool = self.entries.iter().any(|entry| {
                selected_tool_ids.contains(&entry.tool_id)
                    && matches!(&entry.execution_target, ToolExecutionTarget::Mcp { .. })
            });
            if has_concrete_mcp_tool {
                selected_tool_ids.remove(MCP_CALL_TOOL_METHOD);
            }
            self.entries.retain(|entry| {
                selected_tool_ids.contains(&entry.tool_id) || entry.method == UPDATE_PLAN_METHOD
            });
        }

        self.activated_tool_ids = if selected_tools.is_some() {
            self.entries
                .iter()
                .filter(|entry| entry.exposure == ToolExposure::Deferred)
                .map(|entry| entry.tool_id.clone())
                .collect()
        } else {
            BTreeSet::new()
        };
        self.provider_name_map(&self.activated_tool_ids)?;
        Ok(())
    }

    pub(super) fn resolve_provider_name(&self, provider_name: &str) -> Result<String, String> {
        if let Some(entry) = self
            .visible_entries(&self.activated_tool_ids)
            .find(|entry| entry.method == provider_name)
        {
            return Ok(entry.method.clone());
        }
        if let Some(method) = self
            .provider_name_map(&self.activated_tool_ids)?
            .get(provider_name)
            .copied()
        {
            return Ok(method.to_string());
        }

        let mut registered_matches = self.entries.iter().filter(|entry| {
            matches!(entry.exposure, ToolExposure::Model | ToolExposure::Deferred)
                && (entry.method == provider_name
                    || provider_tool_name(&entry.method) == provider_name)
        });
        let Some(first) = registered_matches.next() else {
            return Ok(provider_name.to_string());
        };
        if let Some(conflict) =
            registered_matches.find(|entry| entry.method.as_str() != first.method.as_str())
        {
            return Err(format!(
                "provider tool name `{provider_name}` is ambiguous between {} and {}",
                first.method, conflict.method
            ));
        }
        Ok(first.method.clone())
    }

    pub(super) fn activate_for_turn(&mut self, tool_ids: &[String]) -> Result<(), String> {
        let mut requested = HashSet::new();
        let mut next_activated = self.activated_tool_ids.clone();
        for tool_id in tool_ids {
            let normalized_tool_id = tool_id.trim();
            if normalized_tool_id.is_empty() {
                return Err("cannot activate an empty deferred tool ID".to_string());
            }
            if !requested.insert(normalized_tool_id.to_string()) {
                return Err(format!(
                    "deferred tool activation contains duplicate ID: {normalized_tool_id}"
                ));
            }
            if next_activated.contains(normalized_tool_id) {
                return Err(format!(
                    "deferred tool is already active for this turn: {normalized_tool_id}"
                ));
            }
            let Some(entry) = self.entries.iter().find(|entry| {
                entry.tool_id == normalized_tool_id || entry.method == normalized_tool_id
            }) else {
                return Err(format!(
                    "unknown deferred tool ID cannot be activated: {normalized_tool_id}"
                ));
            };
            if !entry.available {
                return Err(format!(
                    "unavailable deferred tool cannot be activated: {}",
                    entry.tool_id
                ));
            }
            if entry.exposure != ToolExposure::Deferred {
                return Err(format!(
                    "tool is not deferred and cannot be activated: {}",
                    entry.tool_id
                ));
            }
            next_activated.insert(entry.tool_id.to_string());
        }

        self.provider_name_map(&next_activated)?;
        self.activated_tool_ids = next_activated;
        Ok(())
    }

    pub(super) fn restore_from_checkpoint(&mut self, checkpoint: &Value) -> Result<(), String> {
        let activated_tool_ids = checkpoint
            .get("activatedToolIds")
            .or_else(|| {
                checkpoint
                    .get("payload")
                    .and_then(|payload| payload.get("activatedToolIds"))
            })
            .cloned()
            .unwrap_or_else(|| json!([]));
        let activated_tool_ids = activated_tool_ids
            .as_array()
            .ok_or_else(|| "invalid checkpoint: activatedToolIds must be an array".to_string())?;
        let activated_tool_ids = activated_tool_ids
            .iter()
            .map(|tool_id| {
                tool_id.as_str().map(str::to_string).ok_or_else(|| {
                    "invalid checkpoint: activatedToolIds must contain only strings".to_string()
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut deferred_tool_ids = Vec::new();
        for tool_id in activated_tool_ids {
            let entry = self
                .entries
                .iter()
                .find(|entry| entry.tool_id == tool_id || entry.method == tool_id)
                .ok_or_else(|| {
                    format!("unknown deferred tool ID cannot be activated: {tool_id}")
                })?;
            if !entry.available {
                return Err(format!(
                    "unavailable deferred tool cannot be activated: {}",
                    entry.tool_id
                ));
            }
            match entry.exposure {
                ToolExposure::Deferred => deferred_tool_ids.push(entry.tool_id.clone()),
                ToolExposure::Model => {}
                ToolExposure::Direct | ToolExposure::Hidden => {
                    return Err(format!(
                        "tool is not deferred and cannot be activated: {}",
                        entry.tool_id
                    ));
                }
            }
        }
        self.activate_for_turn(&deferred_tool_ids)
    }

    pub(super) fn is_permitted(&self, method: &str) -> bool {
        self.visible_entries(&self.activated_tool_ids)
            .any(|entry| entry.method == method)
    }

    pub(super) fn rejection_reason(&self, method: &str) -> String {
        let Some(entry) = self.entries.iter().find(|entry| entry.method == method) else {
            return format!("native tool `{method}` is unknown or unavailable");
        };
        if !entry.available {
            return format!(
                "native tool `{method}` is unavailable because its required capabilities are not permitted"
            );
        }
        if entry.exposure == ToolExposure::Deferred
            && !self.activated_tool_ids.contains(entry.tool_id.as_str())
        {
            return format!(
                "native tool `{method}` is not active for this turn; it must be selected by the backend tool policy"
            );
        }
        format!("native tool `{method}` is not exposed to the model")
    }

    pub(super) fn supports_parallel(&self, method: &str) -> bool {
        self.visible_entry(method)
            .map(|entry| entry.supports_parallel_tool_calls)
            .unwrap_or(false)
    }

    pub(super) fn waits_for_runtime_cancellation(&self, method: &str) -> bool {
        self.runtime_policy(method)
            .map(ToolRuntimePolicy::waits_for_runtime_cancellation)
            .unwrap_or(false)
    }

    pub(super) fn cancellation_mode(&self, method: &str) -> ToolCancellationMode {
        self.runtime_policy(method)
            .map(|policy| policy.cancellation_mode)
            .unwrap_or(ToolCancellationMode::Cooperative)
    }

    pub(super) fn cleanup_timeout_ms(&self, method: &str) -> u64 {
        self.runtime_policy(method)
            .map(|policy| policy.cleanup_timeout_ms)
            .unwrap_or(100)
    }

    pub(super) fn mutates_workspace(&self, method: &str) -> bool {
        self.visible_entry(method)
            .map(|entry| entry.runtime_policy.mutates_workspace)
            .unwrap_or(false)
    }

    pub(super) fn mutates_session(&self, method: &str) -> bool {
        self.visible_entry(method)
            .map(|entry| entry.runtime_policy.mutates_session)
            .unwrap_or(false)
    }

    fn runtime_policy(&self, method: &str) -> Option<ToolRuntimePolicy> {
        self.visible_entry(method).map(|entry| entry.runtime_policy)
    }

    pub(super) fn execution_target(&self, method: &str) -> Option<ToolExecutionTarget> {
        self.visible_entry(method)
            .map(|entry| entry.execution_target.clone())
    }

    pub(super) fn has_parallel_provider_tool(&self) -> bool {
        self.visible_entries(&self.activated_tool_ids)
            .any(|entry| entry.supports_parallel_tool_calls)
    }

    pub(super) fn activated_tool_ids(&self) -> Vec<String> {
        self.activated_tool_ids.iter().cloned().collect()
    }

    fn visible_entry(&self, method: &str) -> Option<&ToolRegistryEntry> {
        self.visible_entries(&self.activated_tool_ids)
            .find(|entry| entry.method == method)
    }

    fn visible_entries<'a>(
        &'a self,
        activated_tool_ids: &'a BTreeSet<String>,
    ) -> impl Iterator<Item = &'a ToolRegistryEntry> + 'a {
        self.entries.iter().filter(move |entry| {
            entry.available
                && (entry.exposure == ToolExposure::Model
                    || (entry.exposure == ToolExposure::Deferred
                        && activated_tool_ids.contains(entry.tool_id.as_str())))
        })
    }

    fn provider_name_map<'a>(
        &'a self,
        activated_tool_ids: &'a BTreeSet<String>,
    ) -> Result<HashMap<String, &'a str>, String> {
        let mut internal_method_by_provider_name = HashMap::new();
        let mut tool_id_by_method = HashMap::new();
        let mut method_by_tool_id = HashMap::new();
        for entry in self.visible_entries(activated_tool_ids) {
            if let Some(existing_tool_id) =
                tool_id_by_method.insert(entry.method.as_str(), entry.tool_id.as_str())
            {
                return Err(format!(
                    "duplicate tool method in registry: {existing_tool_id} and {} both use {}",
                    entry.tool_id, entry.method
                ));
            }
            if let Some(existing_method) =
                method_by_tool_id.insert(entry.tool_id.as_str(), entry.method.as_str())
            {
                return Err(format!(
                    "duplicate tool ID in registry: {existing_method} and {} both use {}",
                    entry.method, entry.tool_id
                ));
            }
            let provider_name = provider_tool_name(&entry.method);
            if let Some(existing_method) = internal_method_by_provider_name
                .insert(provider_name.clone(), entry.method.as_str())
                .filter(|existing_method| *existing_method != entry.method.as_str())
            {
                return Err(format!(
                    "provider tool name collision: {existing_method} and {} both map to {provider_name}",
                    entry.method
                ));
            }
        }
        Ok(internal_method_by_provider_name)
    }
}

pub(super) fn provider_tool_name(method: &str) -> String {
    method
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn registry_entry_to_tool_definition(
    entry: &ToolRegistryEntry,
    provider_name: &str,
) -> AgentToolDefinition {
    AgentToolDefinition {
        name: provider_name.to_string(),
        description: entry.description.clone(),
        input_schema: entry.input_schema.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn router() -> NativeToolRouter {
        NativeToolRouter::new(
            crate::tools::registry::WorkerToolRegistryRpc::new(
                crate::protocol::capability::default_desktop_capability_policy(),
            )
            .list_tools()
            .tools,
        )
    }

    #[test]
    fn missing_selection_uses_default_tools_but_explicit_empty_selection_disables_them() {
        let mut default_router = router();
        default_router.configure_for_turn(None).unwrap();
        let default_names = default_router
            .tool_definitions()
            .unwrap()
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        assert!(default_names.contains(&"apply_patch".to_string()));
        assert!(!default_names.contains(&"mcp_call_tool".to_string()));

        let mut empty_router = router();
        empty_router.configure_for_turn(Some(&[])).unwrap();
        let empty_names = empty_router
            .tool_definitions()
            .unwrap()
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        assert_eq!(empty_names, vec![UPDATE_PLAN_METHOD.to_string()]);
    }

    #[test]
    fn concrete_mcp_selection_suppresses_the_generic_mcp_tool() {
        use crate::tools::registry::{McpToolContributor, WorkerToolRegistryRpc};
        use std::sync::Arc;

        let registry = WorkerToolRegistryRpc::new(
            crate::protocol::capability::default_desktop_capability_policy(),
        )
        .with_contributor(Arc::new(
            McpToolContributor::from_discovery(
                "docs",
                &json!({}),
                &[json!({ "name": "search", "inputSchema": { "type": "object" } })],
            )
            .unwrap(),
        ))
        .unwrap();
        let mut router = NativeToolRouter::new(registry.list_tools().tools);
        router
            .configure_for_turn(Some(&[
                MCP_CALL_TOOL_METHOD.to_string(),
                "mcp.4:docs.6:search".to_string(),
            ]))
            .unwrap();

        let names = router
            .tool_definitions()
            .unwrap()
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        assert!(names.contains(&"mcp_4_docs_6_search".to_string()));
        assert!(!names.contains(&"mcp_call_tool".to_string()));
    }
}
