use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_background_method(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        match request.method.as_str() {
            "task.store.load" => {
                serde_json::to_value(self.task.load_store()?).map_err(serialization_error)
            }
            "task.plan.list" => {
                let params: TaskPlanListParams = parse_params(request)?;
                serde_json::to_value(self.task.list_plans(params)?).map_err(serialization_error)
            }
            "task.plan.get" => {
                let params: TaskPlanIdParams = parse_params(request)?;
                serde_json::to_value(self.task.get_plan(params)?).map_err(serialization_error)
            }
            "task.plan.save" => {
                let params: TaskPlanSaveParams = parse_params(request)?;
                serde_json::to_value(self.task.save_plan(params)?).map_err(serialization_error)
            }
            "task.plan.delete" => {
                let params: TaskPlanIdParams = parse_params(request)?;
                serde_json::to_value(self.task.delete_plan(params)?).map_err(serialization_error)
            }
            "cron.job.add" => {
                let params: CronJobAddParams = parse_params(request)?;
                serde_json::to_value(self.cron.add_job(params)?).map_err(serialization_error)
            }
            "cron.job.list" => {
                serde_json::to_value(self.cron.list_jobs()?).map_err(serialization_error)
            }
            "cron.job.due" => {
                let params: CronJobDueParams = parse_params(request)?;
                serde_json::to_value(self.cron.due_jobs(params)?).map_err(serialization_error)
            }
            "cron.job.record_runs" => {
                let params: CronJobRecordRunsParams = parse_params(request)?;
                serde_json::to_value(self.cron.record_runs(params)?).map_err(serialization_error)
            }
            "cron.job.remove" => {
                let params: CronJobRemoveParams = parse_params(request)?;
                serde_json::to_value(self.cron.remove_job(params)?).map_err(serialization_error)
            }
            "background.run.list" => {
                serde_json::to_value(self.background.list_runs()?).map_err(serialization_error)
            }
            "background.run.upsert" => {
                let params: BackgroundRunUpsertParams = parse_params(request)?;
                serde_json::to_value(self.background.upsert_run(params)?)
                    .map_err(serialization_error)
            }
            "background.run.complete" => {
                let params: BackgroundRunCompleteParams = parse_params(request)?;
                serde_json::to_value(self.background.complete_run(params)?)
                    .map_err(serialization_error)
            }
            "background.trace.append" => {
                let params: BackgroundTraceAppendParams = parse_params(request)?;
                serde_json::to_value(self.background.append_trace_event(params)?)
                    .map_err(serialization_error)
            }
            "background.trace.list" => {
                let params: BackgroundTraceListParams = parse_params(request)?;
                serde_json::to_value(self.background.list_trace_events(params)?)
                    .map_err(serialization_error)
            }
            "background.trace.get_delegate_trace" => {
                let params: BackgroundTraceGetDelegateTraceParams = parse_params(request)?;
                serde_json::to_value(self.background.get_delegate_trace(params)?)
                    .map_err(serialization_error)
            }
            "background.trace.get_artifact" => {
                let params: BackgroundTraceGetArtifactParams = parse_params(request)?;
                serde_json::to_value(self.background.get_artifact(params)?)
                    .map_err(serialization_error)
            }
            "background.subagent.enqueue_input" => {
                let mut params: BackgroundSubagentEnqueueInputParams = parse_params(request)?;
                if let Some(manager) = &self.subagents {
                    let live = manager.enqueue_input(SubagentSendInputParams {
                        session_key: params.session_key.clone(),
                        subagent_id: params.subagent_id.clone(),
                        content: params.content.clone(),
                        sender: SubagentInputSender::User,
                        turn_id: params.turn_id.clone(),
                        child_turn_id: params.child_turn_id.clone(),
                        trace_ref: params.trace_ref.clone(),
                        created_at: params.created_at.clone(),
                        metadata: params.metadata.clone(),
                    });
                    if !live.accepted {
                        return serde_json::to_value(live).map_err(serialization_error);
                    }
                    if live.delivery == "live_delivered" {
                        params.delivery = Some(live.delivery.clone());
                        let persisted = self.background.enqueue_subagent_input(params)?;
                        return Ok(serde_json::json!({
                            "accepted": true,
                            "delivery": live.delivery,
                            "event": persisted.event,
                            "input": live.input,
                            "subagent": live.subagent,
                        }));
                    }
                }
                serde_json::to_value(self.background.enqueue_subagent_input(params)?)
                    .map_err(serialization_error)
            }
            _ => Err(unknown_method_error(request)),
        }
    }
}
