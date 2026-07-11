use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContextWindowStrategy {
    Discard,
    Compact,
}

impl ContextWindowStrategy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Discard => "discard",
            Self::Compact => "compact",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentReasoningSettings {
    pub effort: Option<String>,
    pub summary: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AgentOutputSchema {
    pub name: String,
    pub schema: Value,
    pub strict: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AgentTurnSettings {
    pub model: String,
    pub provider: Option<String>,
    pub max_iterations: i64,
    pub stream: bool,
    pub max_completion_tokens: Option<u64>,
    pub context_window_strategy: ContextWindowStrategy,
    pub reasoning: Option<AgentReasoningSettings>,
    pub service_tier: Option<String>,
    pub output_schema: Option<AgentOutputSchema>,
    pub working_directory: Option<PathBuf>,
    pub approval_policy: Option<String>,
    pub permission_profile: Option<String>,
    pub selected_tools: Vec<String>,
    pub parallel_tool_calls: Option<bool>,
    validation_errors: Vec<String>,
}

impl AgentTurnSettings {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn from_sources(
        spec: &Value,
        metadata: &Value,
        config_snapshot: &Value,
        model: String,
        provider: Option<String>,
        max_iterations: i64,
        stream: bool,
    ) -> Self {
        let defaults = config_snapshot
            .get("agents")
            .and_then(|agents| agents.get("defaults"))
            .unwrap_or(&Value::Null);
        let mut validation_errors = Vec::new();
        let max_completion_tokens = optional_u64_setting(
            spec,
            metadata,
            defaults,
            &["maxCompletionTokens", "max_completion_tokens", "max_tokens"],
            "max_completion_tokens",
            &mut validation_errors,
        );
        let context_window_strategy = optional_string_setting(
            spec,
            metadata,
            defaults,
            &["contextWindowStrategy", "context_window_strategy"],
            "context_window_strategy",
            &mut validation_errors,
        )
        .and_then(|strategy| match strategy.to_ascii_lowercase().as_str() {
            "discard" => Some(ContextWindowStrategy::Discard),
            "compact" => Some(ContextWindowStrategy::Compact),
            _ => {
                validation_errors.push(format!(
                    "context_window_strategy must be `discard` or `compact`, got `{strategy}`"
                ));
                None
            }
        })
        .unwrap_or(ContextWindowStrategy::Discard);
        let reasoning = reasoning_settings(spec, metadata, defaults, &mut validation_errors);
        let service_tier = optional_string_setting(
            spec,
            metadata,
            defaults,
            &["serviceTier", "service_tier"],
            "service_tier",
            &mut validation_errors,
        );
        let output_schema = output_schema_setting(spec, metadata, defaults, &mut validation_errors);
        let working_directory = optional_string_setting(
            spec,
            metadata,
            defaults,
            &["cwd", "workingDirectory", "working_directory", "workspace"],
            "working_directory",
            &mut validation_errors,
        )
        .map(PathBuf::from);
        let approval_policy = optional_string_setting(
            spec,
            metadata,
            defaults,
            &["approvalPolicy", "approval_policy"],
            "approval_policy",
            &mut validation_errors,
        );
        let permission_profile = optional_string_setting(
            spec,
            metadata,
            defaults,
            &["permissionProfile", "permission_profile"],
            "permission_profile",
            &mut validation_errors,
        );
        let selected_tools = optional_string_array_setting(
            spec,
            metadata,
            defaults,
            &["selectedTools", "selected_tools"],
            "selected_tools",
            &mut validation_errors,
        )
        .unwrap_or_default();
        let parallel_tool_calls = optional_bool_setting(
            spec,
            metadata,
            defaults,
            &["parallelToolCalls", "parallel_tool_calls"],
            "parallel_tool_calls",
            &mut validation_errors,
        );

        Self {
            model,
            provider,
            max_iterations,
            stream,
            max_completion_tokens,
            context_window_strategy,
            reasoning,
            service_tier,
            output_schema,
            working_directory,
            approval_policy,
            permission_profile,
            selected_tools,
            parallel_tool_calls,
            validation_errors,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.validation_errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "invalid agent turn settings: {}",
                self.validation_errors.join("; ")
            ))
        }
    }
}

