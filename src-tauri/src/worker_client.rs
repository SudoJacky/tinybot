use std::{path::PathBuf, time::Duration};

use crate::worker_manager::WorkerManager;
use crate::worker_protocol::WorkerRequest;
use crate::{ensure_experimental_fixture_worker_running, lock_runtime, SharedGateway};

#[derive(Clone)]
pub(crate) struct WorkerClient {
    worker: WorkerManager,
}

impl WorkerClient {
    pub(crate) fn experimental(shared: &SharedGateway) -> Self {
        let worker = {
            let runtime = lock_runtime(shared);
            runtime.experimental_worker.clone()
        };
        Self { worker }
    }

    pub(crate) fn ensure_experimental_fixture_running(
        &self,
        workspace_root: PathBuf,
        config_snapshot: serde_json::Value,
    ) -> Result<(), String> {
        ensure_experimental_fixture_worker_running(&self.worker, workspace_root, config_snapshot)
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
}
