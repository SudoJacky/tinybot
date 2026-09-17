use crate::token_usage::{DailyTokenUsageStore, TokenUsageSnapshot};

#[tauri::command]
pub(crate) fn worker_token_usage_snapshot() -> Result<TokenUsageSnapshot, String> {
    DailyTokenUsageStore::global().snapshot()
}

#[tauri::command]
pub(crate) fn worker_token_usage_details(
    team_run_id: Option<String>,
    before: Option<i64>,
) -> Result<crate::token_usage::UsageDetails, String> {
    DailyTokenUsageStore::global().details(team_run_id.as_deref(), before)
}
