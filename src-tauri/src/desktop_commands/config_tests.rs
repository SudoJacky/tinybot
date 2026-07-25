use super::*;

#[test]
fn config_application_error_maps_to_structured_ipc_payload() {
    let config_path = PathBuf::from("fixture-config.json");
    let ipc_error = ConfigIpcError::from(ConfigApplicationError {
        code: ConfigApplicationErrorCode::ApplyConfigOperations,
        config_path: config_path.clone(),
        message: "fixture failure".to_string(),
    });

    let payload = serde_json::to_value(ipc_error).expect("IPC error should serialize");
    assert_eq!(payload["code"], "apply_config_operations");
    assert_eq!(payload["message"], "fixture failure");
    assert_eq!(
        payload["configPath"],
        config_path.to_string_lossy().as_ref()
    );
}
