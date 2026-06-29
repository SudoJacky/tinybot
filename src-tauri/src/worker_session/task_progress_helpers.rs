fn is_progress_message(message: &Value) -> bool {
    message_role(message) == Some("progress")
        || message
            .get("_task_event")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}
