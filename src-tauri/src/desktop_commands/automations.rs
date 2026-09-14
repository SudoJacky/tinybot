use crate::agent::bridge::desktop_agent_event_sink;
use crate::automation::{
    execution,
    saved::{Definition, Run, SaveDefinition, Snapshot, Store},
};
use crate::config::application::{native_backend_workspace_root, native_runtime_config_snapshot};
use crate::desktop::{lock_runtime, SharedNativeRuntime};
use tauri::{AppHandle, State};

fn store(state: &SharedNativeRuntime) -> Store {
    Store::new(lock_runtime(state).thread_store.data_root())
}

#[tauri::command]
pub(crate) fn worker_automations_list(
    state: State<'_, SharedNativeRuntime>,
) -> Result<Snapshot, String> {
    let threads = lock_runtime(state.inner()).thread_store.clone();
    execution::snapshot(&store(state.inner()), &threads)
}
#[tauri::command]
pub(crate) fn worker_automation_output(
    id: String,
    state: State<'_, SharedNativeRuntime>,
) -> Result<String, String> {
    let threads = lock_runtime(state.inner()).thread_store.clone();
    execution::output(&store(state.inner()), &threads, &id)
}
#[tauri::command]
pub(crate) fn worker_automation_save(
    input: SaveDefinition,
    state: State<'_, SharedNativeRuntime>,
) -> Result<Definition, String> {
    let threads = lock_runtime(state.inner()).thread_store.clone();
    execution::save(
        &store(state.inner()),
        &threads,
        &native_runtime_config_snapshot(),
        input,
    )
}
#[tauri::command]
pub(crate) fn worker_automation_delete(
    id: String,
    expected_revision: u64,
    state: State<'_, SharedNativeRuntime>,
) -> Result<(), String> {
    store(state.inner()).delete(&id, expected_revision)
}
#[tauri::command]
pub(crate) async fn worker_automation_run(
    id: String,
    app: AppHandle,
    state: State<'_, SharedNativeRuntime>,
) -> Result<Run, String> {
    let store = store(state.inner());
    let config = native_runtime_config_snapshot();
    let definition = store
        .snapshot()?
        .definitions
        .into_iter()
        .find(|d| d.id == id)
        .ok_or("Automation no longer exists")?;
    execution::validate_thread(
        &definition.execution,
        &definition.workspace_path,
        &lock_runtime(state.inner()).thread_store,
    )?;
    let run = execution::prepare(&store, &id, &config)?;
    dispatch(store, run.clone(), app, state.inner(), config);
    Ok(run)
}

fn dispatch(
    store: Store,
    running: Run,
    app: AppHandle,
    state: &SharedNativeRuntime,
    config: serde_json::Value,
) {
    let services = lock_runtime(state).native_agent_services();
    let sink = desktop_agent_event_sink(app);
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn(execution::execute(
            store.clone(),
            running.clone(),
            services,
            native_backend_workspace_root(),
            config,
            Some(sink),
        ))
        .await;
        let error = match result {
            Ok(Ok(())) => return,
            Ok(Err(e)) => e,
            Err(e) => e.to_string(),
        };
        eprintln!("automation_run_failed run_id={} error={error}", running.id);
        if let Err(error) = store.fail(&running.id, error) {
            eprintln!(
                "automation_run_persistence_failed run_id={} error={error}",
                running.id
            );
        }
    });
}

pub(crate) fn start_scheduler(app: AppHandle, state: SharedNativeRuntime) {
    tauri::async_runtime::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(5));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            if !lock_runtime(&state).lifecycle_status.startup_reconciled {
                continue;
            }
            let result = schedule_tick(&app, &state);
            if let Err(error) = result {
                crate::desktop::state::push_log(
                    &state,
                    &format!("automation_scheduler_failed error={error}"),
                );
            }
        }
    });
}

fn schedule_tick(app: &AppHandle, state: &SharedNativeRuntime) -> Result<(), String> {
    let store = store(state);
    let threads = lock_runtime(state).thread_store.clone();
    execution::snapshot(&store, &threads)?;
    for mut run in store.claim_due(crate::automation::saved::now())? {
        let config = native_runtime_config_snapshot();
        let prepared = execution::validate_thread(
            &run.definition.execution,
            &run.definition.workspace_path,
            &threads,
        )
        .and_then(|()| {
            execution::effective_model(
                &run.definition.execution,
                &run.definition.workspace_path,
                &config,
            )
        });
        match prepared {
            Ok(model) => {
                run.effective_model = model;
                store.update(&run)?;
                crate::desktop::state::push_log(
                    state,
                    &format!(
                        "automation_schedule_dispatched automation_id={} run_id={}",
                        run.definition.id, run.id
                    ),
                );
                dispatch(store.clone(), run, app.clone(), state, config);
            }
            Err(error) => {
                crate::desktop::state::push_log(
                    state,
                    &format!(
                        "automation_schedule_failed automation_id={} run_id={} error={error}",
                        run.definition.id, run.id
                    ),
                );
                store.fail(&run.id, error)?;
            }
        }
    }
    Ok(())
}
