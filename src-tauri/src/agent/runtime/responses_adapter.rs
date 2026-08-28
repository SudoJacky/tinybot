use super::items::{AgentContentPart, AgentUsageItem};
use super::provider_adapter::{
    apply_provider_request_adaptation, attach_provider_tools,
    provider_message_with_user_context_and_images, require_model_image_input,
    require_provider_capability, DecodedProviderTurn,
};
use super::tool_router::{provider_tool_name, AgentToolDefinition};
use super::{
    AgentAssistantMessage, AgentInstructionMessage, AgentInstructionRole, AgentItem,
    AgentItemHistory, AgentMessageContent, AgentReasoningItem, AgentToolCallItem,
    AgentToolResultItem, AgentTurnSettings,
};
use serde_json::{Map, Value};
use std::collections::HashSet;

pub(super) struct ResponsesAdapter;

impl ResponsesAdapter {
    pub fn build_request(
        legacy_messages: &[Value],
        system_prompt: Option<&str>,
        response_items: Option<&[Value]>,
        tools: &[AgentToolDefinition],
        settings: &AgentTurnSettings,
        config_snapshot: &Value,
        enable_parallel_tool_calls: bool,
    ) -> Result<Value, String> {
        require_model_image_input(
            settings,
            config_snapshot,
            legacy_messages
                .iter()
                .chain(response_items.unwrap_or_default().iter()),
        )?;
        let mut request = serde_json::json!({
            "model": settings.model.clone(),
            "input": Self::encode_history_with_response_items(
                legacy_messages,
                system_prompt,
                response_items,
            )?,
            "stream": settings.stream,
            "store": false,
        });
        Self::apply_turn_settings(&mut request, settings, config_snapshot)?;
        attach_provider_tools(
            &mut request,
            Self::encode_tools(tools),
            enable_parallel_tool_calls,
        );
        apply_provider_request_adaptation(
            settings,
            config_snapshot,
            crate::agent::provider::NativeProviderApiMode::Responses,
            &mut request,
        )?;
        Ok(request)
    }

    #[cfg(test)]
    pub fn encode_history(
        legacy_messages: &[Value],
        system_prompt: Option<&str>,
    ) -> Result<Value, String> {
        Self::encode_history_with_response_items(legacy_messages, system_prompt, None)
    }

    pub fn encode_history_with_response_items(
        legacy_messages: &[Value],
        system_prompt: Option<&str>,
        response_items: Option<&[Value]>,
    ) -> Result<Value, String> {
        if let Some(response_items) = response_items {
            return encode_native_response_history(legacy_messages, system_prompt, response_items);
        }
        let provider_messages = legacy_messages
            .iter()
            .map(provider_message_with_user_context_and_images)
            .collect::<Result<Vec<_>, _>>()?;
        let mut history = AgentItemHistory::from_legacy_messages(&provider_messages)?;
        if let Some(system_prompt) = system_prompt {
            history.items.insert(
                0,
                AgentItem::Instruction(AgentInstructionMessage {
                    id: None,
                    role: AgentInstructionRole::System,
                    content: AgentMessageContent::text(system_prompt),
                }),
            );
        }

        let mut input = Vec::new();
        for item in &history.items {
            input.extend(encode_input_item(item)?);
        }
        Ok(Value::Array(input))
    }

    pub fn encode_tools(tools: &[AgentToolDefinition]) -> Vec<Value> {
        tools
            .iter()
            .map(|tool| {
                serde_json::json!({
                    "type": "function",
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                    "strict": false,
                })
            })
            .collect()
    }

