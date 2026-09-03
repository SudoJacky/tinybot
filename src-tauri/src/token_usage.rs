use crate::threads::rollout::format::TokenUsage;
use chrono::{Local, NaiveDate};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const TOKEN_USAGE_SCHEMA_VERSION: &str = "tinybot.token_usage.v2";
const UNKNOWN_USAGE_DIMENSION: &str = "unknown";

#[derive(Clone, Debug)]
pub(crate) struct DailyTokenUsageStore {
    database_path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DailyTokenUsage {
    date: String,
    #[serde(flatten)]
    usage: TokenUsage,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DailyModelTokenUsage {
    date: String,
    provider_id: String,
    model_id: String,
    #[serde(flatten)]
    usage: TokenUsage,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TokenUsageSnapshot {
    schema_version: &'static str,
    totals: TokenUsage,
    days: Vec<DailyTokenUsage>,
    model_days: Vec<DailyModelTokenUsage>,
}

impl DailyTokenUsageStore {
    pub(crate) fn global() -> Self {
        Self::from_data_root(&crate::config::application::tinybot_data_root())
    }

    pub(crate) fn from_data_root(data_root: &Path) -> Self {
        Self {
            database_path: data_root.join("state").join("token-usage.sqlite"),
        }
    }

    #[cfg_attr(test, allow(dead_code))]
    pub(crate) fn record_model_call(
        &self,
        model_call_id: &str,
        provider_id: &str,
        model_id: &str,
        usage: &TokenUsage,
    ) -> Result<bool, String> {
        self.record_model_call_on_date(
            model_call_id,
            Local::now().date_naive(),
            provider_id,
            model_id,
            usage,
        )
    }

    fn record_model_call_on_date(
        &self,
        model_call_id: &str,
        date: NaiveDate,
        provider_id: &str,
        model_id: &str,
        usage: &TokenUsage,
    ) -> Result<bool, String> {
        let model_call_id = model_call_id.trim();
        if model_call_id.is_empty() {
            return Err("token usage model call id must be non-empty".to_string());
        }
        let provider_id = usage_dimension(provider_id);
        let model_id = usage_dimension(model_id);
        let usage = non_negative_usage(usage);
        let date = date.format("%Y-%m-%d").to_string();
        let mut connection = self.open()?;
        let transaction = connection
            .transaction()
            .map_err(|error| token_usage_db_error("begin transaction", error))?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO daily_token_usage (
                     usage_date, input_tokens, cached_input_tokens, output_tokens,
                     reasoning_output_tokens, total_tokens
                 ) VALUES (?1, 0, 0, 0, 0, 0)",
                [&date],
            )
            .map_err(|error| token_usage_db_error("ensure daily row", error))?;
        let inserted = transaction
            .execute(
                "INSERT OR IGNORE INTO recorded_token_usage_calls (model_call_id, usage_date)
                 VALUES (?1, ?2)",
                params![model_call_id, date],
            )
            .map_err(|error| token_usage_db_error("record model call", error))?
            == 1;
        if inserted {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO daily_model_token_usage (
                         usage_date, provider_id, model_id, input_tokens, cached_input_tokens,
                         output_tokens, reasoning_output_tokens, total_tokens
                     ) VALUES (?1, ?2, ?3, 0, 0, 0, 0, 0)",
                    params![date, provider_id, model_id],
                )
                .map_err(|error| token_usage_db_error("ensure daily model row", error))?;
            transaction
                .execute(
                    "UPDATE daily_token_usage SET
                         input_tokens = input_tokens + ?2,
                         cached_input_tokens = cached_input_tokens + ?3,
                         output_tokens = output_tokens + ?4,
                         reasoning_output_tokens = reasoning_output_tokens + ?5,
                         total_tokens = total_tokens + ?6
                     WHERE usage_date = ?1",
                    params![
                        date,
                        usage.input_tokens,
                        usage.cached_input_tokens,
                        usage.output_tokens,
                        usage.reasoning_output_tokens,
                        usage.total_tokens,
                    ],
                )
                .map_err(|error| token_usage_db_error("update daily totals", error))?;
            transaction
                .execute(
                    "UPDATE daily_model_token_usage SET
                         input_tokens = input_tokens + ?4,
                         cached_input_tokens = cached_input_tokens + ?5,
                         output_tokens = output_tokens + ?6,
                         reasoning_output_tokens = reasoning_output_tokens + ?7,
                         total_tokens = total_tokens + ?8
                     WHERE usage_date = ?1 AND provider_id = ?2 AND model_id = ?3",
                    params![
                        date,
                        provider_id,
                        model_id,
                        usage.input_tokens,
                        usage.cached_input_tokens,
                        usage.output_tokens,
                        usage.reasoning_output_tokens,
                        usage.total_tokens,
                    ],
                )
                .map_err(|error| token_usage_db_error("update daily model totals", error))?;
        }
        transaction
            .commit()
            .map_err(|error| token_usage_db_error("commit transaction", error))?;
        Ok(inserted)
    }

    pub(crate) fn snapshot(&self) -> Result<TokenUsageSnapshot, String> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT usage_date, input_tokens, cached_input_tokens, output_tokens,
                        reasoning_output_tokens, total_tokens
                 FROM daily_token_usage
                 ORDER BY usage_date DESC",
            )
            .map_err(|error| token_usage_db_error("prepare snapshot", error))?;
        let rows = statement
            .query_map([], |row| {
                Ok(DailyTokenUsage {
                    date: row.get(0)?,
                    usage: TokenUsage {
                        input_tokens: row.get(1)?,
                        cached_input_tokens: row.get(2)?,
                        output_tokens: row.get(3)?,
                        reasoning_output_tokens: row.get(4)?,
                        total_tokens: row.get(5)?,
                    },
                })
            })
            .map_err(|error| token_usage_db_error("query snapshot", error))?;
        let days = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| token_usage_db_error("read snapshot row", error))?;
        let totals = days.iter().fold(TokenUsage::default(), |mut totals, day| {
            totals.input_tokens = totals.input_tokens.saturating_add(day.usage.input_tokens);
            totals.cached_input_tokens = totals
                .cached_input_tokens
                .saturating_add(day.usage.cached_input_tokens);
            totals.output_tokens = totals.output_tokens.saturating_add(day.usage.output_tokens);
            totals.reasoning_output_tokens = totals
                .reasoning_output_tokens
                .saturating_add(day.usage.reasoning_output_tokens);
            totals.total_tokens = totals.total_tokens.saturating_add(day.usage.total_tokens);
            totals
        });
        let mut statement = connection
            .prepare(
                "SELECT usage_date, provider_id, model_id, input_tokens, cached_input_tokens,
                        output_tokens, reasoning_output_tokens, total_tokens
                 FROM daily_model_token_usage
                 ORDER BY usage_date DESC, total_tokens DESC, provider_id, model_id",
            )
            .map_err(|error| token_usage_db_error("prepare model snapshot", error))?;
        let rows = statement
            .query_map([], |row| {
                Ok(DailyModelTokenUsage {
                    date: row.get(0)?,
                    provider_id: row.get(1)?,
                    model_id: row.get(2)?,
                    usage: TokenUsage {
                        input_tokens: row.get(3)?,
                        cached_input_tokens: row.get(4)?,
                        output_tokens: row.get(5)?,
                        reasoning_output_tokens: row.get(6)?,
                        total_tokens: row.get(7)?,
                    },
                })
            })
            .map_err(|error| token_usage_db_error("query model snapshot", error))?;
        let model_days = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| token_usage_db_error("read model snapshot row", error))?;
        Ok(TokenUsageSnapshot {
            schema_version: TOKEN_USAGE_SCHEMA_VERSION,
            totals,
            days,
            model_days,
        })
    }

    fn open(&self) -> Result<Connection, String> {
        let parent = self
            .database_path
            .parent()
            .ok_or_else(|| "token usage database path has no parent directory".to_string())?;
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create token usage database directory `{}`: {error}",
                parent.display()
            )
        })?;
        let connection = Connection::open(&self.database_path).map_err(|error| {
            format!(
                "failed to open token usage database `{}`: {error}",
                self.database_path.display()
            )
        })?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| token_usage_db_error("configure busy timeout", error))?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS daily_token_usage (
                     usage_date             TEXT PRIMARY KEY CHECK (length(usage_date) = 10),
                     input_tokens           INTEGER NOT NULL CHECK (input_tokens >= 0),
                     cached_input_tokens    INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
                     output_tokens          INTEGER NOT NULL CHECK (output_tokens >= 0),
                     reasoning_output_tokens INTEGER NOT NULL CHECK (reasoning_output_tokens >= 0),
                     total_tokens           INTEGER NOT NULL CHECK (total_tokens >= 0)
                 );
                 CREATE TABLE IF NOT EXISTS recorded_token_usage_calls (
                     model_call_id TEXT PRIMARY KEY CHECK (length(trim(model_call_id)) > 0),
                     usage_date    TEXT NOT NULL REFERENCES daily_token_usage(usage_date)
                 );
                 CREATE TABLE IF NOT EXISTS daily_model_token_usage (
                     usage_date              TEXT NOT NULL REFERENCES daily_token_usage(usage_date),
                     provider_id             TEXT NOT NULL CHECK (length(trim(provider_id)) > 0),
                     model_id                TEXT NOT NULL CHECK (length(trim(model_id)) > 0),
                     input_tokens            INTEGER NOT NULL CHECK (input_tokens >= 0),
                     cached_input_tokens     INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
                     output_tokens           INTEGER NOT NULL CHECK (output_tokens >= 0),
                     reasoning_output_tokens INTEGER NOT NULL CHECK (reasoning_output_tokens >= 0),
                     total_tokens            INTEGER NOT NULL CHECK (total_tokens >= 0),
                     PRIMARY KEY (usage_date, provider_id, model_id)
                 );
                 INSERT OR IGNORE INTO daily_model_token_usage (
                     usage_date, provider_id, model_id, input_tokens, cached_input_tokens,
                     output_tokens, reasoning_output_tokens, total_tokens
                 )
                 SELECT usage_date, 'unknown', 'unknown', input_tokens, cached_input_tokens,
                        output_tokens, reasoning_output_tokens, total_tokens
                 FROM daily_token_usage
                 WHERE NOT EXISTS (
                     SELECT 1 FROM daily_model_token_usage AS model_usage
                     WHERE model_usage.usage_date = daily_token_usage.usage_date
                 );",
            )
            .map_err(|error| token_usage_db_error("initialize schema", error))?;
        Ok(connection)
    }
}

