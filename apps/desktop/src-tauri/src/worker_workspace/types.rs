#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct WorkspaceResolvedPath {
    pub relative_path: String,
    pub absolute_path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceFileContent {
    pub path: String,
    pub contents: String,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub enum WorkspaceReadFormat {
    Raw,
    NumberedLines,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceReadOptions {
    pub offset: Option<usize>,
    pub limit: Option<usize>,
    pub format: WorkspaceReadFormat,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceReadFileResult {
    pub path: String,
    pub contents: String,
    pub content: String,
    pub updated_at: Option<String>,
    pub content_type: String,
    pub line_start: Option<usize>,
    pub line_end: Option<usize>,
    pub line_total: Option<usize>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceFileEntry {
    pub path: String,
    pub size_bytes: u64,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceDirectoryEntry {
    pub path: String,
    pub kind: String,
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceDirectoryListing {
    pub path: String,
    pub entries: Vec<WorkspaceDirectoryEntry>,
    pub total_entries: usize,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceBootstrapFiles {
    pub files: Vec<WorkspaceFileContent>,
    pub missing: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceSkillEntry {
    pub name: String,
    pub path: String,
    pub source: String,
    pub content: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceSkillsList {
    pub skills: Vec<WorkspaceSkillEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceWriteResult {
    pub path: String,
    pub bytes_written: u64,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceCreateDirResult {
    pub path: String,
    pub kind: String,
    pub created: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceDeleteResult {
    pub path: String,
    pub kind: String,
    pub deleted: bool,
}
