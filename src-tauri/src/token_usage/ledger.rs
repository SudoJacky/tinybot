use super::*;
use serde::Deserialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageGroup {
    pub date: String,
    pub provider_id: String,
    pub model_id: String,
    pub purpose: String,
    pub team_run_id: Option<String>,
    pub task_id: Option<String>,
    pub attempt_id: Option<String>,
    pub calls: u64,
    pub reported_calls: u64,
    pub failed_calls: u64,
    pub pending_calls: u64,
    pub retry_calls: u64,
    pub usage: Option<TokenUsage>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageInvocation {
    pub sequence: Option<i64>,
    pub id: String,
    pub request_id: String,
    pub attempt: u32,
    pub date: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub provider_id: String,
    pub model_id: String,
    pub origin: UsageOrigin,
    pub status: String,
    pub usage: Option<TokenUsage>,
}

pub(super) fn initialize(connection: &Connection) -> Result<(), String> {
    // One migration transaction freezes unattributed historical totals once.
    // Calls written by this version are never included in that baseline.
    connection.execute_batch("BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS usage_ledger_migrations (version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS usage_legacy AS SELECT * FROM daily_model_token_usage WHERE 0;
        INSERT INTO usage_legacy SELECT * FROM daily_model_token_usage
            WHERE NOT EXISTS (SELECT 1 FROM usage_ledger_migrations WHERE version=3);
        INSERT OR IGNORE INTO usage_ledger_migrations VALUES (3);
        CREATE TABLE IF NOT EXISTS usage_invocations (
            id TEXT PRIMARY KEY, request_id TEXT NOT NULL, attempt INTEGER NOT NULL,
            usage_date TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
            provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
            purpose TEXT NOT NULL, team_run_id TEXT, task_id TEXT, attempt_id TEXT,
            thread_id TEXT, turn_id TEXT, status TEXT NOT NULL,
            input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER,
            reasoning_output_tokens INTEGER, total_tokens INTEGER,
            UNIQUE(request_id, attempt)
        );
        CREATE INDEX IF NOT EXISTS usage_invocations_team ON usage_invocations(team_run_id, task_id);
        CREATE INDEX IF NOT EXISTS usage_invocations_date ON usage_invocations(usage_date, purpose);
        COMMIT;") .map_err(|e| token_usage_db_error("initialize invocation ledger", e))
}

impl DailyTokenUsageStore {
    pub(crate) fn begin_invocation(&self, call: &UsageInvocation) -> Result<(), String> {
        let purpose = serde_json::to_value(&call.origin.purpose).map_err(|e| e.to_string())?;
        self.open()?.execute("INSERT INTO usage_invocations
            (id,request_id,attempt,usage_date,started_at,provider_id,model_id,purpose,team_run_id,task_id,attempt_id,thread_id,turn_id,status)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'pending')",
            params![call.id,call.request_id,call.attempt,call.date,call.started_at,call.provider_id,call.model_id,
                purpose.as_str(),call.origin.team_run_id,call.origin.task_id,call.origin.attempt_id,
                call.origin.thread_id,call.origin.turn_id])
            .map_err(|e| token_usage_db_error("begin invocation", e))?;
        Ok(())
    }

    pub(crate) fn finish_invocation(
        &self,
        id: &str,
        status: &str,
        model: Option<&str>,
        usage: Option<&TokenUsage>,
    ) -> Result<(), String> {
        let mut connection = self.open()?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| token_usage_db_error("begin completion", e))?;
        let (date, provider, requested_model, previous): (String, String, String, String) = tx
            .query_row(
                "SELECT usage_date,provider_id,model_id,status FROM usage_invocations WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|e| token_usage_db_error("read invocation", e))?;
        if previous != "pending" {
            // Repeated delivery cannot add tokens twice, but conflicting delivery is an error.
            let saved: Option<String> = tx.query_row("SELECT CASE WHEN total_tokens IS NULL THEN NULL ELSE json_array(input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens,total_tokens) END FROM usage_invocations WHERE id=?1", [id], |r| r.get(0)).map_err(|e| e.to_string())?;
            let incoming = usage.map(|u| {
                serde_json::json!([
                    u.input_tokens,
                    u.cached_input_tokens,
                    u.output_tokens,
                    u.reasoning_output_tokens,
                    u.total_tokens
                ])
                .to_string()
            });
            if previous != status
                || saved != incoming
                || model.is_some_and(|m| m != requested_model)
            {
                return Err(format!("Conflicting completion for usage invocation {id}"));
            }
            return Ok(());
        }
        let model = model.unwrap_or(&requested_model);
        if let Some(u) = usage {
            record_usage(&tx, id, &date, &provider, model, u)?;
        }
        tx.execute("UPDATE usage_invocations SET status=?2,model_id=?3,finished_at=?4,
            input_tokens=?5,cached_input_tokens=?6,output_tokens=?7,reasoning_output_tokens=?8,total_tokens=?9 WHERE id=?1",
            params![id,status,model,chrono::Utc::now().to_rfc3339(),usage.map(|u|u.input_tokens),
                usage.map(|u|u.cached_input_tokens),usage.map(|u|u.output_tokens),
                usage.map(|u|u.reasoning_output_tokens),usage.map(|u|u.total_tokens)])
            .map_err(|e| token_usage_db_error("finish invocation",e))?;
        tx.commit()
            .map_err(|e| token_usage_db_error("commit invocation", e))
    }

    pub(super) fn invocations(
        connection: &Connection,
        team_run_id: Option<&str>,
        before: Option<i64>,
    ) -> Result<Vec<UsageInvocation>, String> {
        let mut statement = connection.prepare("SELECT id,request_id,attempt,usage_date,started_at,finished_at,provider_id,model_id,purpose,team_run_id,task_id,attempt_id,thread_id,turn_id,status,input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,rowid FROM usage_invocations WHERE (?1 IS NULL OR team_run_id=?1) AND (?2 IS NULL OR rowid<?2) ORDER BY rowid DESC LIMIT 100")
            .map_err(|e| token_usage_db_error("prepare invocation history",e))?;
        let rows = statement
            .query_map(params![team_run_id, before], |r| {
                let purpose: String = r.get(8)?;
                let purpose = serde_json::from_value(Value::String(purpose)).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        8,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                Ok(UsageInvocation {
                    sequence: r.get(20)?,
                    id: r.get(0)?,
                    request_id: r.get(1)?,
                    attempt: r.get(2)?,
                    date: r.get(3)?,
                    started_at: r.get(4)?,
                    finished_at: r.get(5)?,
                    provider_id: r.get(6)?,
                    model_id: r.get(7)?,
                    origin: UsageOrigin {
                        purpose,
                        team_run_id: r.get(9)?,
                        task_id: r.get(10)?,
                        attempt_id: r.get(11)?,
                        thread_id: r.get(12)?,
                        turn_id: r.get(13)?,
                    },
                    status: r.get(14)?,
                    usage: usage_row(r, 15)?,
                })
            })
            .map_err(|e| token_usage_db_error("query invocation history", e))?;
        rows.collect::<Result<_, _>>()
            .map_err(|e| token_usage_db_error("read invocation history", e))
    }
}

fn usage_row(row: &rusqlite::Row<'_>, start: usize) -> rusqlite::Result<Option<TokenUsage>> {
    let Some(input_tokens) = row.get::<_, Option<i64>>(start)? else {
        return Ok(None);
    };
    Ok(Some(TokenUsage {
        input_tokens,
        cached_input_tokens: row.get(start + 1)?,
        output_tokens: row.get(start + 2)?,
        reasoning_output_tokens: row.get(start + 3)?,
        total_tokens: row.get(start + 4)?,
    }))
}

pub(super) fn groups(
    connection: &Connection,
    team_run_id: Option<&str>,
) -> Result<Vec<UsageGroup>, String> {
    let mut statement = connection.prepare("SELECT usage_date,provider_id,model_id,purpose,team_run_id,task_id,attempt_id,
        COUNT(*),COUNT(total_tokens),SUM(status NOT IN ('pending','completed')),SUM(status='pending'),SUM(attempt>0),
        SUM(input_tokens),SUM(cached_input_tokens),SUM(output_tokens),SUM(reasoning_output_tokens),SUM(total_tokens)
        FROM usage_invocations WHERE (?1 IS NULL OR team_run_id=?1) GROUP BY usage_date,provider_id,model_id,purpose,team_run_id,task_id,attempt_id
        UNION ALL SELECT usage_date,provider_id,model_id,'legacy',NULL,NULL,NULL,0,0,0,0,0,
        input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens,total_tokens FROM usage_legacy WHERE ?1 IS NULL
        ORDER BY 1 DESC,2,3,4") .map_err(|e|token_usage_db_error("prepare usage groups",e))?;
    let rows = statement
        .query_map([team_run_id], |r| {
            Ok(UsageGroup {
                date: r.get(0)?,
                provider_id: r.get(1)?,
                model_id: r.get(2)?,
                purpose: r.get(3)?,
                team_run_id: r.get(4)?,
                task_id: r.get(5)?,
                attempt_id: r.get(6)?,
                calls: r.get(7)?,
                reported_calls: r.get(8)?,
                failed_calls: r.get(9)?,
                pending_calls: r.get(10)?,
                retry_calls: r.get(11)?,
                usage: usage_row(r, 12)?,
            })
        })
        .map_err(|e| token_usage_db_error("query usage groups", e))?;
    rows.collect::<Result<_, _>>()
        .map_err(|e| token_usage_db_error("read usage groups", e))
}