/// Maps token counts from either Chat Completions or Responses into the one
/// usage shape stored by TinyBot. `None` means that the provider did not
/// report token usage; it is intentionally different from an explicit zero.
pub(crate) fn normalize_provider_token_usage(usage: &Value) -> Result<Option<TokenUsage>, String> {
    if usage.is_null() {
        return Ok(None);
    }
    usage
        .as_object()
        .ok_or_else(|| "provider usage must be an object".to_string())?;

    let input_tokens = optional_i64_field(
        usage,
        &[
            "inputTokens",
            "input_tokens",
            "promptTokens",
            "prompt_tokens",
        ],
    )?;
    let output_tokens = optional_i64_field(
        usage,
        &[
            "outputTokens",
            "output_tokens",
            "completionTokens",
            "completion_tokens",
        ],
    )?;
    let cached_input_tokens = max_optional(
        optional_i64_field(
            usage,
            &[
                "cachedInputTokens",
                "cached_input_tokens",
                "cachedTokens",
                "cached_tokens",
            ],
        )?,
        optional_detail_i64_field(
            usage,
            &[
                "inputTokensDetails",
                "input_tokens_details",
                "promptTokensDetails",
                "prompt_tokens_details",
            ],
            &[
                "cachedInputTokens",
                "cached_input_tokens",
                "cachedTokens",
                "cached_tokens",
            ],
        )?,
    );
    let reasoning_output_tokens = max_optional(
        optional_i64_field(
            usage,
            &[
                "reasoningOutputTokens",
                "reasoning_output_tokens",
                "reasoningTokens",
                "reasoning_tokens",
            ],
        )?,
        optional_detail_i64_field(
            usage,
            &[
                "outputTokensDetails",
                "output_tokens_details",
                "completionTokensDetails",
                "completion_tokens_details",
            ],
            &[
                "reasoningOutputTokens",
                "reasoning_output_tokens",
                "reasoningTokens",
                "reasoning_tokens",
            ],
        )?,
    );
    let reported_total = optional_i64_field(usage, &["totalTokens", "total_tokens", "total"])?;
    let has_usage = input_tokens.is_some()
        || cached_input_tokens.is_some()
        || output_tokens.is_some()
        || reasoning_output_tokens.is_some()
        || reported_total.is_some();
    if !has_usage {
        return Ok(None);
    }

    let input_tokens = input_tokens.unwrap_or_default();
    let output_tokens = output_tokens.unwrap_or_default();
    Ok(Some(TokenUsage {
        input_tokens,
        cached_input_tokens: cached_input_tokens.unwrap_or_default(),
        output_tokens,
        reasoning_output_tokens: reasoning_output_tokens.unwrap_or_default(),
        total_tokens: reported_total.unwrap_or_else(|| input_tokens.saturating_add(output_tokens)),
    }))
}

