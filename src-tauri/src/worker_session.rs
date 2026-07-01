use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug)]
pub struct WorkerSessionRpc {
    sessions: Vec<SessionMetadata>,
    policy: CapabilityPolicy,
    store_path: Option<PathBuf>,
}

include!("worker_session/metadata.rs");
include!("worker_session/checkpoint.rs");
include!("worker_session/history.rs");
include!("worker_session/profile.rs");
include!("worker_session/temporary_file.rs");
include!("worker_session/turn_persistence.rs");
include!("worker_session/task_progress.rs");

include!("worker_session/types.rs");
include!("worker_session/agent_run.rs");
include!("worker_session/metadata_helpers.rs");
include!("worker_session/history_helpers.rs");
include!("worker_session/task_progress_helpers.rs");
include!("worker_session/common.rs");
include!("worker_session/tests.rs");
