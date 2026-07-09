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
                self.approval
                    .require_sensitive_operation(shell_execute_approval(
                        &params.command,
                        params.session_id.clone(),
                        params.run_id.clone(),
                    ))?;
                serde_json::to_value(self.shell.execute(params.into_shell_params())?)
                    .map_err(serialization_error)
            }
            "approval.request" => self.approval.request_from_request(request),
            "approval.resolve" => self.approval.resolve_from_request(request),
            "approval.list_pending" => self.approval.list_pending_from_request(request),
            "form.request" => self.form.request_from_request(request),
            _ => Err(unknown_method_error(request)),
        }
    }
}
