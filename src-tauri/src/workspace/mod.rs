use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
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

mod patch;
mod path_guard;
mod read;
mod skills;
#[cfg(test)]
mod tests;
mod types;
mod write;

use self::path_guard::*;
use self::read::*;
pub(crate) use self::skills::discover_skill_entries;
pub use self::types::*;
