use super::checkpoint::save_phase_checkpoint;
use super::state::AgentTurnState;
use super::tool_projection::{commit_tool_observation, prepare_continuation_tool_observation};
use super::{
    AgentHookInvocation, AgentHookStage, AgentTurnContext, NativeAgentRuntimeServices,
    NativeAgentToolCall, NativeAgentToolResult, PreparedToolCall,
};
use super::{AgentResultError, AgentStopReason, AgentTurnResult};
use crate::agent::runtime::AgentError;
use crate::agent::runtime_protocol::{
    AgentContinuationInput, AgentEventKind, AgentFormAction, AgentRuntimePhase, PendingAgentEvent,
    TerminalEvent,
};
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
    Finished(AgentTurnResult),
}

pub(super) struct UserInputResume {
    iteration: i64,
    tool_call: NativeAgentToolCall,
    result: NativeAgentToolResult,
    restored_completed_results: Vec<super::CompletedAgentToolResult>,
    form_id: String,
    values: Value,
    pending_hook_context: Vec<String>,
}

impl UserInputResume {
    pub(super) async fn apply(
        self,
        context: &mut AgentTurnContext,
        state: &mut AgentTurnState,
    ) -> Result<i64, AgentError> {
        context.restore_pending_tool_hook_context(self.pending_hook_context);
        state
            .completed_tool_results
            .extend(self.restored_completed_results);
        state.tools_used.push(self.tool_call.name.clone());
        let mut resolution = serde_json::json!({
            "iteration": self.iteration,
            "formId": self.form_id,
            "detailId": format!("form:{}", self.form_id),
            "status": "completed",
            "action": "submit",
            "values": self.values,
        });
        attach_thread_command_id(&mut resolution, context);
        state.emit(PendingAgentEvent::new(
            AgentEventKind::FormResolution,
            resolution,
        ))?;
        let prepared = PreparedToolCall::prepare(self.tool_call)?;
        let mut result = self.result;
        let invocation = AgentHookInvocation::tool(
            AgentHookStage::AfterToolUse,
            context.trace_context.clone(),
            context.session_id.clone(),
            context.model.clone(),
            context.hook_permission_mode(),
            prepared.id.clone(),
            prepared.name.clone(),
            prepared.arguments_value(),
            Some(serde_json::json!({
                "content": result.content,
                "envelope": result.envelope,
            })),
        );
        let evaluation = context.evaluate_command_hook(invocation.clone()).await?;
        context.queue_tool_hook_context(&evaluation);
        state.emit_hook_evaluation(&invocation, &evaluation)?;
        if !evaluation.tool_feedback.is_empty() {
            result.replace_model_content(evaluation.tool_feedback.join("\n"));
        }
        commit_tool_observation(
            context,
            state,
            self.iteration,
            prepared.into_original(),
            result,
        )?;
        state.apply_pending_tool_hook_context(context)?;
        Ok(self.iteration.saturating_add(1))
    }
}

