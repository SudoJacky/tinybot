use super::checkpoint::save_phase_checkpoint;
use super::continuations::typed_continuation_from_metadata;
use super::state::AgentTurnState;
use super::tool_projection::{
    append_continuation_tool_observation, completed_tool_result_entry, tool_observation_content,
};
use super::{
    AgentTurnContext, NativeAgentRuntimeServices, NativeAgentToolCall, NativeAgentToolResult,
};
use crate::agent::runtime_protocol::{AgentContinuationInput, AgentFormAction, AgentRuntimePhase};
use crate::tools::registry::REQUEST_USER_INPUT_METHOD;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;

const MAX_FORM_FIELDS: usize = 50;
const MAX_FORM_OPTIONS: usize = 100;
const MAX_FORM_TEXT_LENGTH: usize = 2_000;
const MAX_TOOL_CALL_ID_LENGTH: usize = 117;

pub(super) enum UserInputContinuationOutcome {
    Resume(UserInputResume),
    Finished(Value),
}

pub(super) struct UserInputResume {
    iteration: i64,
    tool_call: NativeAgentToolCall,
    completed_result: Value,
    observation_content: String,
    envelope: Value,
    form_id: String,
    values: Value,
}

impl UserInputResume {
    pub(super) fn apply(self, context: &AgentTurnContext, state: &mut AgentTurnState) -> i64 {
        state.tools_used.push(self.tool_call.name.clone());
        state.completed_tool_results.push(self.completed_result);
        state.emit_event(
            "agent.form.resolution",
            serde_json::json!({
                "turnId": context.turn_id,
                "sessionId": context.session_id,
                "iteration": self.iteration,
                "formId": self.form_id,
                "detailId": format!("form:{}", self.form_id),
                "status": "completed",
                "action": "submit",
                "values": self.values,
            }),
        );
        state.emit_event(
            "agent.tool.result",
            serde_json::json!({
                "turnId": context.turn_id,
                "sessionId": context.session_id,
                "iteration": self.iteration,
                "toolCallId": self.tool_call.id,
                "toolName": self.tool_call.name,
                "name": self.tool_call.name,
                "detailId": format!("tool:{}", self.tool_call.id),
                "status": "completed",
                "resultStatus": self.envelope.get("status").cloned().unwrap_or(Value::Null),
                "summary": self
                    .envelope
                    .get("summary")
                    .cloned()
                    .unwrap_or_else(|| Value::String(self.observation_content.clone())),
                "content": self.observation_content,
                "envelope": self.envelope,
            }),
        );
        self.iteration.saturating_add(1)
    }
}

pub(super) fn awaiting_user_input_result(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    tool_call: NativeAgentToolCall,
) -> Result<Value, String> {
    let form_id = form_id_for_tool_call(&tool_call.id)?;
    let request = parse_user_input_request(&tool_call.arguments_json)?;
    let mut form = serde_json::to_value(request)
        .map_err(|error| format!("failed to serialize request_user_input form: {error}"))?;
    form["form_id"] = Value::String(form_id.clone());
    form["correlation"] = serde_json::json!({
        "form_id": form_id,
        "turn_id": context.turn_id,
        "session_id": context.session_id,
        "tool_call_id": tool_call.id,
    });

    state.tools_used.push(tool_call.name.clone());
    state.set_pending_tool_call(&tool_call);
    state.transition_phase(
        AgentRuntimePhase::AwaitingForm,
        iteration,
        "agent.awaiting_form",
    );
    let checkpoint = save_phase_checkpoint(
        services,
        context,
        state.phase.as_str(),
        serde_json::json!({
            "kind": "user_input",
            "iteration": iteration,
            "formId": form_id,
            "form": form,
            "pendingToolCalls": state.pending_tool_calls.clone(),
            "completedToolResults": state.completed_tool_results.clone(),
            "messages": state.history.messages(),
            "resumeToken": format!("form:{form_id}"),
        }),
    );
    state.emit_event(
        "agent.checkpoint",
        serde_json::json!({
            "turnId": context.turn_id,
            "sessionId": context.session_id,
            "phase": "awaiting_form",
            "checkpoint": checkpoint.clone(),
        }),
    );
    state.emit_event(
        "agent.awaiting_form",
        serde_json::json!({
            "turnId": context.turn_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "formId": form_id,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "detailId": format!("form:{form_id}"),
            "status": "waiting",
            "summary": form["title"],
            "form": form,
        }),
    );
    state.set_stop_reason("awaiting_form", iteration, "agent.done");
    state.emit_event(
        "agent.done",
        serde_json::json!({
            "turnId": context.turn_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "stopReason": "awaiting_form",
        }),
    );
    let runtime_events = state.runtime_events();
    let events = state.legacy_events();
    Ok(serde_json::json!({
        "runtime": "rust",
        "turnId": context.turn_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "awaiting_form",
        "messages": [],
        "toolsUsed": state.tools_used,
        "completedToolResults": state.completed_tool_results,
        "form": form,
        "checkpoint": checkpoint,
        "events": events,
        "runtimeEvents": runtime_events,
    }))
}

