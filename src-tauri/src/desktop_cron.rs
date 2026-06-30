use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use tauri::State;

use crate::worker_protocol::WorkerRequest;
use crate::{
    experimental_worker_config_snapshot, experimental_worker_router, lock_runtime,
    native_backend_workspace_root, now_unix_ms, push_log, SharedGateway,
    WORKER_CRON_TIMER_MAX_POLL,
};

#[tauri::command]
pub(crate) fn worker_cron_dispatch_due(
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_cron_dispatch_due_with_options(
        state.inner(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        now_unix_ms() as i64,
        Duration::from_secs(120),
    )
}

pub(crate) fn worker_cron_dispatch_due_with_options(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    now_ms: i64,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let Some(_dispatch_guard) = CronDispatchGuard::begin(shared) else {
        return Ok(serde_json::json!({
            "dispatched": 0,
            "records": [],
            "recorded": { "updated": [], "deleted": [], "missing": [] },
            "skipped": "already_running"
        }));
    };

    let mut router = experimental_worker_router(workspace_root.clone(), config_snapshot.clone());
    let due_response = router.dispatch(&WorkerRequest::new(
        format!("cron-due-{now_ms}"),
        format!("trace-cron-due-{now_ms}"),
        "cron.job.due",
        serde_json::json!({ "now_ms": now_ms }),
    ));
    if let Some(error) = due_response.error {
        return Err(format!("native cron due returned error: {}", error.message));
    }
    let jobs = due_response
        .result
        .as_ref()
        .and_then(|result| result.get("jobs"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let dispatched = jobs.as_array().map_or(0, Vec::len);
    if dispatched == 0 {
        return Ok(serde_json::json!({
            "dispatched": 0,
            "records": [],
            "recorded": { "updated": [], "deleted": [], "missing": [] }
        }));
    }

    let _ = jobs;
    Err(
        "worker_cron_dispatch_due is unsupported in the Rust-only backend when jobs are due"
            .to_string(),
    )
}

pub(crate) fn worker_cron_next_wake_delay_with_options(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    now_ms: i64,
    max_poll: Duration,
) -> Result<Duration, String> {
    let mut router = experimental_worker_router(workspace_root, config_snapshot);
    let response = router.dispatch(&WorkerRequest::new(
        format!("cron-next-wake-{now_ms}"),
        format!("trace-cron-next-wake-{now_ms}"),
        "cron.job.list",
        serde_json::json!({}),
    ));
    if let Some(error) = response.error {
        return Err(format!(
            "native cron list returned error: {}",
            error.message
        ));
    }
    let jobs = response
        .result
        .as_ref()
        .and_then(|result| result.get("jobs"))
        .and_then(serde_json::Value::as_array);
    let Some(next_run_at_ms) = jobs.and_then(|jobs| {
        jobs.iter()
            .filter(|job| {
                job.get("enabled")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true)
            })
            .filter_map(|job| {
                job.pointer("/state/nextRunAtMs")
                    .and_then(serde_json::Value::as_i64)
            })
            .min()
    }) else {
        return Ok(max_poll);
    };
    if next_run_at_ms <= now_ms {
        return Ok(Duration::ZERO);
    }
    Ok(Duration::from_millis((next_run_at_ms - now_ms) as u64).min(max_poll))
}

struct CronDispatchGuard {
    running: Arc<AtomicBool>,
}

impl CronDispatchGuard {
    fn begin(shared: &SharedGateway) -> Option<Self> {
        let running = {
            let runtime = lock_runtime(shared);
            runtime.cron_dispatch_running.clone()
        };
        running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()?;
        Some(Self { running })
    }
}

impl Drop for CronDispatchGuard {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

pub(crate) fn start_worker_cron_timer(shared: &SharedGateway) -> bool {
    let (started, stop) = {
        let runtime = lock_runtime(shared);
        (
            runtime.cron_timer_started.clone(),
            runtime.cron_timer_stop.clone(),
        )
    };
    if started
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }
    stop.store(false, Ordering::SeqCst);
    let timer_shared = shared.clone();
    let log_shared = shared.clone();
    let builder = thread::Builder::new().name("tinybot-cron-timer".to_string());
    match builder.spawn(move || worker_cron_timer_loop(timer_shared, stop, started)) {
        Ok(_handle) => true,
        Err(error) => {
            log_shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .cron_timer_started
                .store(false, Ordering::SeqCst);
            push_log(
                &log_shared,
                &format!("failed to start native cron timer: {error}"),
            );
            false
        }
    }
}

pub(crate) fn stop_worker_cron_timer(shared: &SharedGateway) {
    let stop = {
        let runtime = lock_runtime(shared);
        runtime.cron_timer_stop.clone()
    };
    stop.store(true, Ordering::SeqCst);
}

fn worker_cron_timer_loop(shared: SharedGateway, stop: Arc<AtomicBool>, started: Arc<AtomicBool>) {
    while !stop.load(Ordering::SeqCst) {
        let delay = worker_cron_next_wake_delay_with_options(
            native_backend_workspace_root(),
            experimental_worker_config_snapshot(),
            now_unix_ms() as i64,
            WORKER_CRON_TIMER_MAX_POLL,
        )
        .unwrap_or(WORKER_CRON_TIMER_MAX_POLL);
        if sleep_cron_timer_or_stopped(delay, &stop) {
            break;
        }
        match worker_cron_dispatch_due_with_options(
            &shared,
            native_backend_workspace_root(),
            experimental_worker_config_snapshot(),
            now_unix_ms() as i64,
            Duration::from_secs(120),
        ) {
            Ok(result)
                if result.get("dispatched").and_then(serde_json::Value::as_u64) != Some(0) =>
            {
                push_log(
                    &shared,
                    &format!("native cron dispatched due jobs: {result}"),
                );
            }
            Ok(_) => {}
            Err(error) => push_log(&shared, &format!("native cron dispatch failed: {error}")),
        }
    }
    started.store(false, Ordering::SeqCst);
}

fn sleep_cron_timer_or_stopped(delay: Duration, stop: &AtomicBool) -> bool {
    let mut remaining = delay;
    while !remaining.is_zero() {
        if stop.load(Ordering::SeqCst) {
            return true;
        }
        let chunk = remaining.min(Duration::from_millis(250));
        thread::sleep(chunk);
        remaining = remaining.saturating_sub(chunk);
    }
    stop.load(Ordering::SeqCst)
}

#[cfg(test)]
pub(crate) fn cron_model_from_config(config_snapshot: &serde_json::Value) -> String {
    config_snapshot
        .pointer("/agents/defaults/model")
        .and_then(serde_json::Value::as_str)
        .filter(|model| !model.trim().is_empty())
        .unwrap_or("deepseek-reasoner")
        .to_string()
}
