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
    Approval(AgentApprovalItem),
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
    pub role: AgentInstructionRole,
    pub content: AgentMessageContent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: Option<String>,
    pub content: AgentMessageContent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAssistantMessage {
    pub id: Option<String>,
    pub content: Option<AgentMessageContent>,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<AgentToolCallItem>,
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
    pub tool_call_id: String,
    pub name: Option<String>,
    pub content: AgentMessageContent,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReasoningItem {
    pub id: Option<String>,
    pub summary: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentApprovalItem {
    pub id: String,
    pub tool_call_id: Option<String>,
    pub status: String,
    pub reason: Option<String>,
    pub decision: Option<String>,
    pub scope: Option<String>,
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
    pub id: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
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
        let id = message_id(value);
        match role {
            "system" | "developer" => Ok(Self::Instruction(AgentInstructionMessage {
                id,
                role: if role == "system" {
                    AgentInstructionRole::System
                } else {
                    AgentInstructionRole::Developer
                },
                content: required_content(object.get("content"), role)?,
            })),
            "user" => Ok(Self::UserMessage(AgentMessage {
                id,
                content: required_content(object.get("content"), role)?,
            })),
            "assistant" => Ok(Self::AssistantMessage(AgentAssistantMessage {
                id,
                content: optional_content(object.get("content"))?,
                reasoning: optional_string_field(
                    object,
                    &["reasoning_content", "reasoningContent"],
                    "assistant reasoning content",
                )?,
                tool_calls: parse_legacy_tool_calls(object.get("tool_calls"))?,
            })),
            "tool" => Ok(Self::ToolResult(AgentToolResultItem {
                id,
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
        self.to_message(false)
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
            Self::UserMessage(message) => Ok(serde_json::json!({
                "role": "user",
                "content": message.content.to_value(),
            })),
            Self::AssistantMessage(message) => {
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

    fn kind(&self) -> &'static str {
        match self {
            Self::Instruction(_) => "instruction",
            Self::UserMessage(_) => "user_message",
            Self::AssistantMessage(_) => "assistant_message",
            Self::Reasoning(_) => "reasoning",
            Self::ToolResult(_) => "tool_result",
            Self::Approval(_) => "approval",
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

    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            Self::Parts(_) => None,
        }
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
            "text" | "input_text" => Ok(Self::Text {
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
                    Value::String(url) => (url.clone(), None),
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
            Self::Image { url, detail } => serde_json::json!({
                "type": "image_url",
                "image_url": { "url": url, "detail": detail }
            }),
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
    pub fn from_provider_payload(provider_payload: Value) -> Result<Self, String> {
        let object = provider_payload
            .as_object()
            .ok_or_else(|| "provider usage must be an object".to_string())?;
        Ok(Self {
            id: None,
            input_tokens: optional_usage_number(object, &["prompt_tokens", "promptTokens"])?,
            output_tokens: optional_usage_number(
                object,
                &["completion_tokens", "completionTokens"],
            )?,
            total_tokens: optional_usage_number(object, &["total_tokens", "totalTokens"])?,
            provider_payload,
        })
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
    let arguments_json = function
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or("{}")
        .to_string();
    Ok(AgentToolCallItem {
        id,
        name: resolve_name(provider_name)?,
        arguments_json,
    })
}

fn message_id(value: &Value) -> Option<String> {
    value
        .get("messageId")
        .or_else(|| value.get("message_id"))
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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
