#![cfg_attr(test, allow(dead_code, unused_imports))]

mod model;
mod runtime;
mod store;

pub(crate) use self::runtime::{schedule_turn_extraction, start_workspace_runtime};
pub(crate) use self::store::{normalized_workspace_path, MemoryStore};

use serde::{Deserialize, Serialize};

pub(crate) const MEMORY_SNAPSHOT_MAX_CHARS: usize = 12_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MemoryScope {
    User,
    Workspace,
}

impl MemoryScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Workspace => "workspace",
        }
    }

    fn from_db(value: &str) -> Result<Self, String> {
        match value {
            "user" => Ok(Self::User),
            "workspace" => Ok(Self::Workspace),
            other => Err(format!("unsupported memory scope `{other}`")),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MemoryRecord {
    pub(crate) id: i64,
    pub(crate) scope: MemoryScope,
    pub(crate) path: Option<String>,
    pub(crate) content: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
pub(crate) struct ExtractedMemory {
    pub(crate) scope: MemoryScope,
    pub(crate) content: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Phase2Input {
    pub(crate) watermark: i64,
    pub(crate) through_fragment_id: i64,
    pub(crate) active: Vec<MemoryRecord>,
    pub(crate) fragments: Vec<MemoryRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
pub(crate) struct SelectionDiff {
    #[serde(default)]
    pub(crate) add: Vec<SelectionAdd>,
    #[serde(default)]
    pub(crate) update: Vec<SelectionUpdate>,
    #[serde(default)]
    pub(crate) remove: Vec<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
pub(crate) struct SelectionAdd {
    pub(crate) scope: MemoryScope,
    #[serde(default)]
    pub(crate) path: Option<String>,
    pub(crate) content: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
pub(crate) struct SelectionUpdate {
    pub(crate) id: i64,
    pub(crate) content: String,
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