fn reasoning_settings(
    spec: &Value,
    metadata: &Value,
    defaults: &Value,
    validation_errors: &mut Vec<String>,
) -> Option<AgentReasoningSettings> {
    if let Some(value) = setting_value(spec, metadata, defaults, &["reasoning"]) {
        let Some(object) = value.as_object() else {
            validation_errors.push("reasoning must be an object".to_string());
            return None;
        };
        let effort = optional_object_string(
            object,
            &["effort", "reasoningEffort", "reasoning_effort"],
            "reasoning.effort",
            validation_errors,
        );
        let summary =
            optional_object_string(object, &["summary"], "reasoning.summary", validation_errors);
        return Some(AgentReasoningSettings { effort, summary });
    }
    optional_string_setting(
        spec,
        metadata,
        defaults,
        &["reasoningEffort", "reasoning_effort"],
        "reasoning_effort",
        validation_errors,
    )
    .map(|effort| AgentReasoningSettings {
        effort: Some(effort),
        summary: None,
    })
}

fn output_schema_setting(
    spec: &Value,
    metadata: &Value,
    defaults: &Value,
    validation_errors: &mut Vec<String>,
) -> Option<AgentOutputSchema> {
    let value = setting_value(spec, metadata, defaults, &["outputSchema", "output_schema"])?;
    let Some(object) = value.as_object() else {
        validation_errors.push("output_schema must be an object".to_string());
        return None;
    };
    if let Some(schema) = object.get("schema") {
        if !schema.is_object() {
            validation_errors.push("output_schema.schema must be an object".to_string());
            return None;
        }
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or("tinybot_output")
            .to_string();
        let strict = object
            .get("strict")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        return Some(AgentOutputSchema {
            name,
            schema: schema.clone(),
            strict,
        });
    }
    Some(AgentOutputSchema {
        name: "tinybot_output".to_string(),
        schema: value.clone(),
        strict: true,
    })
}

fn setting_value<'a>(
    spec: &'a Value,
    metadata: &'a Value,
    defaults: &'a Value,
    keys: &[&str],
) -> Option<&'a Value> {
    [spec, metadata, defaults].into_iter().find_map(|source| {
        keys.iter()
            .find_map(|key| source.get(*key).filter(|value| !value.is_null()))
    })
}

fn optional_string_setting(
    spec: &Value,
    metadata: &Value,
    defaults: &Value,
    keys: &[&str],
    label: &str,
    validation_errors: &mut Vec<String>,
) -> Option<String> {
    let value = setting_value(spec, metadata, defaults, keys)?;
    match value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => Some(value.to_string()),
        None => {
            validation_errors.push(format!("{label} must be a non-empty string"));
            None
        }
    }
}

fn optional_u64_setting(
    spec: &Value,
    metadata: &Value,
    defaults: &Value,
    keys: &[&str],
    label: &str,
    validation_errors: &mut Vec<String>,
) -> Option<u64> {
    let value = setting_value(spec, metadata, defaults, keys)?;
    match value.as_u64().filter(|value| *value > 0) {
        Some(value) => Some(value),
        None => {
            validation_errors.push(format!("{label} must be a positive integer"));
            None
        }
    }
}

fn optional_bool_setting(
    spec: &Value,
    metadata: &Value,
    defaults: &Value,
    keys: &[&str],
    label: &str,
    validation_errors: &mut Vec<String>,
) -> Option<bool> {
    let value = setting_value(spec, metadata, defaults, keys)?;
    match value.as_bool() {
        Some(value) => Some(value),
        None => {
            validation_errors.push(format!("{label} must be a boolean"));
            None
        }
    }
}

fn optional_string_array_setting(
    spec: &Value,
    metadata: &Value,
    defaults: &Value,
    keys: &[&str],
    label: &str,
    validation_errors: &mut Vec<String>,
) -> Option<Vec<String>> {
    let value = setting_value(spec, metadata, defaults, keys)?;
    let Some(values) = value.as_array() else {
        validation_errors.push(format!("{label} must be an array of strings"));
        return None;
    };
    let mut strings = Vec::with_capacity(values.len());
    for value in values {
        let Some(value) = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            validation_errors.push(format!("{label} must contain only non-empty strings"));
            return None;
        };
        strings.push(value.to_string());
    }
    Some(strings)
}

fn optional_object_string(
    object: &serde_json::Map<String, Value>,
    keys: &[&str],
    label: &str,
    validation_errors: &mut Vec<String>,
) -> Option<String> {
    let value = keys.iter().find_map(|key| object.get(*key))?;
    match value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => Some(value.to_string()),
        None => {
            validation_errors.push(format!("{label} must be a non-empty string"));
            None
        }
    }
}