pub(super) fn prepare_user_input_continuation(
    services: &NativeAgentRuntimeServices,
    context: &mut AgentTurnContext,
) -> Result<Option<UserInputContinuationOutcome>, String> {
    let Some(AgentContinuationInput::Form {
        form_id,
        action,
        values,
    }) = typed_continuation_from_metadata(&context.metadata)
    else {
        return Ok(None);
    };
    let Some(checkpoint) = services
        .checkpoints
        .restore_for_turn(&context.session_id, &context.turn_id)
    else {
        return Ok(None);
    };
    if checkpoint.pointer("/payload/kind").and_then(Value::as_str) != Some("user_input") {
        return Ok(None);
    }
    validate_user_input_checkpoint(&checkpoint, &form_id)?;
    let tool_call = user_input_pending_tool_call(&checkpoint)?;
    let iteration = checkpoint
        .get("iteration")
        .and_then(Value::as_i64)
        .or_else(|| {
            checkpoint
                .pointer("/payload/iteration")
                .and_then(Value::as_i64)
        })
        .ok_or_else(|| "invalid user input checkpoint: iteration is missing".to_string())?;

    if matches!(action, AgentFormAction::Cancel) {
        services
            .checkpoints
            .clear_for_turn(&context.session_id, &context.turn_id);
        return Ok(Some(UserInputContinuationOutcome::Finished(
            cancelled_user_input_result(services, context, checkpoint, form_id, iteration),
        )));
    }

    let form = checkpoint
        .pointer("/payload/form")
        .ok_or_else(|| "invalid user input checkpoint: form is missing".to_string())?;
    let values = validate_submitted_values(form, values)?;
    let mut messages = checkpoint
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "invalid user input checkpoint: messages must be an array".to_string())?;
    let raw_result = serde_json::json!({
        "formId": form_id,
        "status": "submitted",
        "values": values,
    });
    let result = NativeAgentToolResult::generic_success(&tool_call, raw_result);
    let observation_content = tool_observation_content(&result);
    let completed_result = completed_tool_result_entry(&tool_call, &result);
    let envelope = serde_json::to_value(&result.envelope)
        .map_err(|error| format!("failed to serialize user input tool result: {error}"))?;
    append_continuation_tool_observation(&mut messages, &tool_call, &observation_content, false)
        .map_err(|error| format!("invalid user input checkpoint: {error}"))?;
    context.messages = messages.clone();
    context.spec["messages"] = Value::Array(messages);
    services
        .checkpoints
        .clear_for_turn(&context.session_id, &context.turn_id);

    Ok(Some(UserInputContinuationOutcome::Resume(
        UserInputResume {
            iteration,
            tool_call,
            completed_result,
            observation_content,
            envelope,
            form_id,
            values,
        },
    )))
}

