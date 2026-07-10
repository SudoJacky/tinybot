use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const BOOTSTRAP_FILES: &[&str] = &["AGENTS.md", "SOUL.md", "SYSTEM.md", "USER.md", "TOOLS.md"];
const DEFAULT_READ_LIMIT: usize = 2000;
const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".codegraph",
    "node_modules",
    "target",
    "dist",
    "build",
];

#[derive(Clone, Debug)]
pub struct WorkerWorkspaceRpc {
    root: PathBuf,
    builtin_skills_root: PathBuf,
    policy: CapabilityPolicy,
}

include!("worker_workspace/path_guard.rs");
include!("worker_workspace/read.rs");
include!("worker_workspace/skills.rs");
include!("worker_workspace/write.rs");
include!("worker_workspace/types.rs");
include!("worker_workspace/tests.rs");
