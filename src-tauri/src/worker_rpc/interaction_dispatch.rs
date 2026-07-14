use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_interaction_method(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        match request.method.as_str() {
            "diagnostics.append" => {
                let params: DiagnosticsAppendParams = parse_params(request)?;
                serde_json::to_value(self.diagnostics.append(&params.stream, &params.line)?)
                    .map_err(serialization_error)
            }
            "channel.connector.start" => self.channel_connector.start_from_request(request),
            "channel.connector.stop" => self.channel_connector.stop_from_request(request),
            "channel.connector.login" => self.channel_connector.login_from_request(request),
            "channel.connector.send_text" => self.channel_connector.send_text_from_request(request),
            "channel.connector.send_delta" => {
                self.channel_connector.send_delta_from_request(request)
            }
            "channel.connector.send_usage" => {
                self.channel_connector.send_usage_from_request(request)
            }
            "channel.connector.transcribe_audio" => self
                .channel_connector
                .transcribe_audio_from_request(request),
            "shell.execute" => {
                require_exec_tools_enabled(self.config.snapshot())?;
                let params: ShellExecuteRequestParams = parse_params(request)?;
                let sandbox_mode = params.sandbox_mode.unwrap_or_default();
                let network_mode = params
                    .network_mode
                    .unwrap_or(PermissionNetworkMode::Unrestricted);
                self.shell
                    .validate_security_request(sandbox_mode, network_mode, false)?;
                let approval_decision = if request.is_trusted_internal() {
                    "trusted_internal"
                } else {
                    "approved"
                };
                if !request.is_trusted_internal() {
                    self.approval
                        .require_sensitive_operation(shell_execute_approval(
                            &params.command,
                            sandbox_mode,
                            network_mode,
                            params.session_id.clone(),
                            params.run_id.clone(),
                        ))?;
                }
                serde_json::to_value(self.shell.execute_with_approval_decision(
                    params.into_shell_params(request.cancellation(), self.config.snapshot()),
                    approval_decision,
                )?)
                .map_err(serialization_error)
            }
            "shell.start" => {
                require_exec_tools_enabled(self.config.snapshot())?;
                let params: ShellStartRequestParams = parse_params(request)?;
                let sandbox_mode = params.sandbox_mode.unwrap_or_default();
                let network_mode = params
                    .network_mode
                    .unwrap_or(PermissionNetworkMode::Unrestricted);
                let tty = params.tty.unwrap_or(false);
                self.shell
                    .validate_security_request(sandbox_mode, network_mode, tty)?;
                let approval_decision = if request.is_trusted_internal() {
                    "trusted_internal"
                } else {
                    "approved"
                };
                if !request.is_trusted_internal() {
                    self.approval
                        .require_sensitive_operation(shell_start_approval(
                            &params.command,
                            sandbox_mode,
                            network_mode,
                            tty,
                            params.session_id.clone(),
                            params.run_id.clone(),
                        ))?;
                }
                serde_json::to_value(self.shell.start_with_approval_decision(
                    params.into_shell_params(request.cancellation(), self.config.snapshot()),
                    approval_decision,
                )?)
                .map_err(serialization_error)
            }
            "shell.poll" => {
                let params: ShellProcessPollParams = parse_params(request)?;
                serde_json::to_value(self.shell.poll(params)?).map_err(serialization_error)
            }
            "shell.write_stdin" => {
                let params: ShellProcessInputParams = parse_params(request)?;
                serde_json::to_value(self.shell.write_stdin(params)?).map_err(serialization_error)
            }
            "shell.resize" => {
                let params: ShellProcessResizeParams = parse_params(request)?;
                let process_id = params.process_id.clone();
                self.shell.resize(params)?;
                Ok(serde_json::json!({
                    "processId": process_id,
                    "resized": true,
                }))
            }
            "shell.interrupt" => {
                let params: ShellProcessIdParams = parse_params(request)?;
                serde_json::to_value(self.shell.interrupt(params)?).map_err(serialization_error)
            }
            "shell.terminate" => {
                let params: ShellProcessIdParams = parse_params(request)?;
                serde_json::to_value(self.shell.terminate(params)?).map_err(serialization_error)
            }
            "shell.terminate_run" => {
                let params: ShellRunParams = parse_params(request)?;
                serde_json::to_value(self.shell.terminate_run(&params.run_id))
                    .map_err(serialization_error)
            }
            "shell.list" => {
                let params: ShellProcessListParams = parse_params(request)?;
                serde_json::to_value(self.shell.list(params)?).map_err(serialization_error)
            }
            "shell.shutdown" => {
                serde_json::to_value(self.shell.shutdown()).map_err(serialization_error)
            }
            "approval.request" => self.approval.request_from_request(request),
            "approval.resolve" => self.approval.resolve_from_request(request),
            "approval.list_pending" => self.approval.list_pending_from_request(request),
            "form.request" => self.form.request_from_request(request),
            _ => Err(unknown_method_error(request)),
        }
    }
}

fn require_exec_tools_enabled(config_snapshot: &Value) -> Result<(), WorkerProtocolError> {
    if config_snapshot
        .pointer("/tools/exec/enable")
        .and_then(Value::as_bool)
        != Some(false)
    {
        return Ok(());
    }
    Err(WorkerProtocolError::new(
        WorkerProtocolErrorCode::CapabilityDenied,
        "shell execution is disabled by tools.exec.enable",
        serde_json::json!({ "path": "tools.exec.enable" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    ))
}