fn optional_i64_field(value: &Value, keys: &[&str]) -> Result<Option<i64>, String> {
    for key in keys {
        let Some(value) = value.get(key) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        let number = value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
            .ok_or_else(|| format!("provider usage `{key}` must be an integer"))?;
        if number < 0 {
            return Err(format!("provider usage `{key}` must not be negative"));
        }
        return Ok(Some(number));
    }
    Ok(None)
}

fn optional_detail_i64_field(
    usage: &Value,
    detail_keys: &[&str],
    value_keys: &[&str],
) -> Result<Option<i64>, String> {
    let mut result = None;
    for key in detail_keys {
        let Some(details) = usage.get(key) else {
            continue;
        };
        if details.is_null() {
            continue;
        }
        details
            .as_object()
            .ok_or_else(|| format!("provider usage `{key}` must be an object"))?;
        result = max_optional(result, optional_i64_field(details, value_keys)?);
    }
    Ok(result)
}

fn max_optional(left: Option<i64>, right: Option<i64>) -> Option<i64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn non_negative_usage(usage: &TokenUsage) -> TokenUsage {
    TokenUsage {
        input_tokens: usage.input_tokens.max(0),
        cached_input_tokens: usage.cached_input_tokens.max(0),
        output_tokens: usage.output_tokens.max(0),
        reasoning_output_tokens: usage.reasoning_output_tokens.max(0),
        total_tokens: usage.total_tokens.max(0),
    }
}