pub(super) fn awaiting_user_input_result(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    tool_call: PreparedToolCall,
) -> Result<AgentTurnResult, AgentError> {
    let form_id = form_id_for_tool_call(&tool_call.id)?;
    let request = parse_user_input_request(tool_call.arguments())?;
    let form = AgentUserInputForm {
        request,
        form_id: form_id.clone(),
        correlation: FormCorrelation {
            form_id: form_id.clone(),
            turn_id: context.turn_id.clone(),
            session_id: context.session_id.clone(),
            tool_call_id: tool_call.id.clone(),
        },
    };

    state.tools_used.push(tool_call.name.clone());
    state.set_pending_tool_call(&tool_call);
    state.transition_phase(
        AgentRuntimePhase::AwaitingForm,
        iteration,
        AgentEventKind::AwaitingForm.wire_name(),
    )?;
    let checkpoint = save_phase_checkpoint(
        services,
        context,
        state.phase.clone(),
        super::checkpoint_types::PhaseCheckpointInput {
            iteration: Some(iteration),
            pending_tool_calls: state.pending_tool_calls.clone(),
            completed_tool_results: state.completed_tool_results.clone(),
            messages: Some(state.history.history()),
            resume_token: Some(format!("form:{form_id}")),
            payload: super::checkpoint_types::AgentCheckpointPayload::UserInput(
                super::checkpoint_types::UserInputCheckpoint {
                    kind: super::checkpoint_types::UserInputCheckpointKind::UserInput,
                    form_id: form_id.clone(),
                    form: form.clone(),
                    pending_hook_context: context.pending_tool_hook_context().to_vec(),
                },
            ),
            ..Default::default()
        },
    );
    state.emit(PendingAgentEvent::new(
        AgentEventKind::Checkpoint,
        serde_json::json!({
            "phase": "awaiting_form",
            "checkpoint": checkpoint.clone(),
        }),
    ))?;
    state.emit(PendingAgentEvent::new(
        AgentEventKind::AwaitingForm,
        serde_json::json!({
            "iteration": iteration,
            "formId": form_id,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "detailId": format!("form:{form_id}"),
            "status": "waiting",
            "summary": form.request.title,
            "form": form,
        }),
    ))?;
    state.set_stop_reason(
        AgentStopReason::AwaitingForm,
        iteration,
        AgentEventKind::Done.wire_name(),
    )?;
    state.emit(TerminalEvent::Done(serde_json::json!({
        "iteration": iteration,
        "stopReason": "awaiting_form",
    })))?;
    let runtime_events = state.runtime_events();
    Ok(AgentTurnResult {
        tools_used: state.tools_used.clone(),
        completed_tool_results: Some(state.completed_tool_results.clone()),
        form: Some(form),
        checkpoint: Some(checkpoint),
        runtime_events: Some(runtime_events),
        ..AgentTurnResult::new(
            &context.turn_id,
            &context.session_id,
            AgentStopReason::AwaitingForm,
        )
    })
}

pub(super) fn prepare_user_input_continuation(
    services: &NativeAgentRuntimeServices,
    context: &mut AgentTurnContext,
) -> Result<Option<UserInputContinuationOutcome>, AgentError> {
    let Some(AgentContinuationInput::Form {
        form_id,
        action,
        values,
    }) = context.continuation.clone()
    else {
        return Ok(None);
    };
    let Some(checkpoint) = services
        .checkpoints
        .restore_for_turn(&context.session_id, &context.turn_id)
    else {
        return Ok(None);
    };
    let payload = checkpoint.user_input(&form_id)?;
    let tool_call = user_input_pending_tool_call(&checkpoint)?;
    let iteration = checkpoint
        .iteration
        .ok_or_else(|| "invalid user input checkpoint: iteration is missing".to_string())?;
    if matches!(action, AgentFormAction::Cancel) {
        services
            .checkpoints
            .clear_for_turn(&context.session_id, &context.turn_id);
        return Ok(Some(UserInputContinuationOutcome::Finished(
            cancelled_user_input_result(services, context, checkpoint, form_id, iteration)?,
        )));
    }

    let values = validate_submitted_values(&payload.form, values)?;
    let mut messages = checkpoint.messages.clone();
    let raw_result = serde_json::json!({
        "formId": form_id,
        "status": "submitted",
        "values": values,
    });
    let result = NativeAgentToolResult::generic_success(&tool_call, raw_result);
    prepare_continuation_tool_observation(&mut messages, &tool_call, false)
        .map_err(|error| format!("invalid user input checkpoint: {error}"))?;
    let restored_completed_results = checkpoint.completed_tool_results.clone();
    let pending_hook_context = payload.pending_hook_context.clone();
    context.messages = messages;
    services
        .checkpoints
        .clear_for_turn(&context.session_id, &context.turn_id);

    Ok(Some(UserInputContinuationOutcome::Resume(
        UserInputResume {
            iteration,
            tool_call,
            result,
            restored_completed_results,
            form_id,
            values,
            pending_hook_context,
        },
    )))
}

