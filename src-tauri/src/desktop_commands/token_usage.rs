use crate::token_usage::{DailyTokenUsageStore, TokenUsageSnapshot};

#[tauri::command]
pub(crate) fn worker_token_usage_snapshot() -> Result<TokenUsageSnapshot, String> {
    DailyTokenUsageStore::global().snapshot()
}
