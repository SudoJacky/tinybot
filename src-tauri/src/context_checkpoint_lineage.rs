use serde_json::{json, Value};
use std::fmt;

const WINDOW_NUMBER: &str = "windowNumber";
const FIRST_WINDOW_ID: &str = "firstWindowId";
const PREVIOUS_WINDOW_ID: &str = "previousWindowId";
const WINDOW_ID: &str = "windowId";
const SOURCE_CONTEXT_ID: &str = "sourceContextId";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ContextWindowLineage {
    pub(crate) source_context_id: Option<String>,
    pub(crate) window_number: u64,
    pub(crate) first_window_id: String,
    pub(crate) previous_window_id: String,
    pub(crate) window_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ContextCheckpointLineageError {
    pub(crate) field: &'static str,
    pub(crate) expected: Value,
    pub(crate) actual: Value,
}

impl fmt::Display for ContextCheckpointLineageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "stale context compaction checkpoint has invalid {}: expected {}, actual {}",
            self.field, self.expected, self.actual
        )
    }
}

pub(crate) fn next_context_window(
    session_id: &str,
    context_id: &str,
    parent_checkpoint: Option<&Value>,
) -> ContextWindowLineage {
    let initial_window_id = initial_context_window_id(session_id);
    let source_context_id =
        parent_checkpoint.and_then(|checkpoint| string_field(checkpoint, "contextId"));
    let parent_window_number = parent_checkpoint
        .and_then(|checkpoint| u64_field(checkpoint, WINDOW_NUMBER, "window_number"))
        .unwrap_or(0);
    let parent_window_id = parent_checkpoint
        .and_then(|checkpoint| string_field(checkpoint, WINDOW_ID))
        .or_else(|| source_context_id.clone())
        .unwrap_or_else(|| initial_window_id.clone());
    let first_window_id = parent_checkpoint
        .and_then(|checkpoint| string_field(checkpoint, FIRST_WINDOW_ID))
        .unwrap_or_else(|| {
            if source_context_id.is_some() {
                parent_window_id.clone()
            } else {
                initial_window_id
            }
        });

    ContextWindowLineage {
        source_context_id,
        window_number: parent_window_number.saturating_add(1),
        first_window_id,
        previous_window_id: parent_window_id,
        window_id: context_id.to_string(),
    }
}

pub(crate) fn checkpoint_lineage_metadata(checkpoint: &Value) -> Option<Value> {
    let context_id = string_field(checkpoint, "contextId")?;
    let mut metadata = json!({ "contextId": context_id });
    for (camel, snake) in [
        (WINDOW_NUMBER, "window_number"),
        (FIRST_WINDOW_ID, "first_window_id"),
        (PREVIOUS_WINDOW_ID, "previous_window_id"),
        (WINDOW_ID, "window_id"),
    ] {
        if let Some(value) = checkpoint.get(camel).or_else(|| checkpoint.get(snake)) {
            metadata[camel] = value.clone();
        }
    }
    Some(metadata)
}

