use crate::config::experiments::ExperimentalSettings;
use crate::protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource, WorkerRequest,
};
use crate::tools::shell::{ShellStartParams, WorkerShellRpc};
use crate::workspace::WorkerWorkspaceRpc;
use serde::Deserialize;
use serde_json::{json, Value};

pub(crate) const TOOL_DESCRIPTION_SUFFIX: &str = " When the verification command is already known and no intermediate inspection is needed to choose the next step, use thenRun to apply the patch and run that command in one call. The command runs only after the patch succeeds; command failure keeps the edit. For a running command, continue with write_stdin instead of repeating the patch.";

pub(crate) fn then_run_schema() -> Value {
    json!({
        "type": "object",
        "description": "Run this command only after the patch succeeds, without another model turn. Use only when the command is already known. A failed command keeps the patch. If still running, continue with write_stdin; never repeat the patch to wait. Working directory defaults to the patch workspace.",
        "additionalProperties": false,
        "required": ["command"],
        "properties": {
            "command": { "type": "string", "minLength": 1 },
            "workingDir": { "type": "string" },
            "yieldTimeMs": { "type": "integer", "minimum": 0, "maximum": 30000, "description": "Initial wait only, not an execution timeout; default 10000 ms." }
        }
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ThenRun {
    command: String,
    #[serde(default)]
    working_dir: Option<String>,
    #[serde(default)]
    yield_time_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FusedPatchParams {
    patch: String,
    then_run: ThenRun,
    #[serde(default)]
    turn_id: Option<String>,
    #[serde(default)]
    tool_call_id: Option<String>,
}

pub(crate) fn execute(
    workspace: &WorkerWorkspaceRpc,
    shell: &WorkerShellRpc,
    config: &Value,
    request: &WorkerRequest,
    params: FusedPatchParams,
) -> Result<Value, WorkerProtocolError> {
    let enabled = ExperimentalSettings::from_config(config)
        .map_err(invalid_request)?
        .action_fusion;
    if !enabled {
        return Err(invalid_request(
            "Action Fusion is disabled by experiments.actionFusion",
        ));
    }
    if config
        .pointer("/tools/exec/enable")
        .and_then(Value::as_bool)
        == Some(false)
    {
        return Err(invalid_request("Action Fusion requires tools.exec.enable"));
    }
    if params
        .then_run
        .yield_time_ms
        .is_some_and(|value| value > 30_000)
    {
        return Err(invalid_request("thenRun.yieldTimeMs must be at most 30000"));
    }
    // Validate execution capability, owner, working directory and cancellation before editing.
    let prepared = shell.prepare_start(ShellStartParams {
        command: params.then_run.command,
        working_dir: params.then_run.working_dir,
        yield_time_ms: params.then_run.yield_time_ms,
        owner_id: params.turn_id,
        tool_call_id: params.tool_call_id,
        cancellation: request.cancellation(),
        tty: Some(false),
        rows: None,
        cols: None,
    })?;
    let metrics = crate::runtime::observability::global_agent_runtime_metrics();
    metrics.increment("actionFusion.requested");
    let patch = workspace.apply_patch(&params.patch).map_err(|mut error| {
        metrics.increment("actionFusion.patchFailed");
        error.message = format!(
            "{}; thenRun skipped because the patch failed",
            error.message
        );
        error
    })?;
    metrics.increment("actionFusion.patchSucceeded");
    eprintln!(
        "[tinybot-action-fusion] request={} trace={} stage=patch_succeeded",
        request.id, request.trace_id
    );
    let command = match shell.start_prepared(prepared) {
        Ok(output) => {
            metrics.increment("actionFusion.commandStarted");
            eprintln!("[tinybot-action-fusion] request={} trace={} stage=command_result process={} status={} exit={:?}", request.id, request.trace_id, output.process_id, output.status, output.exit_code);
            serde_json::to_value(output).expect("Shell process output must serialize")
        }
        Err(error) => {
            metrics.increment("actionFusion.commandStartFailed");
            eprintln!(
                "[tinybot-action-fusion] request={} trace={} stage=command_start_failed error={}",
                request.id, request.trace_id, error.message
            );
            json!({ "status": "start_failed", "error": error })
        }
    };
    Ok(json!({
        "kind": "action_fusion",
        "patch": { "status": "succeeded", "result": patch },
        "thenRun": command,
        "guidance": "The patch is already applied. Do not repeat it to wait for or retry the command. A failed command does not roll back the patch."
    }))
}

fn invalid_request(message: impl Into<String>) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        json!({ "stage": "action_fusion_preflight" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