fn usage_dimension(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        UNKNOWN_USAGE_DIMENSION.to_string()
    } else {
        value.to_string()
    }
}

fn token_usage_db_error(operation: &str, error: rusqlite::Error) -> String {
    format!("token usage database failed to {operation}: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct UsageFixture {
        root: PathBuf,
        store: DailyTokenUsageStore,
    }

    impl UsageFixture {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let root = std::env::temp_dir().join(format!(
                "tinybot-token-usage-{}-{unique}",
                std::process::id()
            ));
            Self {
                store: DailyTokenUsageStore::from_data_root(&root),
                root,
            }
        }
    }

    impl Drop for UsageFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn aggregates_calls_by_day_and_ignores_duplicate_model_call_ids() {
        let fixture = UsageFixture::new();
        let first_day = NaiveDate::from_ymd_opt(2026, 8, 30).unwrap();
        let second_day = NaiveDate::from_ymd_opt(2026, 8, 31).unwrap();
        let first = TokenUsage {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 30,
            reasoning_output_tokens: 10,
            total_tokens: 130,
        };
        let second = TokenUsage {
            input_tokens: 20,
            cached_input_tokens: 5,
            output_tokens: 8,
            reasoning_output_tokens: 2,
            total_tokens: 28,
        };

        assert!(fixture
            .store
            .record_model_call_on_date("call-1", first_day, "openai", "gpt-5", &first)
            .unwrap());
        assert!(!fixture
            .store
            .record_model_call_on_date("call-1", first_day, "anthropic", "claude", &second)
            .unwrap());
        assert!(fixture
            .store
            .record_model_call_on_date("call-2", first_day, "openai", "gpt-5-mini", &second)
            .unwrap());
        assert!(fixture
            .store
            .record_model_call_on_date("call-3", second_day, "anthropic", "claude", &second)
            .unwrap());

        let snapshot = fixture.store.snapshot().unwrap();
        assert_eq!(snapshot.schema_version, TOKEN_USAGE_SCHEMA_VERSION);
        assert_eq!(snapshot.days.len(), 2);
        assert_eq!(snapshot.days[0].date, "2026-08-31");
        assert_eq!(snapshot.days[0].usage, second);
        assert_eq!(snapshot.days[1].date, "2026-08-30");
        assert_eq!(snapshot.days[1].usage.input_tokens, 120);
        assert_eq!(snapshot.days[1].usage.cached_input_tokens, 45);
        assert_eq!(snapshot.days[1].usage.output_tokens, 38);
        assert_eq!(snapshot.days[1].usage.reasoning_output_tokens, 12);
        assert_eq!(snapshot.days[1].usage.total_tokens, 158);
        assert_eq!(snapshot.totals.input_tokens, 140);
        assert_eq!(snapshot.totals.cached_input_tokens, 50);
        assert_eq!(snapshot.totals.output_tokens, 46);
        assert_eq!(snapshot.totals.reasoning_output_tokens, 14);
        assert_eq!(snapshot.totals.total_tokens, 186);
        assert_eq!(snapshot.model_days.len(), 3);
        assert_eq!(snapshot.model_days[0].provider_id, "anthropic");
        assert_eq!(snapshot.model_days[0].model_id, "claude");
        assert_eq!(snapshot.model_days[1].provider_id, "openai");
        assert_eq!(snapshot.model_days[1].model_id, "gpt-5");
        assert_eq!(snapshot.model_days[1].usage, first);
        assert_eq!(snapshot.model_days[2].model_id, "gpt-5-mini");
        assert_eq!(snapshot.model_days[2].usage, second);
    }

    #[test]
    fn migrates_existing_daily_totals_to_unknown_dimensions() {
        let fixture = UsageFixture::new();
        let connection = fixture.store.open().unwrap();
        connection
            .execute(
                "INSERT INTO daily_token_usage (
                     usage_date, input_tokens, cached_input_tokens, output_tokens,
                     reasoning_output_tokens, total_tokens
                 ) VALUES ('2026-08-29', 90, 40, 20, 5, 110)",
                [],
            )
            .unwrap();
        drop(connection);

        let snapshot = fixture.store.snapshot().unwrap();
        assert_eq!(snapshot.model_days.len(), 1);
        assert_eq!(snapshot.model_days[0].provider_id, UNKNOWN_USAGE_DIMENSION);
        assert_eq!(snapshot.model_days[0].model_id, UNKNOWN_USAGE_DIMENSION);
        assert_eq!(snapshot.model_days[0].usage.total_tokens, 110);
    }

    #[test]
    fn normalizes_responses_usage_details() {
        let usage = normalize_provider_token_usage(&serde_json::json!({
            "input_tokens": 4_469,
            "input_tokens_details": { "cached_tokens": 4_096 },
            "output_tokens": 219,
            "output_tokens_details": { "reasoning_tokens": 47 },
            "total_tokens": 4_688
        }))
        .unwrap()
        .unwrap();

        assert_eq!(usage.input_tokens, 4_469);
        assert_eq!(usage.cached_input_tokens, 4_096);
        assert_eq!(usage.output_tokens, 219);
        assert_eq!(usage.reasoning_output_tokens, 47);
        assert_eq!(usage.total_tokens, 4_688);
    }

    #[test]
    fn normalizes_chat_completions_usage_details() {
        let usage = normalize_provider_token_usage(&serde_json::json!({
            "prompt_tokens": 1_200,
            "prompt_tokens_details": { "cached_tokens": 900 },
            "completion_tokens": 80,
            "completion_tokens_details": { "reasoning_tokens": 30 },
            "total_tokens": 1_280
        }))
        .unwrap()
        .unwrap();

        assert_eq!(usage.input_tokens, 1_200);
        assert_eq!(usage.cached_input_tokens, 900);
        assert_eq!(usage.output_tokens, 80);
        assert_eq!(usage.reasoning_output_tokens, 30);
        assert_eq!(usage.total_tokens, 1_280);
    }

    #[test]
    fn distinguishes_missing_usage_from_explicit_zero() {
        assert_eq!(normalize_provider_token_usage(&Value::Null).unwrap(), None);
        assert_eq!(
            normalize_provider_token_usage(&serde_json::json!({})).unwrap(),
            None
        );
        assert_eq!(
            normalize_provider_token_usage(&serde_json::json!({
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0
            }))
            .unwrap()
            .unwrap(),
            TokenUsage::default()
        );
    }

    #[test]
    fn rejects_invalid_provider_usage_numbers() {
        let error = normalize_provider_token_usage(&serde_json::json!({
            "input_tokens": "100"
        }))
        .unwrap_err();

        assert_eq!(error, "provider usage `input_tokens` must be an integer");
    }

    #[test]
    fn infers_total_only_when_provider_omits_it() {
        let usage = normalize_provider_token_usage(&serde_json::json!({
            "input_tokens": 10,
            "output_tokens": 3
        }))
        .unwrap()
        .unwrap();

        assert_eq!(usage.total_tokens, 13);
    }
}
