use serde_json::Value;
use std::collections::HashSet;

fn is_patch_tool(name: &str) -> bool {
    matches!(
        name,
        "apply_patch" | "workspace.apply_patch" | "workspace_apply_patch"
    )
}

/// Project only patch receipts. Raw diffs remain in the tool envelope for review.
/// Plain-text errors and command output are deliberately left intact.
pub(super) fn compact_patch_content(tool_name: &str, content: &str) -> Option<String> {
    if !is_patch_tool(tool_name) {
        return None;
    }
    let Ok(mut result) = serde_json::from_str::<Value>(content) else {
        return None;
    };
    let mut changed = false;
    // Standalone, Action Fusion, and their structured outcome wrappers.
    for pointer in ["", "/patch/result", "/result", "/result/patch/result"] {
        let Some(files) = result
            .pointer_mut(pointer)
            .and_then(|value| value.get_mut("changed_files"))
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for file in files {
            if let Some(file) = file.as_object_mut() {
                changed |= file.remove("delta").is_some();
                changed |= file.remove("delta_truncated").is_some();
            }
        }
    }
    changed.then(|| result.to_string())
}

/// Apply the same projection to old persisted results at the provider boundary,
/// without modifying canonical history or unrelated tools' output.
pub(super) fn project_patch_history(items: &mut [Value]) {
    let mut patch_calls = HashSet::new();
    for item in items.iter() {
        if item.get("type").and_then(Value::as_str) == Some("function_call") {
            if item
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(is_patch_tool)
            {
                if let Some(id) = item.get("call_id").and_then(Value::as_str) {
                    patch_calls.insert(id.to_string());
                }
            }
        }
        if item.get("role").and_then(Value::as_str) == Some("assistant") {
            for call in item
                .get("tool_calls")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if call
                    .pointer("/function/name")
                    .and_then(Value::as_str)
                    .is_some_and(is_patch_tool)
                {
                    if let Some(id) = call.get("id").and_then(Value::as_str) {
                        patch_calls.insert(id.to_string());
                    }
                }
            }
        }
    }
    for item in items {
        let (id_field, content_field, name_field) =
            if item.get("type").and_then(Value::as_str) == Some("function_call_output") {
                ("call_id", "output", "tool_name")
            } else if item.get("role").and_then(Value::as_str) == Some("tool") {
                ("tool_call_id", "content", "name")
            } else {
                continue;
            };
        let is_patch = item
            .get(id_field)
            .and_then(Value::as_str)
            .is_some_and(|id| patch_calls.contains(id))
            || item
                .get(name_field)
                .and_then(Value::as_str)
                .is_some_and(is_patch_tool);
        if is_patch {
            if let Some(compact) = item
                .get(content_field)
                .and_then(Value::as_str)
                .and_then(|content| compact_patch_content("apply_patch", content))
            {
                item[content_field] = Value::String(compact);
            }
        }
    }
}
