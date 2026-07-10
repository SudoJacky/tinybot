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
                let params: ShellExecuteRequestParams = parse_params(request)?;
                if !request.is_trusted_internal() {
                    self.approval
                        .require_sensitive_operation(shell_execute_approval(
                            &params.command,
                            params.session_id.clone(),
                            params.run_id.clone(),
                        ))?;
                }
                serde_json::to_value(
                    self.shell
                        .execute(params.into_shell_params(request.cancellation()))?,
                )
                .map_err(serialization_error)
            }
            "shell.start" => {
                let params: ShellStartRequestParams = parse_params(request)?;
                if !request.is_trusted_internal() {
                    self.approval
                        .require_sensitive_operation(shell_start_approval(
                            &params.command,
                            params.session_id.clone(),
                            params.run_id.clone(),
                        ))?;
                }
                serde_json::to_value(
                    self.shell
                        .start(params.into_shell_params(request.cancellation()))?,
                )
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
