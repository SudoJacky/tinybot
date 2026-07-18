use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct WorkerSessionRpc {
    sessions: Vec<SessionMetadata>,
    policy: CapabilityPolicy,
    resource_path: Option<PathBuf>,
}

mod resource_store;
mod temporary_file;
mod types;

pub use self::types::*;
