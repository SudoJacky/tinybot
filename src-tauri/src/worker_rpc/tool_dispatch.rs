use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_tool_method(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        match request.method.as_str() {
            "mcp.call_tool" => self.mcp.call_tool_from_request(request),
            "mcp.list_tools" => self.mcp.list_tools(),
            "mcp.server_status" => self.mcp.server_status_from_request(request),
            "mcp.diagnostics" => self.mcp.diagnostics(),
            "mcp.shutdown" => {
                self.mcp.shutdown()?;
                Ok(serde_json::json!({ "stopped": true }))
            }
            "permission_profile.current" => serde_json::to_value(
                self.permission_profile
                    .current_profile(self.tool_registry.list_tools().tools),
            )
            .map_err(serialization_error),
            "permission_profile.evaluate_tool" => {
                let params: PermissionEvaluateToolRequest = parse_params(request)?;
                let tool = self
                    .tool_registry
                    .get_tool(&params.tool_id)
                    .ok_or_else(|| {
                        self.permission_profile
                            .tool_not_found_error(&params.tool_id)
                    })?;
                serde_json::to_value(self.permission_profile.evaluate_tool(&tool, params))
                    .map_err(serialization_error)
            }
            "permission_profile.request_tool_approval" => {
                let params: PermissionRequestToolApprovalRequest = parse_params(request)?;
                self.request_tool_approval(request, params)
            }
            "permission_profile.resolve_tool_approval" => {
                let params: PermissionResolveToolApprovalRequest = parse_params(request)?;
                self.resolve_tool_approval(request, params)
            }
            "tool_executor.execute" => {
                let params: ToolExecutorExecuteRequest = parse_params(request)?;
                self.execute_registered_tool(request, params)
            }
            "tool_registry.list" => {
                serde_json::to_value(self.tool_registry.list_tools()).map_err(serialization_error)
            }
            "tool_registry.search" => {
                let params: ToolRegistrySearchRequest = parse_params(request)?;
                serde_json::to_value(self.tool_registry.search_tools(params))
                    .map_err(serialization_error)
            }
            _ => Err(unknown_method_error(request)),
        }
    }
}
