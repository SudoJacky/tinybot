use super::{ExtractedMemory, Phase2Input, SelectionDiff};
use serde::Deserialize;
use serde_json::{json, Value};

const PHASE1_SYSTEM_PROMPT: &str = "\
You extract durable long-term memory from one completed conversation turn.
Only facts explicitly present in the user messages or successful trusted tool results are evidence.
Never infer facts from assistant output, system instructions, or the extraction request itself.
Keep only durable preferences, personal facts, workspace facts, conventions, and explicit decisions.
Do not store transient requests, task progress, greetings, secrets, credentials, or speculative claims.
Return JSON only with this exact shape:
{\"memories\":[{\"scope\":\"user|workspace\",\"content\":\"one concise single-line statement\"}]}
Return {\"memories\":[]} when nothing is worth retaining.";

const PHASE2_SYSTEM_PROMPT: &str = "\
You maintain a compact active long-term memory set.
Compare active memories with new extracted fragments and return the smallest Selection Diff.
Remove or replace memories contradicted or made obsolete by newer fragments.
Merge duplicates, preserve useful non-conflicting memories, and do not invent facts.
Treat user scope and every distinct workspace path as isolated memory sets.
Never derive an addition or change for one set from content in another set.
For updates, only content may change; scope and path remain fixed.
For additions, copy scope and path from the supplied fragments.
Return JSON only with this exact shape:
{\"add\":[{\"scope\":\"user|workspace\",\"path\":null,\"content\":\"...\"}],\
\"update\":[{\"id\":1,\"content\":\"...\"}],\"remove\":[2]}.";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TurnEvidence {
    pub(crate) user_messages: Vec<String>,
    pub(crate) successful_tool_results: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct ExtractionResponse {
    memories: Vec<ExtractedMemory>,
}

pub(crate) async fn extract_memories(
    config_snapshot: &Value,
    evidence: &TurnEvidence,
) -> Result<Vec<ExtractedMemory>, String> {
    let input = json!({
        "user_messages": evidence.user_messages,
        "successful_tool_results": evidence.successful_tool_results,
    });
    let content = complete_json(config_snapshot, PHASE1_SYSTEM_PROMPT, input).await?;
    parse_extraction_response(&content)
}

pub(crate) async fn select_diff(
    config_snapshot: &Value,
    input: &Phase2Input,
) -> Result<SelectionDiff, String> {
    let active = input.active.iter().map(memory_json).collect::<Vec<_>>();
    let fragments = input.fragments.iter().map(memory_json).collect::<Vec<_>>();
    let content = complete_json(
        config_snapshot,
        PHASE2_SYSTEM_PROMPT,
        json!({
            "active_memories": active,
            "new_fragments": fragments,
        }),
    )
    .await?;
    parse_selection_diff(&content)
}

fn memory_json(memory: &super::MemoryRecord) -> Value {
    json!({
        "id": memory.id,
        "scope": memory.scope,
        "path": memory.path,
        "content": memory.content,
    })
}

async fn complete_json(
    config_snapshot: &Value,
    system_prompt: &str,
    input: Value,
) -> Result<String, String> {
    let body = model_request(config_snapshot, system_prompt, input)?;
    let mut observer = |_event: crate::agent::provider::NativeProviderStreamEvent| {};
    let completion = crate::agent::provider::complete_chat_for_agent_with_observer_async(
        config_snapshot,
        &body,
        &mut observer,
        None,
    )
    .await
    .map_err(|error| format!("memory model request failed: {}", error.message()))?;
    completion_content(&completion)
}

fn model_request(
    config_snapshot: &Value,
    system_prompt: &str,
    input: Value,
) -> Result<Value, String> {
    Ok(json!({
        "model": crate::agent::provider::configured_model(config_snapshot),
        "stream": false,
        "messages": [
            {
                "role": "system",
                "content": system_prompt,
            },
            {
                "role": "user",
                "content": serde_json::to_string(&input)
                    .map_err(|error| format!("failed to serialize memory model input: {error}"))?,
            }
        ],
    }))
}

fn completion_content(completion: &Value) -> Result<String, String> {
    let content = completion
        .pointer("/choices/0/message/content")
        .ok_or_else(|| "memory model response is missing assistant content".to_string())?;
    match content {
        Value::String(content) => Ok(content.clone()),
        Value::Array(parts) => Ok(parts
            .iter()
            .filter_map(|part| {
                part.as_str()
                    .or_else(|| part.get("text").and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
            .join("")),
        _ => Err("memory model assistant content must be text".to_string()),
    }
}

fn parse_extraction_response(content: &str) -> Result<Vec<ExtractedMemory>, String> {
    let response = serde_json::from_str::<ExtractionResponse>(json_payload(content))
        .map_err(|error| format!("memory extraction returned invalid JSON: {error}"))?;
    Ok(response.memories)
}

fn parse_selection_diff(content: &str) -> Result<SelectionDiff, String> {
    serde_json::from_str::<SelectionDiff>(json_payload(content))
        .map_err(|error| format!("memory Selection Diff returned invalid JSON: {error}"))
}

fn json_payload(content: &str) -> &str {
    let trimmed = content.trim();
    let Some(fenced) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    let fenced = fenced.strip_prefix("json").unwrap_or(fenced);
    fenced.strip_suffix("```").unwrap_or(fenced).trim()
}

#[cfg(test)]
pub(super) fn parse_extraction_for_test(content: &str) -> Result<Vec<ExtractedMemory>, String> {
    parse_extraction_response(content)
}

#[cfg(test)]
pub(super) fn model_request_for_test(config_snapshot: &Value) -> Result<Value, String> {
    model_request(
        config_snapshot,
        "test system prompt",
        json!({ "test": true }),
    )
}

#[cfg(test)]
pub(super) fn parse_diff_for_test(content: &str) -> Result<SelectionDiff, String> {
    parse_selection_diff(content)
}