fn cancelled_user_input_result(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    checkpoint: super::AgentCheckpoint,
    form_id: String,
    iteration: i64,
) -> Result<AgentTurnResult, AgentError> {
    let message = "User input request was cancelled.";
    let mut state = AgentTurnState::new_for_continuation(context, services.trace_sink.clone())?;
    state.tools_used.push(REQUEST_USER_INPUT_METHOD.to_string());
    state.transition_phase(
        AgentRuntimePhase::AwaitingForm,
        iteration,
        AgentEventKind::FormResolution.wire_name(),
    )?;
    state.emit_thread_command_acknowledgement(context)?;
    let mut resolution = serde_json::json!({
        "iteration": iteration,
        "formId": form_id,
        "detailId": format!("form:{form_id}"),
        "status": "completed",
        "action": "cancel",
    });
    attach_thread_command_id(&mut resolution, context);
    state.emit(PendingAgentEvent::new(
        AgentEventKind::FormResolution,
        resolution,
    ))?;
    state.set_stop_reason(
        AgentStopReason::FormCancelled,
        iteration,
        AgentEventKind::Error.wire_name(),
    )?;
    state.emit(TerminalEvent::Error(serde_json::json!({
        "iteration": iteration,
        "stopReason": "form_cancelled",
        "message": message,
        "error": message,
    })))?;
    let runtime_events = state.runtime_events();
    Ok(AgentTurnResult {
        tools_used: state.tools_used.clone(),
        error: Some(AgentResultError::Message(message.to_string())),
        restored_checkpoint: Some(checkpoint),
        continuation: Some(AgentContinuationInput::Form {
            form_id,
            action: AgentFormAction::Cancel,
            values: None,
        }),
        runtime_events: Some(runtime_events),
        ..AgentTurnResult::new(
            &context.turn_id,
            &context.session_id,
            AgentStopReason::FormCancelled,
        )
    })
}

fn attach_thread_command_id(payload: &mut Value, context: &AgentTurnContext) {
    let Some(command_id) = context
        .metadata
        .pointer("/_threadCommand/commandId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    payload["commandId"] = Value::String(command_id.to_string());
}

fn user_input_pending_tool_call(
    checkpoint: &super::AgentCheckpoint,
) -> Result<NativeAgentToolCall, String> {
    let pending = &checkpoint.pending_tool_calls;
    if pending.len() != 1 {
        return Err(format!(
            "invalid user input checkpoint: expected one pending tool call, found {}",
            pending.len()
        )
        .into());
    }
    let pending = &pending[0];
    let id = pending.tool_call_id.clone();
    let name = pending.tool_name.clone();
    if name != REQUEST_USER_INPUT_METHOD {
        return Err(format!(
            "invalid user input checkpoint: pending tool must be `{REQUEST_USER_INPUT_METHOD}`, found `{name}`"
        ).into());
    }
    Ok(NativeAgentToolCall {
        id,
        name,
        arguments_json: pending.arguments_json.clone(),
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
        ).into());
    }
    Ok(format!("user-input:{tool_call_id}"))
}

#[derive(Clone, Debug, Serialize)]
pub struct AgentUserInputForm {
    #[serde(flatten)]
    pub request: UserInputRequest,
    pub form_id: String,
    pub correlation: FormCorrelation,
}

