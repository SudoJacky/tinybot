use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_subagent_method(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        match request.method.as_str() {
            "subagent.spawn" => {
                let params: SubagentSpawnParams = parse_params(request)?;
                let Some(manager) = &self.subagents else {
                    return Err(unavailable_subagent_manager());
                };
                let result = manager.spawn(params);
                if result.accepted {
                    if let Some(subagent) = &result.subagent {
                        self.thread.record_subagent_spawn(
                            subagent,
                            result
                                .event
                                .as_ref()
                                .map(serde_json::to_value)
                                .transpose()
                                .map_err(serialization_error)?,
                        )?;
                    }
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "subagent.list" => {
                let params: SubagentListParams = parse_params(request)?;
                let Some(manager) = &self.subagents else {
                    return Err(unavailable_subagent_manager());
                };
                let trace_events = self
                    .background
                    .list_trace_events(BackgroundTraceListParams {
                        filter: Some(BackgroundTraceListFilter {
                            session_key: Some(params.session_key.clone()),
                            ..Default::default()
                        }),
                    })?
                    .events;
                manager.restore_interrupted_from_trace_events(&params.session_key, &trace_events);
                serde_json::to_value(manager.list(&params.session_key)).map_err(serialization_error)
            }
            "subagent.query" => {
                let params: SubagentTargetParams = parse_params(request)?;
                let Some(manager) = &self.subagents else {
                    return Err(unavailable_subagent_manager());
                };
                serde_json::to_value(manager.query(params)).map_err(serialization_error)
            }
            "subagent.send_input" => {
                let params: SubagentSendInputParams = parse_params(request)?;
                let Some(manager) = &self.subagents else {
                    return Err(unavailable_subagent_manager());
                };
                let result = manager.enqueue_input(params);
                if result.accepted {
                    if let (Some(subagent), Some(input)) = (&result.subagent, &result.input) {
                        self.thread.record_subagent_input(
                            subagent,
                            input,
                            result
                                .event
                                .as_ref()
                                .map(serde_json::to_value)
                                .transpose()
                                .map_err(serialization_error)?,
                        )?;
                    }
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "subagent.wait" => {
                let params: SubagentWaitParams = parse_params(request)?;
                let Some(manager) = &self.subagents else {
                    return Err(unavailable_subagent_manager());
                };
                let result = manager.wait(params);
                for subagent in &result.statuses {
                    self.thread.record_subagent_status(subagent, None)?;
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "subagent.cancel" => {
                let params: SubagentTargetParams = parse_params(request)?;
                let Some(manager) = &self.subagents else {
                    return Err(unavailable_subagent_manager());
                };
                let result = manager.cancel(params);
                if result.accepted {
                    if let Some(subagent) = &result.subagent {
                        self.thread.record_subagent_status(
                            subagent,
                            result
                                .event
                                .as_ref()
                                .map(serde_json::to_value)
                                .transpose()
                                .map_err(serialization_error)?,
                        )?;
                    }
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "subagent.close" => {
                let params: SubagentTargetParams = parse_params(request)?;
                let Some(manager) = &self.subagents else {
                    return Err(unavailable_subagent_manager());
                };
                let result = manager.close(params);
                if result.accepted {
                    if let Some(subagent) = &result.subagent {
                        self.thread.record_subagent_status(
                            subagent,
                            result
                                .event
                                .as_ref()
                                .map(serde_json::to_value)
                                .transpose()
                                .map_err(serialization_error)?,
                        )?;
                    }
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            _ => Err(unknown_method_error(request)),
        }
    }
}
