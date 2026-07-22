use crate::tools::registry::UPDATE_PLAN_METHOD;
use crate::tools::registry::{
    ToolApprovalMetadata, ToolCancellationMode, ToolExecutionTarget, ToolExposure,
    ToolRegistryEntry, ToolRuntimePolicy, DEFAULT_TOOL_SEARCH_LIMIT, MAX_TOOL_SEARCH_LIMIT,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Clone, Debug)]
pub(super) struct NativeToolRouter {
    entries: Vec<ToolRegistryEntry>,
    activated_tool_ids: BTreeSet<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolSearchRequest {
    query: String,
    #[serde(default = "default_tool_search_limit")]
    limit: usize,
}

impl NativeToolRouter {
    pub(super) fn new(entries: Vec<ToolRegistryEntry>) -> Self {
        Self {
            entries,
            activated_tool_ids: BTreeSet::new(),
        }
    }

    pub(super) fn provider_specs(&self) -> Result<Vec<Value>, String> {
        let provider_names = self.provider_name_map(&self.activated_tool_ids)?;
        let mut specs = Vec::new();
        for entry in self.visible_entries(&self.activated_tool_ids) {
            let provider_name = provider_names
                .iter()
                .find_map(|(provider_name, method)| {
                    (*method == entry.method.as_str()).then_some(provider_name)
                })
                .expect("validated provider name map should contain every visible tool");
            specs.push(registry_entry_to_provider_spec(entry, provider_name));
        }
        Ok(specs)
    }

    pub(super) fn configure_for_turn(
        &mut self,
        selected_tools: &[String],
        approval_policy: &str,
    ) -> Result<(), String> {
        let mut selected_tool_ids = BTreeSet::new();
        if !selected_tools.is_empty() {
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
            self.entries.retain(|entry| {
                selected_tool_ids.contains(&entry.tool_id) || entry.method == UPDATE_PLAN_METHOD
            });
        }

        if approval_policy == "never" {
            if let Some(entry) = self.entries.iter().find(|entry| entry.approval.required) {
                if !selected_tools.is_empty() {
                    return Err(format!(
                        "selected tool `{}` requires approval but approval_policy is `never`",
                        entry.tool_id
                    ));
                }
            }
            self.entries.retain(|entry| !entry.approval.required);
        }

        self.activated_tool_ids = if selected_tools.is_empty() {
            BTreeSet::new()
        } else {
            self.entries
                .iter()
                .filter(|entry| entry.exposure == ToolExposure::Deferred)
                .map(|entry| entry.tool_id.clone())
                .collect()
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
        Ok(self
            .provider_name_map(&self.activated_tool_ids)?
            .get(provider_name)
            .copied()
            .unwrap_or(provider_name)
            .to_string())
    }

    pub(super) fn search_and_activate(&mut self, arguments_json: &str) -> Result<Value, String> {
        let request = serde_json::from_str::<ToolSearchRequest>(arguments_json)
            .map_err(|error| format!("invalid tool_search arguments: {error}"))?;
        let query = request.query.trim();
        if query.is_empty() {
            return Err("invalid tool_search arguments: query must not be empty".to_string());
        }
        if request.limit == 0 || request.limit > MAX_TOOL_SEARCH_LIMIT {
            return Err(format!(
                "invalid tool_search arguments: limit must be between 1 and {MAX_TOOL_SEARCH_LIMIT}"
            ));
        }

        let normalized_query = query.to_lowercase();
        let mut matches = self
            .entries
            .iter()
            .filter_map(|entry| {
                if !entry.available
                    || entry.exposure != ToolExposure::Deferred
                    || self.activated_tool_ids.contains(entry.tool_id.as_str())
                {
                    return None;
                }
                let score = entry_match_score(entry, &normalized_query);
                (score > 0).then(|| (score, entry.clone()))
            })
            .collect::<Vec<_>>();
        matches.sort_by(|(left_score, left), (right_score, right)| {
            right_score.cmp(left_score).then_with(|| {
                left.namespace
                    .cmp(&right.namespace)
                    .then_with(|| left.method.cmp(&right.method))
            })
        });
        matches.truncate(request.limit);
        let matches = matches
            .into_iter()
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>();

        let tool_ids = matches
            .iter()
            .map(|entry| entry.tool_id.to_string())
            .collect::<Vec<_>>();
        self.activate_for_turn(&tool_ids)?;

        Ok(json!({
            "tools": matches
                .iter()
                .map(|entry| json!({
                    "toolId": entry.tool_id,
                    "title": entry.title,
                    "description": entry.description,
                    "requiresApproval": entry.approval.required,
                }))
                .collect::<Vec<_>>()
        }))
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
        self.activate_for_turn(&activated_tool_ids)
    }

    pub(super) fn is_permitted(&self, method: &str) -> bool {
        self.visible_entries(&self.activated_tool_ids)
            .any(|entry| entry.method == method)
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

    pub(super) fn approval_metadata(&self, method: &str) -> Option<ToolApprovalMetadata> {
        self.visible_entry(method)
            .map(|entry| entry.approval.clone())
    }

    pub(super) fn approval_session_scope(
        &self,
        method: &str,
        arguments: &serde_json::Value,
    ) -> Result<(String, String), String> {
        let entry = self
            .visible_entry(method)
            .ok_or_else(|| format!("native tool `{method}` is not visible"))?;
        crate::tools::permissions::approval_session_scope(entry, arguments)
            .map_err(|error| error.message)
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

fn default_tool_search_limit() -> usize {
    DEFAULT_TOOL_SEARCH_LIMIT
}

fn registry_entry_to_provider_spec(entry: &ToolRegistryEntry, provider_name: &str) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": provider_name,
            "description": entry.description,
            "parameters": entry.input_schema.clone(),
        },
    })
}

fn entry_match_score(entry: &ToolRegistryEntry, query: &str) -> usize {
    let tool_id = entry.tool_id.to_lowercase();
    let method = entry.method.to_lowercase();
    let namespace = entry.namespace.to_lowercase();
    let title = entry.title.to_lowercase();
    let description = entry.description.to_lowercase();
    let searchable = format!("{tool_id} {method} {namespace} {title} {description}");
    if searchable.contains(query) {
        return 1_000;
    }
    query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| word.len() >= 3 && !is_search_stop_word(word))
        .map(|word| {
            usize::from(tool_id.contains(word)) * 16
                + usize::from(method.contains(word)) * 16
                + usize::from(title.contains(word)) * 8
                + usize::from(description.contains(word)) * 4
                + usize::from(namespace.contains(word)) * 2
        })
        .sum()
}

fn is_search_stop_word(word: &str) -> bool {
    matches!(
        word,
        "and" | "for" | "the" | "tool" | "tools" | "capability" | "capabilities"
    )
}
