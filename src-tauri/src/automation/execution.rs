use super::saved::{now, ExecutionOptions, Run, Store};
use crate::agent::bridge::{
    execute_thread_turn_with_services, AgentApplicationServices, SubmitThreadTurnInput,
};
use crate::agent::provider::resolve_provider_profile;
use crate::agent::runtime::{AgentTurnInput, NativeAgentTraceSink};
use crate::protocol::{request_id::next_worker_request_correlation, WorkerRequest};
use crate::rpc::call_rust_state_service;
use crate::workspace_registry::canonical_workspace;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub(crate) fn snapshot(
    store: &Store,
    threads: &crate::threads::workspace_store::WorkspaceThreadStore,
) -> Result<super::saved::Snapshot, String> {
    let mut snapshot = store.snapshot()?;
    for run in &mut snapshot.runs {
        if run.status != "waiting" {
            continue;
        }
        let thread_id = run
            .thread_id
            .as_deref()
            .ok_or("Waiting automation has no Thread")?;
        let record = threads
            .agent_turn(thread_id, &format!("automation-{}", run.id))
            .map_err(|e| format!("{}: {:?}", e.message, e.details))?
            .ok_or_else(|| format!("Automation {}: owning Turn is unavailable", run.id))?;
        use crate::threads::turn::AgentTurnStatus;
        let status = match record.status {
            AgentTurnStatus::Running => {
                // Keep the durable waiting ownership until the resumed Turn terminates.
                run.status = "running".into();
                continue;
            }
            AgentTurnStatus::Waiting => continue,
            AgentTurnStatus::Completed => "completed",
            AgentTurnStatus::Failed => "failed",
            AgentTurnStatus::Cancelled => "cancelled",
            AgentTurnStatus::Interrupted => "interrupted",
        };
        run.status = status.into();
        run.stop_reason = record.stop_reason;
        run.error = record.error.map(|e| e.to_string());
        run.finished_at_ms = Some(now());
        store.update(run)?;
    }
    Ok(snapshot)
}

pub(crate) fn output(
    store: &Store,
    threads: &crate::threads::workspace_store::WorkspaceThreadStore,
    id: &str,
) -> Result<String, String> {
    let run = store
        .snapshot()?
        .runs
        .into_iter()
        .find(|r| r.id == id)
        .ok_or("Automation run missing")?;
    let thread_id = run
        .thread_id
        .ok_or("Run has not created its conversation yet")?;
    let record = threads
        .agent_turn(&thread_id, &format!("automation-{}", run.id))
        .map_err(|e| format!("{}: {:?}", e.message, e.details))?
        .ok_or("The owning Turn is unavailable; inspect the conversation")?;
    record
        .trace_messages
        .iter()
        .rev()
        .find_map(|message| {
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                return None;
            }
            message
                .get("content")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string)
        })
        .ok_or_else(|| "This run has no assistant output yet; open its conversation".to_string())
}

pub(crate) fn prepare(store: &Store, id: &str, config: &Value) -> Result<Run, String> {
    let definition = store
        .snapshot()?
        .definitions
        .into_iter()
        .find(|d| d.id == id)
        .ok_or("Automation no longer exists")?;
    let effective = effective_model(&definition.execution, &definition.workspace_path, config)?;
    store.begin(definition, effective)
}

pub(crate) fn configured_config(
    options: &ExecutionOptions,
    config: &Value,
) -> Result<Value, String> {
    let mut config = config.clone();
    if let Some(provider) = options.provider.as_deref() {
        let selected = if let Some(profile) = options.profile.as_deref() {
            config
                .pointer("/providers/profiles")
                .and_then(|p| p.get(profile))
        } else {
            config.get("providers").and_then(|p| p.get(provider))
        }
        .ok_or("Selected provider configuration is unavailable")?;
        if selected.get("enabled").and_then(Value::as_bool) == Some(false) {
            return Err("Selected provider is disabled".into());
        }
        if options.profile.is_some()
            && selected.get("provider").and_then(Value::as_str) != Some(provider)
        {
            return Err("Selected profile does not belong to this provider".into());
        }
        if let Some(models) = selected
            .get("enabledModels")
            .or_else(|| selected.get("enabled_models"))
            .and_then(Value::as_array)
        {
            if !models
                .iter()
                .any(|m| m.as_str() == options.model.as_deref())
            {
                return Err("Selected model is disabled or unavailable".into());
            }
        }
        config["agents"]["defaults"]["provider"] = json!(provider);
        config["agents"]["defaults"]["model"] = json!(options.model);
        config["agents"]["defaults"]["activeProfile"] = json!(options.profile);
        if let Some(defaults) = config
            .pointer_mut("/agents/defaults")
            .and_then(Value::as_object_mut)
        {
            defaults.remove("active_profile");
        }
    }
    Ok(config)
}

