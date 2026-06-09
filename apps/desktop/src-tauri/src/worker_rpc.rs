use crate::worker_capability::CapabilityPolicy;
use crate::worker_config::WorkerConfigRpc;
use crate::worker_diagnostics::WorkerDiagnosticsRpc;
use crate::worker_protocol::{validate_protocol_version, WorkerRequest, WorkerResponse};
use crate::worker_session::{SessionMetadata, WorkerSessionRpc};
use crate::worker_workspace::WorkerWorkspaceRpc;
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct WorkerRpcRouter {
    workspace: WorkerWorkspaceRpc,
    config: WorkerConfigRpc,
    session: WorkerSessionRpc,
    diagnostics: WorkerDiagnosticsRpc,
}

impl WorkerRpcRouter {
    pub fn new(
        workspace_root: PathBuf,
        config_snapshot: Value,
        sessions: Vec<SessionMetadata>,
        diagnostic_capacity: usize,
        policy: CapabilityPolicy,
    ) -> Self {
        Self {
            workspace: WorkerWorkspaceRpc::new(workspace_root, policy.clone()),
            config: WorkerConfigRpc::new(config_snapshot, policy.clone()),
            session: WorkerSessionRpc::new(sessions, policy.clone()),
            diagnostics: WorkerDiagnosticsRpc::new(diagnostic_capacity, policy),
        }
    }

    pub fn dispatch(&mut self, request: &WorkerRequest) -> WorkerResponse {
        if let Err(error) = validate_protocol_version(&request.protocol_version) {
            return WorkerResponse::failure(request, error);
        }

        match self.dispatch_result(request) {
            Ok(result) => WorkerResponse::success(request, result),
            Err(error) => WorkerResponse::failure(request, error),
        }
    }

    fn dispatch_result(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        match request.method.as_str() {
            "workspace.resolve_path" => {
                let params: PathParams = parse_params(request)?;
                serde_json::to_value(self.workspace.resolve_path(&params.path)?)
                    .map_err(serialization_error)
            }
            "workspace.read_file" => {
                let params: PathParams = parse_params(request)?;
                serde_json::to_value(self.workspace.read_file(&params.path)?)
                    .map_err(serialization_error)
            }
            "workspace.write_file" => {
                let params: WriteFileParams = parse_params(request)?;
                serde_json::to_value(self.workspace.write_file(&params.path, &params.contents)?)
                    .map_err(serialization_error)
            }
            "workspace.list_files" => {
                serde_json::to_value(self.workspace.list_files()?).map_err(serialization_error)
            }
            "config.get" => {
                let params: PathParams = parse_params(request)?;
                serde_json::to_value(self.config.get(&params.path)?).map_err(serialization_error)
            }
            "session.get_metadata" => {
                let params: SessionIdParams = parse_params(request)?;
                serde_json::to_value(self.session.get_metadata(&params.session_id)?)
                    .map_err(serialization_error)
            }
            "session.list_metadata" => {
                serde_json::to_value(self.session.list_metadata()?).map_err(serialization_error)
            }
            "diagnostics.append" => {
                let params: DiagnosticsAppendParams = parse_params(request)?;
                serde_json::to_value(self.diagnostics.append(&params.stream, &params.line)?)
                    .map_err(serialization_error)
            }
            _ => Err(unknown_method_error(request)),
        }
    }
}

#[derive(Deserialize)]
struct PathParams {
    path: String,
}

#[derive(Deserialize)]
struct WriteFileParams {
    path: String,
    contents: String,
}

#[derive(Deserialize)]
struct SessionIdParams {
    session_id: String,
}

#[derive(Deserialize)]
struct DiagnosticsAppendParams {
    stream: String,
    line: String,
}

fn parse_params<T: for<'de> Deserialize<'de>>(
    request: &WorkerRequest,
) -> Result<T, crate::worker_protocol::WorkerProtocolError> {
    serde_json::from_value(request.params.clone()).map_err(|error| {
        crate::worker_protocol::WorkerProtocolError::new(
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol,
            "invalid worker request params",
            serde_json::json!({
                "method": request.method,
                "error": error.to_string(),
            }),
            false,
            crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
        )
    })
}