pub(crate) fn validate_context_checkpoint_successor(
    session_id: &str,
    current_checkpoint: Option<&Value>,
    candidate: &Value,
) -> Result<(), ContextCheckpointLineageError> {
    if candidate.get(SOURCE_CONTEXT_ID).is_none() && candidate.get("source_context_id").is_none() {
        let expected_source_context_id =
            current_checkpoint.and_then(|checkpoint| string_field(checkpoint, "contextId"));
        if expected_source_context_id.is_none() {
            return Ok(());
        }
        return Err(ContextCheckpointLineageError {
            field: SOURCE_CONTEXT_ID,
            expected: expected_source_context_id.map_or(Value::Null, |value| json!(value)),
            actual: Value::Null,
        });
    }
    let context_id = string_field(candidate, "contextId").unwrap_or_default();
    let expected = next_context_window(session_id, &context_id, current_checkpoint);
    let actual_source_value = candidate
        .get(SOURCE_CONTEXT_ID)
        .or_else(|| candidate.get("source_context_id"))
        .cloned()
        .unwrap_or(Value::Null);
    let actual_source_context_id = match &actual_source_value {
        Value::Null => None,
        Value::String(value) if !value.trim().is_empty() => Some(value.as_str()),
        _ => {
            return Err(ContextCheckpointLineageError {
                field: SOURCE_CONTEXT_ID,
                expected: expected
                    .source_context_id
                    .as_deref()
                    .map_or(Value::Null, |value| json!(value)),
                actual: actual_source_value,
            });
        }
    };
    compare_optional_string(
        SOURCE_CONTEXT_ID,
        expected.source_context_id.as_deref(),
        actual_source_context_id,
    )?;

    let window_lineage_fields = [
        (WINDOW_NUMBER, "window_number"),
        (FIRST_WINDOW_ID, "first_window_id"),
        (PREVIOUS_WINDOW_ID, "previous_window_id"),
        (WINDOW_ID, "window_id"),
    ];
    let carries_window_lineage = window_lineage_fields
        .iter()
        .any(|(camel, snake)| aliased_value(candidate, camel, snake).is_some());
    if !carries_window_lineage {
        return Ok(());
    }

    compare_value(
        WINDOW_NUMBER,
        json!(expected.window_number),
        aliased_value(candidate, WINDOW_NUMBER, "window_number")
            .cloned()
            .unwrap_or(Value::Null),
    )?;
    compare_value(
        FIRST_WINDOW_ID,
        json!(expected.first_window_id),
        aliased_value(candidate, FIRST_WINDOW_ID, "first_window_id")
            .cloned()
            .unwrap_or(Value::Null),
    )?;
    compare_value(
        PREVIOUS_WINDOW_ID,
        json!(expected.previous_window_id),
        aliased_value(candidate, PREVIOUS_WINDOW_ID, "previous_window_id")
            .cloned()
            .unwrap_or(Value::Null),
    )?;
    compare_value(
        WINDOW_ID,
        json!(expected.window_id),
        aliased_value(candidate, WINDOW_ID, "window_id")
            .cloned()
            .unwrap_or(Value::Null),
    )
}

pub(crate) fn validate_context_checkpoint_revision(
    current_checkpoint: Option<&Value>,
    candidate: &Value,
) -> Result<(), ContextCheckpointLineageError> {
    let candidate_context_id = string_field(candidate, "contextId");
    if candidate_context_id.is_none() {
        return Ok(());
    }
    let current_context_id =
        current_checkpoint.and_then(|checkpoint| string_field(checkpoint, "contextId"));
    compare_optional_string(
        "contextId",
        current_context_id.as_deref(),
        candidate_context_id.as_deref(),
    )?;
    for (camel, snake) in [
        (SOURCE_CONTEXT_ID, "source_context_id"),
        (WINDOW_NUMBER, "window_number"),
        (FIRST_WINDOW_ID, "first_window_id"),
        (PREVIOUS_WINDOW_ID, "previous_window_id"),
        (WINDOW_ID, "window_id"),
    ] {
        let expected = current_checkpoint
            .and_then(|checkpoint| aliased_value(checkpoint, camel, snake))
            .cloned()
            .unwrap_or(Value::Null);
        let actual = aliased_value(candidate, camel, snake)
            .cloned()
            .unwrap_or(Value::Null);
        compare_value(camel, expected, actual)?;
    }
    Ok(())
}

fn initial_context_window_id(session_id: &str) -> String {
    format!("{session_id}:context-window:0")
}

fn compare_optional_string(
    field: &'static str,
    expected: Option<&str>,
    actual: Option<&str>,
) -> Result<(), ContextCheckpointLineageError> {
    compare_value(
        field,
        expected.map_or(Value::Null, |value| json!(value)),
        actual.map_or(Value::Null, |value| json!(value)),
    )
}

fn compare_value(
    field: &'static str,
    expected: Value,
    actual: Value,
) -> Result<(), ContextCheckpointLineageError> {
    if expected == actual {
        return Ok(());
    }
    Err(ContextCheckpointLineageError {
        field,
        expected,
        actual,
    })
}

fn string_field(value: &Value, camel: &str) -> Option<String> {
    let snake = camel_to_snake(camel);
    optional_string_field(value, camel, &snake).map(str::to_string)
}

fn optional_string_field<'a>(value: &'a Value, camel: &str, snake: &str) -> Option<&'a str> {
    aliased_value(value, camel, snake)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn aliased_value<'a>(value: &'a Value, camel: &str, snake: &str) -> Option<&'a Value> {
    value.get(camel).or_else(|| value.get(snake))
}

fn u64_field(value: &Value, camel: &str, snake: &str) -> Option<u64> {
    value
        .get(camel)
        .or_else(|| value.get(snake))
        .and_then(Value::as_u64)
}

