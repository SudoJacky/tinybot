use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentItem {
    Instruction(AgentInstructionMessage),
    UserMessage(AgentMessage),
    AssistantMessage(AgentAssistantMessage),
    Reasoning(AgentReasoningItem),
    ToolResult(AgentToolResultItem),
    UserInput(AgentUserInputItem),
    PlanProgress(AgentPlanProgressItem),
    Subagent(AgentSubagentItem),
    SubagentMessage(AgentSubagentMessageItem),
    ContextCompaction(AgentContextCompactionItem),
    Error(AgentErrorItem),
    Usage(AgentUsageItem),
    FileReference(AgentFileReferenceItem),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentInstructionRole {
    System,
    Developer,
}

impl AgentInstructionRole {
    fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Developer => "developer",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstructionMessage {
    pub id: Option<String>,
    #[serde(flatten)]
    pub origin: AgentMessageOrigin,
    pub role: AgentInstructionRole,
    pub content: AgentMessageContent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: Option<String>,
    #[serde(flatten)]
    pub origin: AgentMessageOrigin,
    pub content: AgentMessageContent,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected_skills: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAssistantMessage {
    pub id: Option<String>,
    #[serde(flatten)]
    pub origin: AgentMessageOrigin,
    pub content: Option<AgentMessageContent>,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<AgentToolCallItem>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub context_compaction: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolCallItem {
    pub id: String,
    pub name: String,
    pub arguments_json: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolResultItem {
    pub id: Option<String>,
    #[serde(flatten)]
    pub origin: AgentMessageOrigin,
    pub tool_call_id: String,
    pub name: Option<String>,
    pub content: AgentMessageContent,
    #[serde(default)]
    pub is_error: bool,
}

/// Local history identity is independent of a provider's item `id` and tool call ID.
/// Keep it through checkpoints and context selection; only adapters strip it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageOrigin {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollout_ordinal: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_id: Option<String>,
    #[serde(default, alias = "thread_id", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, alias = "turn_id", skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, alias = "message_id", skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReasoningItem {
    pub id: Option<String>,
    pub summary: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserInputItem {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    pub status: String,
    pub action: Option<String>,
    #[serde(default)]
    pub field_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<Value>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPlanStepStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentPlanStep {
    pub step: String,
    pub status: AgentPlanStepStatus,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentPlanDerivedProgress {
    pub completed: u32,
    pub total: u32,
    pub current_step: Option<String>,
}

pub fn validate_and_normalize_plan_steps(
    steps: &mut Vec<AgentPlanStep>,
) -> Result<AgentPlanDerivedProgress, String> {
    if steps.is_empty() {
        return Err("plan must contain at least one step".to_string());
    }
    if steps.len() > 50 {
        return Err("plan must contain at most 50 steps".to_string());
    }
    let mut names = BTreeSet::new();
    let mut in_progress = 0usize;
    let mut completed = 0usize;
    for step in steps.iter_mut() {
        step.step = step.step.trim().to_string();
        if step.step.is_empty() {
            return Err("step text must not be empty".to_string());
        }
        if step.step.chars().count() > 512 {
            return Err("step text must not exceed 512 characters".to_string());
        }
        if !names.insert(step.step.clone()) {
            return Err(format!("duplicate step `{}`", step.step));
        }
        match step.status {
            AgentPlanStepStatus::InProgress => in_progress += 1,
            AgentPlanStepStatus::Completed => completed += 1,
            AgentPlanStepStatus::Pending => {}
        }
    }
    if in_progress > 1 {
        return Err("at most one step can be in_progress".to_string());
    }
    if completed == steps.len() {
        if in_progress != 0 {
            return Err("a completed plan cannot have an in_progress step".to_string());
        }
    } else if in_progress != 1 {
        return Err("an incomplete plan must have exactly one in_progress step".to_string());
    }
    Ok(AgentPlanDerivedProgress {
        completed: completed as u32,
        total: steps.len() as u32,
        current_step: steps
            .iter()
            .find(|step| step.status == AgentPlanStepStatus::InProgress)
            .map(|step| step.step.clone()),
    })
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlanProgressItem {
    pub id: String,
    pub explanation: Option<String>,
    pub steps: Vec<AgentPlanStep>,
    pub summary: String,
    pub completed: u32,
    pub total: u32,
    pub current_step: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSubagentItem {
    pub id: String,
    pub agent_id: String,
    pub action: String,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSubagentMessageItem {
    pub id: String,
    pub agent_id: String,
    pub content: String,
    pub visibility: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextCompactionItem {
    pub id: String,
    pub summary: String,
    pub dropped_item_count: usize,
    pub estimated_tokens_before: Option<u64>,
    pub estimated_tokens_after: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentErrorItem {
    pub id: Option<String>,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    #[serde(default)]
    pub cancelled: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_timing: Option<crate::agent::runtime_protocol::AgentModelTiming>,
    pub id: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window_remaining_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window_strategy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window_used_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_context_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    pub provider_payload: Value,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFileReferenceItem {
    pub id: String,
    pub path: String,
    pub mime_type: Option<String>,
    pub reference_kind: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentMessageContent {
    Text(String),
    Parts(Vec<AgentContentPart>),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentContentPart {
    Text {
        text: String,
    },
    Image {
        url: String,
        detail: Option<String>,
    },
    File {
        identifier: String,
        mime_type: Option<String>,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AgentItemHistory {
    pub items: Vec<AgentItem>,
}

impl AgentItemHistory {
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
    pub fn len(&self) -> usize {
        self.items.len()
    }
    #[cfg(test)]
    pub fn clear(&mut self) {
        self.items.clear();
    }

    pub fn from_legacy_messages(messages: &[Value]) -> Result<Self, String> {
        let items = messages
            .iter()
            .enumerate()
            .map(|(index, message)| {
                AgentItem::from_legacy_message(message).map_err(|error| {
                    format!("invalid agent history message at index {index}: {error}")
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { items })
    }

    pub fn to_provider_messages(&self) -> Result<Vec<Value>, String> {
        self.items
            .iter()
            .map(AgentItem::to_provider_message)
            .collect()
    }

    pub fn to_legacy_messages(&self) -> Result<Vec<Value>, String> {
        self.items
            .iter()
            .map(AgentItem::to_legacy_message)
            .collect()
    }

    pub fn assistant_tool_call_batch_count(&self) -> usize {
        self.items
            .iter()
            .filter(|item| {
                matches!(
                    item,
                    AgentItem::AssistantMessage(message) if !message.tool_calls.is_empty()
                )
            })
            .count()
    }
}

impl AgentItem {
    pub fn from_legacy_message(value: &Value) -> Result<Self, String> {
        let object = value
            .as_object()
            .ok_or_else(|| "agent message must be an object".to_string())?;
        let role = object
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| "agent message role must be a string".to_string())?;
        let origin = serde_json::from_value::<AgentMessageOrigin>(value.clone())
            .map_err(|error| format!("invalid agent message origin: {error}"))?;
        let id = value
            .get("id")
            .filter(|id| !id.is_null())
            .map(|id| {
                id.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| "agent message id must be a string".to_string())
            })
            .transpose()?
            .or_else(|| origin.message_id.clone());
        match role {
            "system" | "developer" => Ok(Self::Instruction(AgentInstructionMessage {
                id,
                origin,
                role: if role == "system" {
                    AgentInstructionRole::System
                } else {
                    AgentInstructionRole::Developer
                },
                content: required_content(object.get("content"), role)?,
            })),
            "user" => Ok(Self::UserMessage(AgentMessage {
                client_event_id: optional_string_field(
                    object,
                    &["clientEventId", "client_event_id"],
                    "client event id",
                )?,
                selected_skills: object
                    .get("selectedSkills")
                    .map(|value| {
                        serde_json::from_value(value.clone())
                            .map_err(|error| format!("invalid selectedSkills: {error}"))
                    })
                    .transpose()?
                    .unwrap_or_default(),
                id,
                origin,
                content: required_content(object.get("content"), role)?,
                references: object
                    .get("references")
                    .map(|value| {
                        serde_json::from_value(value.clone())
                            .map_err(|error| format!("invalid user references: {error}"))
                    })
                    .transpose()?
                    .unwrap_or_default(),
            })),
            "assistant" => Ok(Self::AssistantMessage(AgentAssistantMessage {
                id,
                origin,
                content: optional_content(object.get("content"))?,
                reasoning: optional_string_field(
                    object,
                    &["reasoning_content", "reasoningContent"],
                    "assistant reasoning content",
                )?,
                tool_calls: parse_legacy_tool_calls(object.get("tool_calls"))?,
                context_compaction: object
                    .get("contextCompaction")
                    .or_else(|| object.get("context_compaction"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })),
            "tool" => Ok(Self::ToolResult(AgentToolResultItem {
                id,
                origin,
                tool_call_id: object
                    .get("tool_call_id")
                    .or_else(|| object.get("toolCallId"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "tool result requires tool_call_id".to_string())?
                    .to_string(),
                name: object
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                content: required_content(object.get("content"), role)?,
                is_error: object
                    .get("is_error")
                    .or_else(|| object.get("isError"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })),
            unsupported => Err(format!("unsupported agent message role `{unsupported}`")),
        }
    }

    pub fn to_legacy_message(&self) -> Result<Value, String> {
        let mut value = self.to_message(false)?;
        let (id, origin) = match self {
            Self::Instruction(message) => (&message.id, &message.origin),
            Self::UserMessage(message) => {
                if let Some(client_event_id) = &message.client_event_id {
                    value["clientEventId"] = client_event_id.clone().into();
                }
                if !message.selected_skills.is_empty() {
                    value["selectedSkills"] = serde_json::json!(message.selected_skills);
                }
                (&message.id, &message.origin)
            }
            Self::AssistantMessage(message) => (&message.id, &message.origin),
            Self::ToolResult(message) => {
                value["is_error"] = message.is_error.into();
                (&message.id, &message.origin)
            }
            _ => unreachable!("to_message rejects non-message items"),
        };
        if let Some(id) = id {
            value["id"] = id.clone().into();
        }
        let fields = serde_json::to_value(origin).expect("message origin must serialize");
        value
            .as_object_mut()
            .expect("message must be an object")
            .extend(
                fields
                    .as_object()
                    .expect("origin must be an object")
                    .clone(),
            );
        Ok(value)
    }

    fn to_provider_message(&self) -> Result<Value, String> {
        self.to_message(true)
    }

    fn to_message(&self, provider_names: bool) -> Result<Value, String> {
        match self {
            Self::Instruction(message) => Ok(serde_json::json!({
                "role": message.role.as_str(),
                "content": message.content.to_value(),
            })),
            Self::UserMessage(message) => {
                let mut value = serde_json::json!({
                    "role": "user",
                    "content": message.content.to_value(),
                });
                if !message.references.is_empty() {
                    value["references"] = Value::Array(message.references.clone());
                }
                Ok(value)
            }
            Self::AssistantMessage(message) => {
                if message.context_compaction {
                    if message.reasoning.is_some() || !message.tool_calls.is_empty() {
                        return Err(
                            "context compaction summary cannot contain reasoning or tool calls"
                                .to_string(),
                        );
                    }
                    let content = message.content.as_ref().ok_or_else(|| {
                        "context compaction summary requires message content".to_string()
                    })?;
                    if provider_names {
                        return Ok(serde_json::json!({
                            "role": "user",
                            "content": content.to_value(),
                        }));
                    }
                    return Ok(serde_json::json!({
                        "role": "assistant",
                        "content": content.to_value(),
                        "contextCompaction": true,
                    }));
                }
                let tool_calls = message
                    .tool_calls
                    .iter()
                    .map(|tool_call| {
                        let name = if provider_names {
                            super::tool_router::provider_tool_name(&tool_call.name)
                        } else {
                            tool_call.name.clone()
                        };
                        serde_json::json!({
                            "id": tool_call.id,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": tool_call.arguments_json,
                            }
                        })
                    })
                    .collect::<Vec<_>>();
                let mut value = serde_json::json!({
                    "role": "assistant",
                    "content": message.content.as_ref().map(AgentMessageContent::to_value).unwrap_or(Value::Null),
                });
                if !tool_calls.is_empty() {
                    value["tool_calls"] = Value::Array(tool_calls);
                }
                if let Some(reasoning) = message.reasoning.as_deref() {
                    value["reasoning_content"] = Value::String(reasoning.to_string());
                }
                Ok(value)
            }
            Self::ToolResult(result) => {
                let name = result.name.as_ref().map(|name| {
                    if provider_names {
                        super::tool_router::provider_tool_name(name)
                    } else {
                        name.clone()
                    }
                });
                let mut value = serde_json::json!({
                    "role": "tool",
                    "tool_call_id": result.tool_call_id,
                    "content": result.content.to_value(),
                });
                if let Some(name) = name {
                    value["name"] = Value::String(name);
                }
                Ok(value)
            }
            other => Err(format!(
                "agent item `{}` cannot be encoded as a chat/completions message",
                other.kind()
            )),
        }
    }

    pub(super) fn kind(&self) -> &'static str {
        match self {
            Self::Instruction(_) => "instruction",
            Self::UserMessage(_) => "user_message",
            Self::AssistantMessage(_) => "assistant_message",
            Self::Reasoning(_) => "reasoning",
            Self::ToolResult(_) => "tool_result",
            Self::UserInput(_) => "user_input",
            Self::PlanProgress(_) => "plan_progress",
            Self::Subagent(_) => "subagent",
            Self::SubagentMessage(_) => "subagent_message",
            Self::ContextCompaction(_) => "context_compaction",
            Self::Error(_) => "error",
            Self::Usage(_) => "usage",
            Self::FileReference(_) => "file_reference",
        }
    }
}

impl AgentMessageContent {
    pub fn text(content: impl Into<String>) -> Self {
        Self::Text(content.into())
    }

    pub fn to_value(&self) -> Value {
        match self {
            Self::Text(text) => Value::String(text.clone()),
            Self::Parts(parts) => {
                Value::Array(parts.iter().map(AgentContentPart::to_value).collect())
            }
        }
    }
}

impl AgentContentPart {
    fn from_value(value: &Value) -> Result<Self, String> {
        let object = value
            .as_object()
            .ok_or_else(|| "message content part must be an object".to_string())?;
        let part_type = object
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "message content part requires type".to_string())?;
        match part_type {
            "text" | "input_text" | "output_text" => Ok(Self::Text {
                text: object
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("{part_type} content part requires text"))?
                    .to_string(),
            }),
            "image_url" | "input_image" => {
                let image = object
                    .get("image_url")
                    .or_else(|| object.get("url"))
                    .ok_or_else(|| format!("{part_type} content part requires image_url"))?;
                let (url, detail) = match image {
                    Value::String(url) => (
                        url.clone(),
                        optional_string_field(object, &["detail"], "image detail")?,
                    ),
                    Value::Object(image) => (
                        image
                            .get("url")
                            .and_then(Value::as_str)
                            .ok_or_else(|| "image_url object requires url".to_string())?
                            .to_string(),
                        image
                            .get("detail")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    ),
                    _ => return Err("image_url must be a string or object".to_string()),
                };
                Ok(Self::Image { url, detail })
            }
            "file" | "input_file" => Ok(Self::File {
                identifier: object
                    .get("path")
                    .or_else(|| object.get("file_id"))
                    .or_else(|| object.get("filename"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("{part_type} content part requires a file identifier"))?
                    .to_string(),
                mime_type: object
                    .get("mime_type")
                    .or_else(|| object.get("mimeType"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
            }),
            unsupported => Err(format!("unsupported agent content part `{unsupported}`")),
        }
    }

    fn to_value(&self) -> Value {
        match self {
            Self::Text { text } => serde_json::json!({ "type": "text", "text": text }),
            Self::Image { url, detail } => {
                let mut image_url = serde_json::json!({ "url": url });
                if let Some(detail) = detail {
                    image_url["detail"] = Value::String(detail.clone());
                }
                serde_json::json!({
                    "type": "image_url",
                    "image_url": image_url,
                })
            }
            Self::File {
                identifier,
                mime_type,
            } => serde_json::json!({
                "type": "file",
                "path": identifier,
                "mime_type": mime_type,
            }),
        }
    }
}

impl AgentUsageItem {
    pub fn from_runtime_usage(
        provider_payload: Value,
        normalized_usage: Value,
    ) -> Result<Self, String> {
        let provider_token_usage =
            crate::token_usage::normalize_provider_token_usage(&provider_payload)?;
        let object = normalized_usage
            .as_object()
            .ok_or_else(|| "normalized usage must be an object".to_string())?;
        let token_usage = crate::token_usage::normalize_provider_token_usage(&normalized_usage)?
            .or(provider_token_usage);
        let mut item = Self {
            id: None,
            model_timing: None,
            input_tokens: token_usage.as_ref().map(|usage| usage.input_tokens),
            output_tokens: token_usage.as_ref().map(|usage| usage.output_tokens),
            total_tokens: token_usage.as_ref().map(|usage| usage.total_tokens),
            context_window_remaining_tokens: None,
            context_window_strategy: None,
            context_window_tokens: None,
            context_window_used_tokens: None,
            estimated_context_tokens: None,
            percent: None,
            provider_payload,
        };
        item.context_window_remaining_tokens = optional_usage_number(
            object,
            &[
                "context_window_remaining_tokens",
                "contextWindowRemainingTokens",
            ],
        )?;
        item.context_window_strategy = optional_string_field(
            object,
            &["context_window_strategy", "contextWindowStrategy"],
            "context window strategy",
        )?;
        item.context_window_tokens =
            optional_usage_number(object, &["context_window_tokens", "contextWindowTokens"])?;
        item.context_window_used_tokens = optional_usage_number(
            object,
            &["context_window_used_tokens", "contextWindowUsedTokens"],
        )?;
        item.estimated_context_tokens = optional_usage_number(
            object,
            &["estimated_context_tokens", "estimatedContextTokens"],
        )?;
        item.percent = optional_usage_float(object, &["percent"])?;
        Ok(item)
    }
}

fn required_content(value: Option<&Value>, role: &str) -> Result<AgentMessageContent, String> {
    optional_content(value)?.ok_or_else(|| format!("{role} message requires content"))
}

fn optional_content(value: Option<&Value>) -> Result<Option<AgentMessageContent>, String> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    match value {
        Value::String(text) => Ok(Some(AgentMessageContent::Text(text.clone()))),
        Value::Array(parts) => Ok(Some(AgentMessageContent::Parts(
            parts
                .iter()
                .map(AgentContentPart::from_value)
                .collect::<Result<Vec<_>, _>>()?,
        ))),
        _ => Err("agent message content must be a string, array, or null".to_string()),
    }
}

fn parse_legacy_tool_calls(value: Option<&Value>) -> Result<Vec<AgentToolCallItem>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let calls = value
        .as_array()
        .ok_or_else(|| "assistant tool_calls must be an array".to_string())?;
    calls
        .iter()
        .enumerate()
        .map(|(index, call)| parse_tool_call(call, index, |name| Ok(name.to_string())))
        .collect()
}

pub(super) fn parse_tool_call(
    value: &Value,
    index: usize,
    resolve_name: impl FnOnce(&str) -> Result<String, String>,
) -> Result<AgentToolCallItem, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("tool call at index {index} must be an object"))?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("tool call at index {index} requires id"))?
        .to_string();
    if object
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind != "function")
    {
        return Err(format!("tool call `{id}` must have type `function`"));
    }
    let function = object
        .get("function")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("tool call `{id}` requires function"))?;
    let provider_name = function
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("tool call `{id}` requires function name"))?;
    let arguments = function
        .get("arguments")
        .ok_or_else(|| format!("tool call `{id}` requires function arguments"))?;
    let arguments_json = arguments
        .as_str()
        .ok_or_else(|| format!("tool call `{id}` function arguments must be a string"))?
        .to_string();
    Ok(AgentToolCallItem {
        id,
        name: resolve_name(provider_name)?,
        arguments_json,
    })
}

fn optional_usage_number(
    object: &serde_json::Map<String, Value>,
    keys: &[&str],
) -> Result<Option<i64>, String> {
    let Some((key, value)) = keys
        .iter()
        .find_map(|key| object.get(*key).map(|value| (*key, value)))
    else {
        return Ok(None);
    };
    value
        .as_i64()
        .map(Some)
        .ok_or_else(|| format!("provider usage `{key}` must be an integer"))
}

fn optional_usage_float(
    object: &serde_json::Map<String, Value>,
    keys: &[&str],
) -> Result<Option<f64>, String> {
    let Some((key, value)) = keys
        .iter()
        .find_map(|key| object.get(*key).map(|value| (*key, value)))
    else {
        return Ok(None);
    };
    value
        .as_f64()
        .map(Some)
        .ok_or_else(|| format!("provider usage `{key}` must be a number"))
}

fn optional_string_field(
    object: &serde_json::Map<String, Value>,
    keys: &[&str],
    label: &str,
) -> Result<Option<String>, String> {
    let Some(value) = keys.iter().find_map(|key| object.get(*key)) else {
        return Ok(None);
    };
    value
        .as_str()
        .map(str::to_string)
        .map(Some)
        .ok_or_else(|| format!("{label} must be a string"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_history_preserves_origins_parts_references_and_tool_errors() {
        #[derive(Serialize, Deserialize)]
        struct Checkpoint {
            #[serde(with = "legacy_history")]
            messages: AgentItemHistory,
        }
        let messages = AgentItemHistory::from_legacy_messages(&[
            serde_json::json!({
                "role":"user", "id":"user-1", "messageId":"local-user-1",
                "threadId":"thread-source", "turnId":"turn-source", "rolloutOrdinal":17,
                "clientEventId":"client-1", "selectedSkills":["review"], "references":[{"path":"notes.md"}],
                "content":[{"type":"input_text","text":"inspect"},
                    {"type":"input_image","image_url":"data:image/png;base64,AA=="}]
            }),
            serde_json::json!({
                "role":"assistant", "id":"provider-item-1", "messageId":"local-call-1",
                "threadId":"thread-source", "turnId":"turn-source", "rolloutOrdinal":18,
                "content":null, "tool_calls":[{"id":"call-1", "type":"function",
                    "function":{"name":"read_file","arguments":"{}"}}]
            }),
            serde_json::json!({
                "role":"tool", "id":"result-1", "turnId":"turn-source", "rolloutOrdinal":19,
                "tool_call_id":"call-1", "name":"read_file", "content":"denied", "is_error":true
            }),
            serde_json::json!({
                "role":"assistant", "id":"summary:ctx-1", "contextId":"ctx-1",
                "contextCompaction":true, "content":"summary"
            }),
        ])
        .unwrap();
        let encoded = serde_json::to_value(Checkpoint {
            messages: messages.clone(),
        })
        .unwrap();
        assert_eq!(encoded["messages"][0]["clientEventId"], "client-1");
        assert_eq!(encoded["messages"][0]["selectedSkills"][0], "review");
        assert_eq!(encoded["messages"][1]["messageId"], "local-call-1");
        assert_eq!(encoded["messages"][2]["is_error"], true);
        let restored: Checkpoint = serde_json::from_value(encoded).unwrap();
        assert_eq!(restored.messages, messages);
        for message in messages.to_provider_messages().unwrap() {
            for field in [
                "id",
                "messageId",
                "threadId",
                "turnId",
                "rolloutOrdinal",
                "contextId",
                "clientEventId",
                "is_error",
            ] {
                assert!(message.get(field).is_none(), "local field leaked: {field}");
            }
        }
    }

    #[test]
    fn provider_tool_call_requires_string_arguments() {
        for (arguments, expected) in [
            (None, "requires function arguments"),
            (
                Some(serde_json::json!({})),
                "function arguments must be a string",
            ),
        ] {
            let mut function = serde_json::json!({ "name": "workspace.read_file" });
            if let Some(arguments) = arguments {
                function["arguments"] = arguments;
            }
            let error = parse_tool_call(
                &serde_json::json!({
                    "id": "call-invalid-arguments",
                    "type": "function",
                    "function": function,
                }),
                0,
                |name| Ok(name.to_string()),
            )
            .expect_err("invalid provider arguments should fail");
            assert!(
                error.contains(expected),
                "expected `{expected}` in `{error}`"
            );
        }
    }

    #[test]
    fn provider_tool_call_preserves_original_arguments_json() {
        let arguments_json = " { \"path\" : \"README.md\" } ";
        let call = parse_tool_call(
            &serde_json::json!({
                "id": "call-preserve-arguments",
                "type": "function",
                "function": {
                    "name": "workspace.read_file",
                    "arguments": arguments_json,
                },
            }),
            0,
            |name| Ok(name.to_string()),
        )
        .expect("provider tool call should parse");

        assert_eq!(call.arguments_json, arguments_json);
    }
}

pub(super) mod legacy_history {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        history: &AgentItemHistory,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        use serde::ser::Error;
        history
            .to_legacy_messages()
            .map_err(S::Error::custom)?
            .serialize(serializer)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<AgentItemHistory, D::Error> {
        use serde::de::Error;
        let messages = Vec::<Value>::deserialize(deserializer)?;
        AgentItemHistory::from_legacy_messages(&messages).map_err(D::Error::custom)
    }
}