fn cancelled_user_input_result(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    checkpoint: Value,
    form_id: String,
    iteration: i64,
) -> Value {
    let message = "User input request was cancelled.";
    let mut state = AgentTurnState::new_for_continuation(context, services.trace_sink.clone())
        .expect("form cancellation must restore persisted runtime events");
    state.tools_used.push(REQUEST_USER_INPUT_METHOD.to_string());
    state.transition_phase(
        AgentRuntimePhase::AwaitingForm,
        iteration,
        "agent.form.resolution",
    );
    state.emit_event(
        "agent.form.resolution",
        serde_json::json!({
            "turnId": context.turn_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "formId": form_id,
            "detailId": format!("form:{form_id}"),
            "status": "completed",
            "action": "cancel",
        }),
    );
    state.set_stop_reason("form_cancelled", iteration, "agent.error");
    state.emit_event(
        "agent.error",
        serde_json::json!({
            "turnId": context.turn_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "stopReason": "form_cancelled",
            "message": message,
            "error": message,
        }),
    );
    let runtime_events = state.runtime_events();
    let events = state.legacy_events();
    serde_json::json!({
        "runtime": "rust",
        "turnId": context.turn_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "form_cancelled",
        "messages": [],
        "toolsUsed": state.tools_used,
        "error": message,
        "restoredCheckpoint": checkpoint,
        "continuation": {
            "kind": "form",
            "formId": form_id,
            "action": "cancel",
        },
        "events": events,
        "runtimeEvents": runtime_events,
    })
}

fn validate_user_input_checkpoint(checkpoint: &Value, form_id: &str) -> Result<(), String> {
    if checkpoint.get("phase").and_then(Value::as_str) != Some("awaiting_form") {
        return Err("invalid user input checkpoint: phase must be awaiting_form".to_string());
    }
    let expected_form_id = checkpoint
        .pointer("/payload/formId")
        .and_then(Value::as_str)
        .ok_or_else(|| "invalid user input checkpoint: formId is missing".to_string())?;
    if form_id != expected_form_id {
        return Err(format!(
            "form continuation ID `{form_id}` does not match checkpoint `{expected_form_id}`"
        ));
    }
    Ok(())
}

fn user_input_pending_tool_call(checkpoint: &Value) -> Result<NativeAgentToolCall, String> {
    let pending = checkpoint
        .get("pendingToolCalls")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "invalid user input checkpoint: pendingToolCalls must be an array".to_string()
        })?;
    if pending.len() != 1 {
        return Err(format!(
            "invalid user input checkpoint: expected one pending tool call, found {}",
            pending.len()
        ));
    }
    let pending = &pending[0];
    let id = required_string(pending, "toolCallId", "pending toolCallId")?;
    let name = required_string(pending, "toolName", "pending toolName")?;
    if name != REQUEST_USER_INPUT_METHOD {
        return Err(format!(
            "invalid user input checkpoint: pending tool must be `{REQUEST_USER_INPUT_METHOD}`, found `{name}`"
        ));
    }
    Ok(NativeAgentToolCall {
        id,
        name,
        arguments_json: required_string(pending, "argumentsJson", "pending argumentsJson")?,
        result: Value::Null,
    })
}