    pub fn encode_tool_outputs(results: &[Value]) -> Result<Vec<Value>, String> {
        results
            .iter()
            .map(|result| {
                let call_id = result
                    .get("toolCallId")
                    .or_else(|| result.get("tool_call_id"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| "completed tool result is missing toolCallId".to_string())?;
                let output = result
                    .get("envelope")
                    .and_then(|envelope| envelope.get("modelContent"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        format!("completed tool result `{call_id}` is missing modelContent")
                    })?;
                Ok(serde_json::json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output,
                }))
            })
            .collect()
    }

    pub fn apply_turn_settings(
        request: &mut Value,
        settings: &AgentTurnSettings,
        config_snapshot: &Value,
    ) -> Result<(), String> {
        settings.validate()?;
        if let Some(temperature) = settings.temperature {
            request["temperature"] = serde_json::json!(temperature);
        }
        if let Some(max_output_tokens) = settings.max_completion_tokens {
            request["max_output_tokens"] = serde_json::json!(max_output_tokens);
        }
        if let Some(service_tier) = settings.service_tier.as_deref() {
            require_provider_capability(settings, config_snapshot, "service_tier")?;
            request["service_tier"] = Value::String(service_tier.to_string());
        }
        if let Some(reasoning) = settings.reasoning.as_ref() {
            let mut response_reasoning = Map::new();
            if let Some(effort) = reasoning.effort.as_deref() {
                response_reasoning.insert("effort".to_string(), Value::String(effort.to_string()));
            }
            if let Some(summary) = reasoning.summary.as_deref() {
                require_provider_capability(settings, config_snapshot, "reasoning")?;
                response_reasoning
                    .insert("summary".to_string(), Value::String(summary.to_string()));
            }
            if !response_reasoning.is_empty() {
                request["reasoning"] = Value::Object(response_reasoning);
            }
        }
        if let Some(output_schema) = settings.output_schema.as_ref() {
            require_provider_capability(settings, config_snapshot, "structured_output")?;
            request["text"] = serde_json::json!({
                "format": {
                    "type": "json_schema",
                    "name": output_schema.name,
                    "strict": output_schema.strict,
                    "schema": output_schema.schema,
                }
            });
        }
        Ok(())
    }

    pub fn decode_response(
        response: &Value,
        resolve_tool_name: impl Fn(&str) -> Result<String, String>,
    ) -> Result<DecodedProviderTurn, String> {
        let output = response
            .get("output")
            .and_then(Value::as_array)
            .ok_or_else(|| "Responses API response is missing output".to_string())?;
        let mut assistant_id = None;
        let mut assistant_text = String::new();
        let mut tool_calls = Vec::new();
        let mut reasoning_id = None;
        let mut reasoning_summary = String::new();

        for (index, item) in output.iter().enumerate() {
            match item.get("type").and_then(Value::as_str) {
                Some("message") => {
                    assistant_id = assistant_id.or_else(|| string_value(item, "id"));
                    assistant_text.push_str(&decode_message_text(item, index)?);
                }
                Some("function_call") => {
                    let call_id = required_string(item, "call_id", "function call", index)?;
                    let provider_name = required_string(item, "name", "function call", index)?;
                    let arguments = required_string(item, "arguments", "function call", index)?;
                    tool_calls.push(AgentToolCallItem {
                        id: call_id,
                        name: resolve_tool_name(&provider_name)?,
                        arguments_json: arguments,
                    });
                }
                Some("reasoning") => {
                    reasoning_id = reasoning_id.or_else(|| string_value(item, "id"));
                    reasoning_summary.push_str(&decode_reasoning_summary(item, index)?);
                }
                Some(unsupported) => {
                    return Err(format!(
                        "unsupported Responses API output item `{unsupported}` at index {index}"
                    ));
                }
                None => {
                    return Err(format!(
                        "Responses API output item at index {index} requires type"
                    ));
                }
            }
        }

        let reasoning = (!reasoning_summary.is_empty()).then(|| AgentReasoningItem {
            id: reasoning_id,
            summary: reasoning_summary,
        });
        let usage = response
            .get("usage")
            .filter(|value| !value.is_null())
            .map(responses_usage)
            .transpose()?;
        Ok(DecodedProviderTurn {
            assistant: AgentAssistantMessage {
                id: assistant_id,
                content: (!assistant_text.is_empty())
                    .then(|| AgentMessageContent::text(assistant_text)),
                reasoning: reasoning
                    .as_ref()
                    .map(|reasoning| reasoning.summary.clone()),
                tool_calls,
                context_compaction: false,
            },
            reasoning,
            usage,
        })
    }

    pub fn message_phase(response: &Value) -> Option<&str> {
        response
            .get("output")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find_map(|item| {
                item.get("phase")
                    .or_else(|| item.get("message_phase"))
                    .or_else(|| item.get("messagePhase"))
                    .and_then(Value::as_str)
            })
    }
}

