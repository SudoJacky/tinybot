use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug)]
pub struct WorkerSessionRpc {
    sessions: Vec<SessionMetadata>,
    policy: CapabilityPolicy,
    sqlite_path: Option<PathBuf>,
}

mod agent_run;
mod checkpoint;
mod common;
mod history;
mod history_helpers;
mod metadata;
mod metadata_helpers;
mod profile;
mod task_progress;
mod task_progress_helpers;
mod temporary_file;
#[cfg(test)]
mod tests;
mod turn_persistence;
mod types;

use self::agent_run::*;
use self::common::*;
use self::history_helpers::*;
use self::metadata_helpers::*;
use self::task_progress_helpers::*;
pub use self::types::*;