fn camel_to_snake(value: &str) -> String {
    let mut result = String::with_capacity(value.len() + 4);
    for character in value.chars() {
        if character.is_ascii_uppercase() {
            result.push('_');
            result.push(character.to_ascii_lowercase());
        } else {
            result.push(character);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_advances_context_window_chain() {
        let first = next_context_window("session-1", "context-1", None);
        assert_eq!(
            first,
            ContextWindowLineage {
                source_context_id: None,
                window_number: 1,
                first_window_id: "session-1:context-window:0".to_string(),
                previous_window_id: "session-1:context-window:0".to_string(),
                window_id: "context-1".to_string(),
            }
        );
        let first_checkpoint = json!({
            "contextId": "context-1",
            "windowNumber": first.window_number,
            "firstWindowId": first.first_window_id,
            "previousWindowId": first.previous_window_id,
            "windowId": first.window_id,
        });

        let second = next_context_window("session-1", "context-2", Some(&first_checkpoint));
        assert_eq!(second.source_context_id.as_deref(), Some("context-1"));
        assert_eq!(second.window_number, 2);
        assert_eq!(second.first_window_id, "session-1:context-window:0");
        assert_eq!(second.previous_window_id, "context-1");
        assert_eq!(second.window_id, "context-2");
    }

    #[test]
    fn legacy_parent_checkpoint_becomes_window_zero_baseline() {
        let lineage = next_context_window(
            "session-1",
            "context-2",
            Some(&json!({ "contextId": "legacy-context" })),
        );

        assert_eq!(lineage.window_number, 1);
        assert_eq!(lineage.first_window_id, "legacy-context");
        assert_eq!(lineage.previous_window_id, "legacy-context");
    }

    #[test]
    fn validates_source_and_window_successor_together() {
        let current = json!({
            "contextId": "context-1",
            "windowNumber": 1,
            "firstWindowId": "session-1:context-window:0",
            "previousWindowId": "session-1:context-window:0",
            "windowId": "context-1",
        });
        let valid = json!({
            "contextId": "context-2",
            "sourceContextId": "context-1",
            "windowNumber": 2,
            "firstWindowId": "session-1:context-window:0",
            "previousWindowId": "context-1",
            "windowId": "context-2",
        });
        validate_context_checkpoint_successor("session-1", Some(&current), &valid).unwrap();

        let mut stale = valid.clone();
        stale["sourceContextId"] = json!("older");
        let error =
            validate_context_checkpoint_successor("session-1", Some(&current), &stale).unwrap_err();
        assert_eq!(error.field, SOURCE_CONTEXT_ID);

        let mut skipped = valid;
        skipped["windowNumber"] = json!(3);
        let error = validate_context_checkpoint_successor("session-1", Some(&current), &skipped)
            .unwrap_err();
        assert_eq!(error.field, WINDOW_NUMBER);

        let snake_case = json!({
            "context_id": "context-2",
            "source_context_id": "context-1",
            "window_number": 2,
            "first_window_id": "session-1:context-window:0",
            "previous_window_id": "context-1",
            "window_id": "context-2",
        });
        validate_context_checkpoint_successor("session-1", Some(&current), &snake_case).unwrap();

        let missing_source = json!({
            "contextId": "context-2",
            "replacementHistory": [],
        });
        let error =
            validate_context_checkpoint_successor("session-1", Some(&current), &missing_source)
                .unwrap_err();
        assert_eq!(error.field, SOURCE_CONTEXT_ID);
    }

    #[test]
    fn finalized_revision_must_match_the_current_window_identity() {
        let installed = json!({
            "contextId": "context-2",
            "sourceContextId": "context-1",
            "windowNumber": 2,
            "firstWindowId": "session-1:context-window:0",
            "previousWindowId": "context-1",
            "windowId": "context-2",
            "checkpointStage": "installed",
            "replacementHistory": [],
        });
        let mut finalized = installed.clone();
        finalized["checkpointStage"] = json!("finalized");
        finalized["replacementHistory"] = json!([
            { "role": "assistant", "content": "final answer" }
        ]);
        validate_context_checkpoint_revision(Some(&installed), &finalized).unwrap();

        finalized["windowId"] = json!("older-context");
        let error = validate_context_checkpoint_revision(Some(&installed), &finalized).unwrap_err();
        assert_eq!(error.field, WINDOW_ID);
    }
}