fn encode_native_response_history(
    _legacy_messages: &[Value],
    system_prompt: Option<&str>,
    response_items: &[Value],
) -> Result<Value, String> {
    let mut input = Vec::new();
    if let Some(system_prompt) = system_prompt {
        input.push(serde_json::json!({
            "role": "system",
            "content": system_prompt,
        }));
    }
    let response_items = project_superseded_web_response_targets(response_items);
    for (index, item) in response_items.iter().enumerate() {
        input.push(sanitize_replayed_item(item, index)?);
    }

    Ok(Value::Array(input))
}

fn project_superseded_web_response_targets(response_items: &[Value]) -> Vec<Value> {
    let mut response_items = response_items.to_vec();
    let web_call_ids = response_items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        .filter(|item| {
            matches!(
                item.get("name").and_then(Value::as_str),
                Some("web.open" | "web.read" | "web.act" | "web_open" | "web_read" | "web_act")
            )
        })
        .filter_map(|item| {
            item.get("call_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect::<HashSet<_>>();
    let mut retained_targets = false;
    for item in response_items.iter_mut().rev() {
        if item.get("type").and_then(Value::as_str) != Some("function_call_output")
            || !item
                .get("call_id")
                .and_then(Value::as_str)
                .is_some_and(|call_id| web_call_ids.contains(call_id))
        {
            continue;
        }
        let Some(output) = item.get_mut("output") else {
            continue;
        };
        let Some(mut content) = output.as_str().map(str::to_string) else {
            continue;
        };
        if crate::tools::web::project_web_result_history(&mut content, !retained_targets) {
            retained_targets = true;
            *output = Value::String(content);
        }
    }
    response_items
}

fn sanitize_replayed_item(item: &Value, index: usize) -> Result<Value, String> {
    let normalized = match item.get("role").and_then(Value::as_str) {
        Some("user") => {
            let provider_message = provider_message_with_user_context_and_images(item)?;
            encode_replayed_input_message(&provider_message, index)?
        }
        Some("system" | "developer") => encode_replayed_input_message(item, index)?,
        _ => item.clone(),
    };
    let mut item = normalized
        .as_object()
        .cloned()
        .ok_or_else(|| format!("Responses replay item at index {index} must be an object"))?;
    if item.get("type").and_then(Value::as_str).is_none()
        && item.get("role").and_then(Value::as_str).is_none()
    {
        return Err(format!(
            "Responses replay item at index {index} requires type or role"
        ));
    }
    for field in [
        "turnId",
        "turn_id",
        "messageId",
        "message_id",
        "modelCallId",
        "reasoningId",
        "contentHash",
        "tool_name",
    ] {
        item.remove(field);
    }
    if matches!(
        item.get("role").and_then(Value::as_str),
        Some("user" | "system" | "developer")
    ) {
        item.remove("id");
        item.remove("status");
        item.remove("phase");
    }
    if item.get("type").and_then(Value::as_str) == Some("function_call_output") {
        item.remove("status");
        item.remove("tinybot_result");
    }
    Ok(Value::Object(item))
}

fn encode_replayed_input_message(item: &Value, index: usize) -> Result<Value, String> {
    let item = AgentItem::from_legacy_message(item)
        .map_err(|error| format!("invalid Responses replay item at index {index}: {error}"))?;
    let mut encoded = encode_input_item(&item)?;
    if encoded.len() != 1 {
        return Err(format!(
            "Responses replay item at index {index} encoded to an unexpected item count"
        ));
    }
    Ok(encoded.remove(0))
}

fn encode_input_item(item: &AgentItem) -> Result<Vec<Value>, String> {
    match item {
        AgentItem::Instruction(message) => Ok(vec![serde_json::json!({
            "role": match message.role {
                AgentInstructionRole::System => "system",
                AgentInstructionRole::Developer => "developer",
            },
            "content": input_message_content(&message.content)?,
        })]),
        AgentItem::UserMessage(message) => Ok(vec![serde_json::json!({
            "role": "user",
            "content": input_message_content(&message.content)?,
        })]),
        AgentItem::AssistantMessage(message) => encode_assistant_input(message),
        AgentItem::ToolResult(result) => Ok(vec![encode_tool_result(result)?]),
        other => Err(format!(
            "agent item `{}` cannot be encoded as a Responses API input item",
            other.kind()
        )),
    }
}

fn encode_assistant_input(message: &AgentAssistantMessage) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    if let Some(content) = message.content.as_ref() {
        items.push(serde_json::json!({
            "role": "assistant",
            "content": input_message_content(content)?,
        }));
    }
    items.extend(message.tool_calls.iter().map(|tool_call| {
        serde_json::json!({
            "type": "function_call",
            "call_id": tool_call.id,
            "name": provider_tool_name(&tool_call.name),
            "arguments": tool_call.arguments_json,
        })
    }));
    Ok(items)
}

fn encode_tool_result(result: &AgentToolResultItem) -> Result<Value, String> {
    let AgentMessageContent::Text(output) = &result.content else {
        return Err("Responses API tool results currently require text content".to_string());
    };
    Ok(serde_json::json!({
        "type": "function_call_output",
        "call_id": result.tool_call_id,
        "output": output,
    }))
}

fn input_message_content(content: &AgentMessageContent) -> Result<Value, String> {
    match content {
        AgentMessageContent::Text(text) => Ok(Value::String(text.clone())),
        AgentMessageContent::Parts(parts) => parts
            .iter()
            .map(|part| match part {
                AgentContentPart::Text { text } => {
                    Ok(serde_json::json!({ "type": "input_text", "text": text }))
                }
                AgentContentPart::Image { url, detail } => {
                    let mut image = serde_json::json!({
                        "type": "input_image",
                        "image_url": url,
                    });
                    if let Some(detail) = detail {
                        image["detail"] = Value::String(detail.clone());
                    }
                    Ok(image)
                }
                AgentContentPart::File { identifier, .. } => {
                    let mut file = serde_json::json!({ "type": "input_file" });
                    if identifier.starts_with("file-") {
                        file["file_id"] = Value::String(identifier.clone());
                    } else if identifier.starts_with("http://")
                        || identifier.starts_with("https://")
                        || identifier.starts_with("data:")
                    {
                        file["file_url"] = Value::String(identifier.clone());
                    } else {
                        return Err(
                            "Responses API file input requires a file ID, URL, or data URL"
                                .to_string(),
                        );
                    }
                    Ok(file)
                }
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
    }
}

fn decode_message_text(item: &Value, item_index: usize) -> Result<String, String> {
    let content = item
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            format!("Responses API message at index {item_index} requires content array")
        })?;
    let mut text = String::new();
    for (content_index, part) in content.iter().enumerate() {
        match part.get("type").and_then(Value::as_str) {
            Some("output_text") => text.push_str(&required_string(
                part,
                "text",
                "output_text content",
                content_index,
            )?),
            Some("refusal") => text.push_str(&required_string(
                part,
                "refusal",
                "refusal content",
                content_index,
            )?),
            Some(unsupported) => {
                return Err(format!(
                    "unsupported Responses API message content `{unsupported}` at index {content_index}"
                ));
            }
            None => {
                return Err(format!(
                    "Responses API message content at index {content_index} requires type"
                ));
            }
        }
    }
    Ok(text)
}

fn decode_reasoning_summary(item: &Value, item_index: usize) -> Result<String, String> {
    let summary = item
        .get("summary")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            format!("Responses API reasoning item at index {item_index} requires summary array")
        })?;
    let mut text = String::new();
    for (summary_index, part) in summary.iter().enumerate() {
        if part.get("type").and_then(Value::as_str) != Some("summary_text") {
            return Err(format!(
                "Responses API reasoning summary at index {summary_index} must have type `summary_text`"
            ));
        }
        text.push_str(&required_string(
            part,
            "text",
            "reasoning summary",
            summary_index,
        )?);
    }
    Ok(text)
}