impl<'de> Deserialize<'de> for AgentUserInputForm {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let mut value = Value::deserialize(deserializer)?;
        let object = value
            .as_object_mut()
            .ok_or_else(|| D::Error::custom("form must be an object"))?;
        let form_id = serde_json::from_value(
            object
                .remove("form_id")
                .ok_or_else(|| D::Error::missing_field("form_id"))?,
        )
        .map_err(D::Error::custom)?;
        let correlation = serde_json::from_value(
            object
                .remove("correlation")
                .ok_or_else(|| D::Error::missing_field("correlation"))?,
        )
        .map_err(D::Error::custom)?;
        let request = serde_json::from_value(value).map_err(D::Error::custom)?;
        Ok(Self {
            request,
            form_id,
            correlation,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FormCorrelation {
    pub form_id: String,
    pub turn_id: String,
    pub session_id: String,
    pub tool_call_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UserInputRequest {
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

fn parse_user_input_request(arguments: &Map<String, Value>) -> Result<UserInputRequest, String> {
    let mut request = serde_json::from_value::<UserInputRequest>(Value::Object(arguments.clone()))
        .map_err(|error| format!("invalid request_user_input arguments: {error}"))?;
    normalize_required_string(&mut request.title, "title", 256)?;
    normalize_optional_string(&mut request.description, "description", 1_024)?;
    normalize_optional_string(&mut request.submit_label, "submit_label", 128)?;
    normalize_optional_string(&mut request.cancel_label, "cancel_label", 128)?;
    if request.fields.is_empty() || request.fields.len() > MAX_FORM_FIELDS {
        return Err(format!(
            "invalid request_user_input arguments: fields must contain between 1 and {MAX_FORM_FIELDS} entries"
        ).into());
    }
    let mut names = HashSet::new();
    for (index, field) in request.fields.iter_mut().enumerate() {
        normalize_field(field, index)?;
        if !names.insert(field.name.clone()) {
            return Err(format!(
                "invalid request_user_input arguments: duplicate field name `{}`",
                field.name
            )
            .into());
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
        )
        .into());
    }
    normalize_required_string(&mut field.field_type, &format!("fields[{index}].type"), 64)?;
    if !matches!(
        field.field_type.as_str(),
        "text" | "textarea" | "number" | "select" | "multiselect" | "radio" | "checkbox"
    ) {
        return Err(format!(
            "invalid request_user_input arguments: fields[{index}].type is unsupported"
        )
        .into());
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
                    ).into());
                }
            }
        }
        (Some(_), true) | (None, true) => {
            return Err(format!(
                "invalid request_user_input arguments: fields[{index}].options must contain between 1 and {MAX_FORM_OPTIONS} entries"
            ).into());
        }
        (Some(_), false) => {
            return Err(format!(
                "invalid request_user_input arguments: fields[{index}].options is only valid for choice fields"
            ).into());
        }
        (None, false) => {}
    }
    Ok(())
}

fn validate_submitted_values(
    form: &AgentUserInputForm,
    values: Option<Value>,
) -> Result<Value, String> {
    let values = match values.unwrap_or_else(|| Value::Object(Map::new())) {
        Value::Object(values) => values,
        _ => {
            return Err("invalid user input submission: values must be an object"
                .to_string()
                .into())
        }
    };
    let fields = &form.request.fields;
    let allowed_names = fields
        .iter()
        .map(|field| field.name.as_str())
        .collect::<HashSet<_>>();
    if let Some(unknown) = values
        .keys()
        .find(|name| !allowed_names.contains(name.as_str()))
    {
        return Err(format!("invalid user input submission: unknown field `{unknown}`").into());
    }
    for field in fields {
        validate_submitted_field(field, values.get(&field.name))?;
    }
    Ok(Value::Object(values))
}

fn validate_submitted_field(field: &UserInputField, value: Option<&Value>) -> Result<(), String> {
    let name = &field.name;
    let field_type = &field.field_type;
    let required = field.required;
    let missing = value.is_none_or(|value| {
        value.is_null()
            || value.as_str().is_some_and(str::is_empty)
            || value.as_array().is_some_and(Vec::is_empty)
    });
    if missing {
        return if required {
            Err(format!("invalid user input submission: field `{name}` is required").into())
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
                ).into());
            }
        }
        "number" if !value.is_number() => {
            return Err(
                format!("invalid user input submission: field `{name}` must be a number").into(),
            );
        }
        "checkbox" if !value.is_boolean() => {
            return Err(
                format!("invalid user input submission: field `{name}` must be a boolean").into(),
            );
        }
        "select" | "radio" => {
            let selected = value.as_str().ok_or_else(|| {
                format!("invalid user input submission: field `{name}` must be a string")
            })?;
            if !choice_values(field).contains(selected) {
                return Err(format!(
                    "invalid user input submission: field `{name}` contains an unsupported option"
                )
                .into());
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
                )
                .into());
            }
        }
        _ => {}
    }
    Ok(())
}

fn choice_values(field: &UserInputField) -> HashSet<&str> {
    field
        .options
        .iter()
        .flatten()
        .map(|option| option.value.as_str())
        .collect()
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
        ).into());
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
        )
        .into());
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
