use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_config_method(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        match request.method.as_str() {
            "config.get" => {
                let params: PathParams = parse_params(request)?;
                serde_json::to_value(self.config.get(&params.path)?).map_err(serialization_error)
            }
            "config.snapshot_public" => {
                serde_json::to_value(self.config.snapshot_public()?).map_err(serialization_error)
            }
            "config.apply_patch_result" => {
                let params: ConfigPatchBridgeResult = parse_params(request)?;
                let result = if let Some(config_store) = self.config_store.as_mut() {
                    self.config
                        .apply_patch_result_to_store(config_store, params)?
                } else {
                    self.config.apply_patch_result(params)?
                };
                if result.ok {
                    self.secret.update_snapshot(self.config.snapshot().clone());
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "config.apply_operations" => {
                let params: crate::config_store::ConfigOperationRequest = parse_params(request)?;
                let result = if let Some(config_store) = self.config_store.as_mut() {
                    self.config
                        .apply_operations_to_store(config_store, params)?
                } else {
                    return Err(WorkerProtocolError::new(
                        WorkerProtocolErrorCode::InvalidProtocol,
                        "config operation writes require a config store",
                        serde_json::json!({ "method": request.method }),
                        false,
                        WorkerProtocolErrorSource::RustCore,
                    ));
                };
                if result.ok {
                    self.secret.update_snapshot(self.config.snapshot().clone());
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "provider.resolve_secret" => {
                let params: ProviderResolveSecretParams = parse_params(request)?;
                serde_json::to_value(self.secret.resolve_secret(params)?)
                    .map_err(serialization_error)
            }
            _ => Err(unknown_method_error(request)),
        }
    }
}