pub(crate) fn effective_model(
    options: &ExecutionOptions,
    workspace: &str,
    config: &Value,
) -> Result<Value, String> {
    canonical_workspace(Path::new(workspace))?;
    let config = configured_config(options, config)?;
    let mut spec = json!({"metadata": {"workingDirectory": workspace}});
    if let Some(effort) = &options.reasoning_effort {
        spec["reasoningEffort"] = json!(effort);
    }
    let input = AgentTurnInput::from_wire(&spec, &config)?;
    let settings = input.settings;
    let profile = resolve_provider_profile(
        &config,
        settings.provider.as_deref(),
        options.profile.as_deref(),
    )
    .ok_or("No available model provider is configured")?;
    crate::agent::provider::validate_provider_configuration(&profile)?;
    if options.reasoning_effort.is_some() && !profile.supports_reasoning_effort {
        return Err("Selected provider does not support reasoning effort".into());
    }
    if settings.model.trim().is_empty() {
        return Err("No default model configured".into());
    }
    if !profile.models.is_empty() && !profile.models.contains(&settings.model) {
        return Err(format!(
            "Model `{}` is not available in provider `{}`",
            settings.model, profile.provider_id
        ));
    }
    // Deliberately store only non-secret effective settings, never the runtime config.
    let effective = json!({
        "model": settings.model, "provider": profile.provider_id, "apiMode": profile.api_mode,
        "apiBase": profile.api_base, "temperature": settings.temperature,
        "maxCompletionTokens": settings.max_completion_tokens, "serviceTier": settings.service_tier,
        "reasoningEffort": settings.reasoning.as_ref().and_then(|r| r.effort.as_ref()),
        "reasoningSummary": settings.reasoning.as_ref().and_then(|r| r.summary.as_ref()),
        "maxIterations": settings.max_iterations,
        "parallelToolCalls": settings.parallel_tool_calls,
        "contextWindowStrategy": settings.context_window_strategy.as_str(),
        "contextWindowTokens": profile.context_window_tokens_for_model(&settings.model),
        "outputSchema": settings.output_schema.as_ref().map(|s| json!({"name": s.name, "schema": s.schema, "strict": s.strict})),
        "requestTimeoutMs": profile.request_timeout_ms,
        "streamIdleTimeoutMs": profile.stream_idle_timeout_ms,
    });
    Ok(effective)
}

pub(crate) fn validate_thread(
    options: &ExecutionOptions,
    workspace: &str,
    threads: &crate::threads::workspace_store::WorkspaceThreadStore,
) -> Result<(), String> {
    let Some(id) = options.thread_id.as_deref() else {
        return Ok(());
    };
    let thread = threads
        .read_agent_thread(id)
        .map_err(|e| format!("{}: {:?}", e.message, e.details))?
        .thread;
    if thread.archived_at.is_some() {
        return Err("Selected conversation is archived".into());
    }
    let path = thread
        .metadata
        .working_directory
        .as_deref()
        .ok_or("Selected conversation has no workspace")?;
    if canonical_workspace(Path::new(path))? != canonical_workspace(Path::new(workspace))? {
        return Err("Selected conversation belongs to a different workspace".into());
    }
    if thread.source == "project_coordinator" {
        return Err("Select a regular conversation, not a project coordinator".into());
    }
    Ok(())
}

pub(crate) async fn execute(
    store: Store,
    mut run: Run,
    services: AgentApplicationServices,
    workspace_root: PathBuf,
    config: Value,
    sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<(), String> {
    let execution = async {
        validate_thread(&run.definition.execution, &run.definition.workspace_path, &services.thread_store)?;
        let config = configured_config(&run.definition.execution, &config)?;
        let correlation = next_worker_request_correlation();
        let thread_id = if let Some(id) = &run.definition.execution.thread_id {
            let target = services.thread_store.read_agent_thread(id).map_err(|e| format!("{}: {:?}", e.message, e.details))?;
            if target.active_turn.is_some() { return Err("Selected conversation has an active turn; wait for it to finish".into()); }
            id.clone()
        } else {
        let thread = call_rust_state_service(&services.thread_store, config.clone(), WorkerRequest::new(
            correlation.id("automation-create"), correlation.trace_id("automation-create"), "thread.create",
            json!({"title": run.definition.name, "source": "automation", "metadata": {
                "workingDirectory": run.definition.workspace_path, "model": run.effective_model["model"],
                "extra": {"automationId": run.definition.id, "automationRunId": run.id,
                    "modelProvider": run.effective_model["provider"]}
            }})), "Automation Thread create")?;
        let thread_id = thread.get("threadId").and_then(Value::as_str).ok_or("Thread create returned no threadId")?.to_string();
        thread_id
        };
        run.thread_id = Some(thread_id.clone());
        store.update(&run)?;
        eprintln!("automation_run_started run_id={} thread_id={thread_id}", run.id);
        let result = execute_thread_turn_with_services(services, SubmitThreadTurnInput {
            thread_id: Some(thread_id),
            input: json!({"role": "user", "content": run.definition.instructions, "clientEventId": format!("automation-{}", run.id)}),
            spec: json!({"runtime": "rust", "stream": true, "turnId": format!("automation-{}", run.id),
                "model": run.effective_model["model"], "provider": run.effective_model["provider"],
                "reasoningEffort": run.effective_model["reasoningEffort"],
                "metadata": {"workingDirectory": run.definition.workspace_path, "automationId": run.definition.id, "automationRunId": run.id}}),
        }, workspace_root, config, sink).await.map_err(|e| e.to_string())?;
        run.status = result.result.stop_reason.status().as_str().into();
        run.stop_reason = Some(result.result.stop_reason.as_str().into());
        run.error = result.result.error.as_ref().map(|e| e.message().to_string());
        Ok::<(), String>(())
    }.await;
    if let Err(error) = execution {
        run.status = "failed".into();
        run.error = Some(error);
    }
    if run.status != "waiting" {
        run.finished_at_ms = Some(now());
    }
    eprintln!(
        "automation_run_stopped run_id={} status={} reason={:?} error={:?}",
        run.id, run.status, run.stop_reason, run.error
    );
    store.update(&run)
}