fn responses_usage(value: &Value) -> Result<AgentUsageItem, String> {
    let usage = value
        .as_object()
        .ok_or_else(|| "Responses API usage must be an object".to_string())?;
    Ok(AgentUsageItem {
        id: None,
        input_tokens: usage_number(usage, "input_tokens")?,
        output_tokens: usage_number(usage, "output_tokens")?,
        total_tokens: usage_number(usage, "total_tokens")?,
        context_window_remaining_tokens: None,
        context_window_strategy: None,
        context_window_tokens: None,
        context_window_used_tokens: None,
        estimated_context_tokens: None,
        percent: None,
        provider_payload: value.clone(),
    })
}

fn usage_number(usage: &Map<String, Value>, key: &str) -> Result<Option<i64>, String> {
    usage
        .get(key)
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_i64()
                .ok_or_else(|| format!("Responses API usage `{key}` must be an integer"))
        })
        .transpose()
}

fn required_string(value: &Value, key: &str, kind: &str, index: usize) -> Result<String, String> {
    string_value(value, key)
        .ok_or_else(|| format!("Responses API {kind} at index {index} requires {key}"))
}

fn string_value(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encodes_tool_loop_as_responses_items() {
        let input = ResponsesAdapter::encode_history(
            &[
                json!({ "role": "user", "content": "hello" }),
                json!({
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call-1",
                        "type": "function",
                        "function": { "name": "web.open", "arguments": "{\"url\":\"https://example.com\"}" }
                    }]
                }),
                json!({
                    "role": "tool",
                    "tool_call_id": "call-1",
                    "content": "opened"
                }),
            ],
            Some("be helpful"),
        )
        .expect("history should encode");

        assert_eq!(
            input[0],
            json!({ "role": "system", "content": "be helpful" })
        );
        assert_eq!(input[1], json!({ "role": "user", "content": "hello" }));
        assert_eq!(input[2]["type"], "function_call");
        assert_eq!(input[2]["call_id"], "call-1");
        assert_eq!(input[2]["name"], "web_open");
        assert_eq!(input[3]["type"], "function_call_output");
        assert_eq!(input[3]["call_id"], "call-1");
    }

    #[test]
    fn encodes_previous_assistant_text_as_an_easy_input_message() {
        let input = ResponsesAdapter::encode_history(
            &[
                json!({ "role": "user", "content": "hello" }),
                json!({ "role": "assistant", "content": "hi" }),
            ],
            None,
        )
        .expect("assistant history should encode");

        assert_eq!(input[1], json!({ "role": "assistant", "content": "hi" }));
        assert!(input[1].get("type").is_none());
    }

    #[test]
    fn encodes_image_content_as_a_responses_input_image() {
        let content = AgentMessageContent::Parts(vec![
            AgentContentPart::Text {
                text: "Describe this image".to_string(),
            },
            AgentContentPart::Image {
                url: "data:image/png;base64,iVBORw0KGgo=".to_string(),
                detail: Some("auto".to_string()),
            },
        ]);

        assert_eq!(
            input_message_content(&content).expect("image content should encode"),
            json!([
                { "type": "input_text", "text": "Describe this image" },
                {
                    "type": "input_image",
                    "image_url": "data:image/png;base64,iVBORw0KGgo=",
                    "detail": "auto"
                }
            ])
        );
    }

    #[test]
    fn encodes_canonical_function_tools_with_responses_shape() {
        let tools = ResponsesAdapter::encode_tools(&[AgentToolDefinition {
            name: "web_open".to_string(),
            description: "Open a page".to_string(),
            input_schema: json!({ "type": "object" }),
        }]);

        assert_eq!(tools[0]["type"], "function");
        assert_eq!(tools[0]["name"], "web_open");
        assert_eq!(tools[0]["strict"], false);
        assert!(tools[0].get("function").is_none());
    }

    #[test]
    fn encodes_runtime_tool_results_as_responses_function_outputs() {
        let outputs = ResponsesAdapter::encode_tool_outputs(&[json!({
            "toolCallId": "call-1",
            "envelope": { "modelContent": "contents" }
        })])
        .expect("tool result should encode");

        assert_eq!(
            outputs,
            vec![json!({
                "type": "function_call_output",
                "call_id": "call-1",
                "output": "contents"
            })]
        );
    }

    #[test]
    fn replay_removes_tinybot_tool_result_sidecar_before_provider_request() {
        let replayed = sanitize_replayed_item(
            &json!({
                "type": "function_call_output",
                "call_id": "call-1",
                "output": "Applied patch",
                "tinybot_result": { "files_changed": 1 }
            }),
            0,
        )
        .expect("replayed tool output should sanitize");

        assert_eq!(
            replayed,
            json!({
                "type": "function_call_output",
                "call_id": "call-1",
                "output": "Applied patch"
            })
        );
    }

    #[test]
    fn native_replay_only_keeps_targets_from_the_latest_web_snapshot() {
        let output = |target_ref: &str, text: &str| {
            json!({
                "status": "completed",
                "snapshot": {
                    "targets": [{ "targetRef": target_ref }],
                    "targetsTruncated": false,
                    "content": { "trust": "untrusted", "text": text }
                }
            })
            .to_string()
        };
        let input = ResponsesAdapter::encode_history_with_response_items(
            &[],
            None,
            Some(&[
                json!({ "type": "function_call", "call_id": "call-old", "name": "web_read", "arguments": "{}" }),
                json!({ "type": "function_call_output", "call_id": "call-old", "output": output("target-old", "Older page text") }),
                json!({ "type": "function_call", "call_id": "call-latest", "name": "web_act", "arguments": "{}" }),
                json!({ "type": "function_call_output", "call_id": "call-latest", "output": output("target-latest", "Latest page text") }),
            ]),
        )
        .unwrap();
        let old_result: Value = serde_json::from_str(input[1]["output"].as_str().unwrap()).unwrap();
        let latest_result: Value =
            serde_json::from_str(input[3]["output"].as_str().unwrap()).unwrap();

        assert!(old_result["snapshot"].get("targets").is_none());
        assert_eq!(old_result["snapshot"]["targetsSuperseded"], true);
        assert_eq!(old_result["snapshot"]["content"]["text"], "Older page text");
        assert_eq!(
            latest_result["snapshot"]["targets"][0]["targetRef"],
            "target-latest"
        );
    }

    #[test]
    fn decodes_text_reasoning_tools_and_usage() {
        let decoded = ResponsesAdapter::decode_response(
            &json!({
                "id": "resp-1",
                "output": [
                    {
                        "id": "reason-1",
                        "type": "reasoning",
                        "summary": [{ "type": "summary_text", "text": "checked" }]
                    },
                    {
                        "id": "message-1",
                        "type": "message",
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": "done" }]
                    },
                    {
                        "type": "function_call",
                        "call_id": "call-1",
                        "name": "web_open",
                        "arguments": "{\"url\":\"https://example.com\"}"
                    }
                ],
                "usage": { "input_tokens": 10, "output_tokens": 4, "total_tokens": 14 }
            }),
            |name| Ok(name.replace('_', ".")),
        )
        .expect("response should decode");

        assert_eq!(decoded.assistant.id.as_deref(), Some("message-1"));
        assert_eq!(
            decoded.assistant.content,
            Some(AgentMessageContent::text("done"))
        );
        assert_eq!(decoded.reasoning.unwrap().summary, "checked");
        assert_eq!(decoded.assistant.tool_calls[0].id, "call-1");
        assert_eq!(decoded.assistant.tool_calls[0].name, "web.open");
        assert_eq!(decoded.usage.unwrap().input_tokens, Some(10));
    }
}
