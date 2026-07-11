use std::{path::PathBuf, time::Duration};

use crate::worker_manager::{WorkerCommandSpec, WorkerManager, WorkerManagerState};
use crate::worker_protocol::WorkerRequest;
use crate::{experimental_worker_router, lock_runtime, SharedGateway};

#[derive(Clone)]
pub(crate) struct WorkerClient {
    worker: WorkerManager,
}

impl WorkerClient {
    pub(crate) fn experimental_fixture(
        shared: &SharedGateway,
        workspace_root: PathBuf,
        config_snapshot: serde_json::Value,
    ) -> Result<Self, String> {
        let worker = {
            let runtime = lock_runtime(shared);
            runtime.experimental_worker.clone()
        };
        let client = Self { worker };
        client.ensure_fixture_running(workspace_root, config_snapshot)?;
        Ok(client)
    }

    pub(crate) fn call(
        &self,
        request: &WorkerRequest,
        timeout: Duration,
        context: &str,
    ) -> Result<serde_json::Value, String> {
        let response = self
            .worker
            .send_stdio_request(request, timeout)
            .map_err(|error| format!("{context} request failed: {}", error.message))?;
        if let Some(error) = response.error {
            return Err(format!("{context} returned error: {}", error.message));
        }
        response
            .result
            .ok_or_else(|| format!("{context} response missing result"))
    }

    fn ensure_fixture_running(
        &self,
        workspace_root: PathBuf,
        config_snapshot: serde_json::Value,
    ) -> Result<(), String> {
        if self.worker.status().state == WorkerManagerState::Running {
            return Ok(());
        }
        self.worker
            .start_stdio_rpc(
                stdio_worker_fixture_command_spec(),
                experimental_worker_router(workspace_root, config_snapshot),
            )
            .map_err(|error| format!("failed to start TS worker fixture: {error:?}"))
    }
}

fn stdio_worker_fixture_command_spec() -> WorkerCommandSpec {
    let desktop_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should have repo parent")
        .to_path_buf();
    WorkerCommandSpec::new(
        "node",
        ["workers/ts-worker-fixture/src/index.ts"],
        desktop_dir,
    )
    .with_label("ts-worker-fixture")
}