fn serialization_error(error: serde_json::Error) -> crate::worker_protocol::WorkerProtocolError {
    crate::worker_protocol::WorkerProtocolError::new(
        crate::worker_protocol::WorkerProtocolErrorCode::WorkerError,
        "failed to serialize worker RPC result",
        serde_json::json!({ "error": error.to_string() }),
        false,
        crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
    )
}

fn unknown_method_error(request: &WorkerRequest) -> crate::worker_protocol::WorkerProtocolError {
    crate::worker_protocol::WorkerProtocolError::new(
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol,
        "unknown worker RPC method",
        serde_json::json!({ "method": request.method }),
        false,
        crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
mod tests {
    use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
    use crate::worker_protocol::WorkerRequest;
    use crate::worker_rpc::WorkerRpcRouter;
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn dispatches_workspace_read_file_request() {
        let fixture = WorkspaceFixture::new();
        fixture.write("notes/today.md", "hello router");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "workspace.read_file",
            json!({ "path": "notes/today.md" }),
        );

        let response = router.dispatch(&request);

        assert!(response.matches_request(&request));
        assert!(response.error.is_none());
        assert_eq!(
            response.result,
            Some(json!({ "path": "notes/today.md", "contents": "hello router" }))
        );
    }

    #[test]
    fn dispatch_returns_capability_error_response() {
        let fixture = WorkspaceFixture::new();
        fixture.write("notes/today.md", "hello router");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::default(),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "workspace.read_file",
            json!({ "path": "notes/today.md" }),
        );

        let response = router.dispatch(&request);

        let error = response.error.expect("response should contain error");
        assert_eq!(error.code, crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["capability"], "fs.workspace.read");
        assert!(response.result.is_none());
    }

    #[test]
    fn dispatch_rejects_unknown_method() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );
        let request = WorkerRequest::new("req-1", "trace-1", "shell.execute", json!({}));

        let response = router.dispatch(&request);

        let error = response.error.expect("response should contain error");
        assert_eq!(error.code, crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.details["method"], "shell.execute");
    }

    #[test]
    fn dispatch_rejects_invalid_params() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "workspace.read_file",
            json!({ "missing_path": "notes/today.md" }),
        );

        let response = router.dispatch(&request);

        let error = response.error.expect("response should contain error");
        assert_eq!(error.code, crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.details["method"], "workspace.read_file");
    }

    #[test]
    fn dispatches_config_get_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({ "agents": { "defaults": { "model": "gpt-5" } } }),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::ConfigRead]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "config.get",
            json!({ "path": "agents.defaults.model" }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result,
            Some(json!({ "path": "agents.defaults.model", "value": "gpt-5" }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_session_get_metadata_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session_fixture()],
            20,
            CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "session.get_metadata",
            json!({ "session_id": "session-1" }),
        );

        let response = router.dispatch(&request);

        assert_eq!(response.result.as_ref().unwrap()["session_id"], "session-1");
        assert_eq!(response.result.as_ref().unwrap()["title"], "Native Core Migration");
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_diagnostics_append_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::DiagnosticsWrite]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "diagnostics.append",
            json!({ "stream": "stderr", "line": "worker warning" }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result,
            Some(json!({ "stream": "stderr", "line": "worker warning" }))
        );
        assert!(response.error.is_none());
    }

    fn session_fixture() -> crate::worker_session::SessionMetadata {
        crate::worker_session::SessionMetadata {
            session_id: "session-1".to_string(),
            title: "Native Core Migration".to_string(),
            workspace_dir: "D:/code/tinybot/tinybot".to_string(),
            created_at: "2026-06-09T09:00:00Z".to_string(),
            updated_at: "2026-06-09T09:30:00Z".to_string(),
            extra: json!({ "mode": "desktop" }),
        }
    }

    struct WorkspaceFixture {
        root: PathBuf,
    }

    impl WorkspaceFixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "tinybot-worker-rpc-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock should be after unix epoch")
                    .as_nanos()
            ));
            std::fs::create_dir_all(&root).expect("workspace fixture should create");
            Self { root }
        }

        fn write(&self, relative_path: &str, contents: &str) {
            let path = self.root.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("fixture parent should create");
            }
            std::fs::write(path, contents).expect("fixture file should write");
        }
    }

    impl Drop for WorkspaceFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}
