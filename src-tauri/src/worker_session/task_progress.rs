use super::*;

impl WorkerSessionRpc {
    pub fn upsert_task_progress(
        &mut self,
        session_id: &str,
        plan_id: &str,
        mut progress: Value,
        content: String,
    ) -> Result<SessionMetadata, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
        if plan_id.is_empty() {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "invalid task plan id",
                serde_json::json!({ "plan_id": plan_id }),
                false,
                WorkerProtocolErrorSource::RustCore,
            ));
        }
        let mut steps = progress
            .get("steps")
            .or_else(|| progress.get("plan"))
            .cloned()
            .ok_or_else(|| invalid_task_plan(plan_id, "plan steps are required"))
            .and_then(|steps| {
                serde_json::from_value::<Vec<crate::worker_agent_runtime::AgentPlanStep>>(steps)
                    .map_err(|error| invalid_task_plan(plan_id, &error.to_string()))
            })?;
        let derived = crate::worker_agent_runtime::validate_and_normalize_plan_steps(&mut steps)
            .map_err(|error| invalid_task_plan(plan_id, &error))?;
        let provided_current_step = progress
            .get("currentStep")
            .or_else(|| progress.get("current_step"))
            .and_then(Value::as_str);
        if progress
            .get("completed")
            .and_then(Value::as_u64)
            .is_some_and(|value| value != u64::from(derived.completed))
            || progress
                .get("total")
                .and_then(Value::as_u64)
                .is_some_and(|value| value != u64::from(derived.total))
            || provided_current_step
                .is_some_and(|value| Some(value) != derived.current_step.as_deref())
        {
            return Err(invalid_task_plan(
                plan_id,
                "progress counters or current step do not match plan steps",
            ));
        }
        let progress_object = progress
            .as_object_mut()
            .ok_or_else(|| invalid_task_plan(plan_id, "progress must be an object"))?;
        progress_object.insert("steps".to_string(), serde_json::json!(steps));
        progress_object.insert(
            "completed".to_string(),
            Value::from(u64::from(derived.completed)),
        );
        progress_object.insert("total".to_string(), Value::from(u64::from(derived.total)));
        match derived.current_step.as_ref() {
            Some(current_step) => {
                progress_object.insert(
                    "currentStep".to_string(),
                    Value::String(current_step.clone()),
                );
            }
            None => {
                progress_object.remove("currentStep");
                progress_object.remove("current_step");
            }
        }
        let session = {
            let session = self.session_mut_or_create(session_id);
            ensure_extra_object(session);
            ensure_messages_array(session);
            let timestamp = now_session_timestamp();
            let agent_item = crate::worker_agent_runtime::AgentItem::PlanProgress(
                crate::worker_agent_runtime::AgentPlanProgressItem {
                    id: plan_id.to_string(),
                    explanation: progress
                        .get("explanation")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    steps,
                    summary: content.clone(),
                    completed: derived.completed,
                    total: derived.total,
                    current_step: derived.current_step,
                },
            );
            let progress_message = serde_json::json!({
                "role": "progress",
                "content": content,
                "timestamp": timestamp,
                "_progress": true,
                "_task_event": true,
                "_task_progress": progress,
                "_task_plan_id": plan_id,
                "_tool_name": "task",
                "_agent_item": agent_item,
            });
            if let Some(existing) = session
                .extra
                .get_mut("messages")
                .and_then(Value::as_array_mut)
            {
                if let Some(message) = existing.iter_mut().find(|message| {
                    message
                        .get("_task_event")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                        && message
                            .get("_task_plan_id")
                            .and_then(Value::as_str)
                            .is_some_and(|existing_plan_id| existing_plan_id == plan_id)
                }) {
                    *message = progress_message;
                } else {
                    existing.push(progress_message);
                }
            }
            session.updated_at = now_session_timestamp();
            session.clone()
        };
        self.persist_sessions()?;
        Ok(session)
    }
}

fn invalid_task_plan(plan_id: &str, reason: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        format!("invalid task plan: {reason}"),
        serde_json::json!({ "plan_id": plan_id }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