fn form_id_for_tool_call(tool_call_id: &str) -> Result<String, String> {
    if tool_call_id.is_empty()
        || tool_call_id.len() > MAX_TOOL_CALL_ID_LENGTH
        || !tool_call_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
    {
        return Err(format!(
            "invalid request_user_input tool call id: expected 1-{MAX_TOOL_CALL_ID_LENGTH} safe ASCII characters"
        ));
    }
    Ok(format!("user-input:{tool_call_id}"))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct UserInputRequest {
    title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    submit_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cancel_label: Option<String>,
    fields: Vec<UserInputField>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct UserInputField {
    name: String,
    #[serde(rename = "type")]
    field_type: String,
    label: String,
    #[serde(default)]
    required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    help: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    options: Option<Vec<UserInputOption>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct UserInputOption {
    label: String,
    value: String,
}

fn parse_user_input_request(arguments_json: &str) -> Result<UserInputRequest, String> {
    let mut request = serde_json::from_str::<UserInputRequest>(arguments_json)
        .map_err(|error| format!("invalid request_user_input arguments: {error}"))?;
    normalize_required_string(&mut request.title, "title", 256)?;
    normalize_optional_string(&mut request.description, "description", 1_024)?;
    normalize_optional_string(&mut request.submit_label, "submit_label", 128)?;
    normalize_optional_string(&mut request.cancel_label, "cancel_label", 128)?;
    if request.fields.is_empty() || request.fields.len() > MAX_FORM_FIELDS {
        return Err(format!(
            "invalid request_user_input arguments: fields must contain between 1 and {MAX_FORM_FIELDS} entries"
        ));
    }
    let mut names = HashSet::new();
    for (index, field) in request.fields.iter_mut().enumerate() {
        normalize_field(field, index)?;
        if !names.insert(field.name.clone()) {
            return Err(format!(
                "invalid request_user_input arguments: duplicate field name `{}`",
                field.name
            ));
        }
    }
    Ok(request)
}

fn normalize_field(field: &mut UserInputField, index: usize) -> Result<(), String> {
    normalize_required_string(&mut field.name, &format!("fields[{index}].name"), 64)?;
    if matches!(
        field.name.as_str(),
        "__proto__" | "constructor" | "prototype"
    ) || !is_safe_field_name(&field.name)
    {
        return Err(format!(
            "invalid request_user_input arguments: fields[{index}].name is unsafe"
        ));
    }
    normalize_required_string(&mut field.field_type, &format!("fields[{index}].type"), 64)?;
    if !matches!(
        field.field_type.as_str(),
        "text" | "textarea" | "number" | "select" | "multiselect" | "radio" | "checkbox"
    ) {
        return Err(format!(
            "invalid request_user_input arguments: fields[{index}].type is unsupported"
        ));
    }
    normalize_required_string(&mut field.label, &format!("fields[{index}].label"), 256)?;
    normalize_optional_string(
        &mut field.placeholder,
        &format!("fields[{index}].placeholder"),
        512,
    )?;
    normalize_optional_string(&mut field.help, &format!("fields[{index}].help"), 512)?;
    let is_choice = matches!(
        field.field_type.as_str(),
        "select" | "multiselect" | "radio"
    );
    match (&mut field.options, is_choice) {
        (Some(options), true) if !options.is_empty() && options.len() <= MAX_FORM_OPTIONS => {
            let mut values = HashSet::new();
            for (option_index, option) in options.iter_mut().enumerate() {
                normalize_required_string(
                    &mut option.label,
                    &format!("fields[{index}].options[{option_index}].label"),
                    256,
                )?;
                normalize_required_string(
                    &mut option.value,
                    &format!("fields[{index}].options[{option_index}].value"),
                    MAX_FORM_TEXT_LENGTH,
                )?;
                if !values.insert(option.value.clone()) {
                    return Err(format!(
                        "invalid request_user_input arguments: fields[{index}] has duplicate option value `{}`",
                        option.value
                    ));
                }
            }
        }
        (Some(_), true) | (None, true) => {
            return Err(format!(
                "invalid request_user_input arguments: fields[{index}].options must contain between 1 and {MAX_FORM_OPTIONS} entries"
            ));
        }
        (Some(_), false) => {
            return Err(format!(
                "invalid request_user_input arguments: fields[{index}].options is only valid for choice fields"
            ));
        }
        (None, false) => {}
    }
    Ok(())
}

fn validate_submitted_values(form: &Value, values: Option<Value>) -> Result<Value, String> {
    let values = match values.unwrap_or_else(|| Value::Object(Map::new())) {
        Value::Object(values) => values,
        _ => return Err("invalid user input submission: values must be an object".to_string()),
    };
    let fields = form
        .get("fields")
        .and_then(Value::as_array)
        .ok_or_else(|| "invalid user input checkpoint: form.fields must be an array".to_string())?;
    let allowed_names = fields
        .iter()
        .filter_map(|field| field.get("name").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    if let Some(unknown) = values
        .keys()
        .find(|name| !allowed_names.contains(name.as_str()))
    {
        return Err(format!(
            "invalid user input submission: unknown field `{unknown}`"
        ));
    }
    for field in fields {
        validate_submitted_field(
            field,
            values.get(required_string(field, "name", "field name")?.as_str()),
        )?;
    }
    Ok(Value::Object(values))
}

fn validate_submitted_field(field: &Value, value: Option<&Value>) -> Result<(), String> {
    let name = required_string(field, "name", "field name")?;
    let field_type = required_string(field, "type", "field type")?;
    let required = field
        .get("required")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let missing = value.is_none_or(|value| {
        value.is_null()
            || value.as_str().is_some_and(str::is_empty)
            || value.as_array().is_some_and(Vec::is_empty)
    });
    if missing {
        return if required {
            Err(format!(
                "invalid user input submission: field `{name}` is required"
            ))
        } else {
            Ok(())
        };
    }
    let value = value.expect("missing values returned above");
    match field_type.as_str() {
        "text" | "textarea" => {
            let text = value.as_str().ok_or_else(|| {
                format!("invalid user input submission: field `{name}` must be a string")
            })?;
            if text.len() > MAX_FORM_TEXT_LENGTH {
                return Err(format!(
                    "invalid user input submission: field `{name}` exceeds {MAX_FORM_TEXT_LENGTH} characters"
                ));
            }
        }
        "number" if !value.is_number() => {
            return Err(format!(
                "invalid user input submission: field `{name}` must be a number"
            ));
        }
        "checkbox" if !value.is_boolean() => {
            return Err(format!(
                "invalid user input submission: field `{name}` must be a boolean"
            ));
        }
        "select" | "radio" => {
            let selected = value.as_str().ok_or_else(|| {
                format!("invalid user input submission: field `{name}` must be a string")
            })?;
            if !choice_values(field).contains(selected) {
                return Err(format!(
                    "invalid user input submission: field `{name}` contains an unsupported option"
                ));
            }
        }
        "multiselect" => {
            let selected = value.as_array().ok_or_else(|| {
                format!("invalid user input submission: field `{name}` must be an array")
            })?;
            let options = choice_values(field);
            if selected.iter().any(|item| {
                item.as_str()
                    .map(|item| !options.contains(item))
                    .unwrap_or(true)
            }) {
                return Err(format!(
                    "invalid user input submission: field `{name}` contains an unsupported option"
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

fn choice_values(field: &Value) -> HashSet<&str> {
    field
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|option| option.get("value").and_then(Value::as_str))
        .collect()
}

fn required_string(value: &Value, key: &str, label: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("invalid user input checkpoint: {label} is missing"))
}

fn normalize_required_string(
    value: &mut String,
    path: &str,
    max_length: usize,
) -> Result<(), String> {
    *value = value.trim().to_string();
    if value.is_empty() || value.len() > max_length {
        return Err(format!(
            "invalid request_user_input arguments: {path} must contain between 1 and {max_length} characters"
        ));
    }
    Ok(())
}

fn normalize_optional_string(
    value: &mut Option<String>,
    path: &str,
    max_length: usize,
) -> Result<(), String> {
    let Some(current) = value.as_mut() else {
        return Ok(());
    };
    *current = current.trim().to_string();
    if current.len() > max_length {
        return Err(format!(
            "invalid request_user_input arguments: {path} must not exceed {max_length} characters"
        ));
    }
    if current.is_empty() {
        *value = None;
    }
    Ok(())
}

fn is_safe_field_name(name: &str) -> bool {
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
        })
}
