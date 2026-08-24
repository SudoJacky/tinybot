#[cfg(windows)]
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::path::PathBuf;
#[cfg(windows)]
use tauri::Emitter;
#[cfg(windows)]
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
    },
    WebMessageReceivedEventHandler,
};
#[cfg(windows)]
use windows::core::{Interface, PWSTR};

#[cfg(windows)]
const DROP_SIGNAL_COMMAND: &str = "desktop_pet_drop_signal";
#[cfg(windows)]
const FILE_DROP_RESULT_EVENT: &str = "desktop-pet-file-drop-result";
#[cfg(windows)]
const FILE_DROP_SCHEMA_VERSION: &str = "tinybot.desktop_pet_file_drop.v1";
#[cfg(windows)]
const MAX_DROPPED_FILES: u32 = 10;
#[cfg(windows)]
const INITIALIZATION_SCRIPT: &str = r#"
;(() => {
  const invokeKey = __TINYBOT_INVOKE_KEY__;
  Object.defineProperty(window, '__TINYBOT_DESKTOP_PET_POST_DROPPED_FILES__', {
    value: (requestId, files) => new Promise((resolve, reject) => {
      const additionalObjects = Array.from(files || []);
      if (!requestId || !additionalObjects.length || !additionalObjects.every((file) => file instanceof File)) {
        reject(new Error('Desktop pet file-drop bridge received invalid input.'));
        return;
      }
      const internals = window.__TAURI_INTERNALS__;
      let callback;
      let error;
      callback = internals.transformCallback((value) => {
        internals.unregisterCallback(error);
        resolve(value);
      }, true);
      error = internals.transformCallback((value) => {
        internals.unregisterCallback(callback);
        const message = typeof value === 'string' ? value : JSON.stringify(value) || String(value);
        reject(new Error(message));
      }, true);
      try {
        window.chrome.webview.postMessageWithAdditionalObjects(JSON.stringify({
          cmd: 'desktop_pet_drop_signal',
          callback,
          error,
          payload: { requestId },
          options: {},
          __TAURI_INVOKE_KEY__: invokeKey,
        }), additionalObjects);
      } catch (postError) {
        internals.unregisterCallback(callback);
        internals.unregisterCallback(error);
        reject(postError);
      }
    }),
  });
})();
"#;

#[cfg(windows)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DropSignalPayload {
    request_id: String,
}

#[cfg(windows)]
#[derive(Deserialize)]
struct DropIpcMessage {
    cmd: String,
    payload: DropSignalPayload,
    #[serde(rename = "__TAURI_INVOKE_KEY__")]
    invoke_key: String,
}

#[cfg(windows)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDropResult {
    schema_version: &'static str,
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    files: Option<Vec<crate::desktop::files::PickedChatFile>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[cfg(windows)]
pub(crate) fn initialization_script(invoke_key: &str) -> String {
    INITIALIZATION_SCRIPT.replace(
        "__TINYBOT_INVOKE_KEY__",
        &serde_json::to_string(invoke_key).expect("serialize Tauri invoke key"),
    )
}

#[cfg(windows)]
pub(crate) fn register_bridge<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    app: tauri::AppHandle<R>,
    invoke_key: String,
) -> tauri::Result<()> {
    window.with_webview(move |platform| {
        let result = (|| -> Result<(), String> {
            let core = unsafe { platform.controller().CoreWebView2() }
                .map_err(|error| format!("failed to access desktop pet WebView2: {error}"))?;
            let handler = WebMessageReceivedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let Some(signal) = drop_signal_from_message(&args, &invoke_key) else {
                    return Ok(());
                };
                let request_id = signal.payload.request_id;
                let paths = match dropped_paths(&args) {
                    Ok(paths) => paths,
                    Err(error) => {
                        emit_result(&app, request_id, Err(error));
                        return Ok(());
                    }
                };
                let import_app = app.clone();
                let import_request_id = request_id.clone();
                if let Err(error) = std::thread::Builder::new()
                    .name("desktop-pet-file-drop".to_string())
                    .spawn(move || {
                        eprintln!(
                            "desktop_pet_file_drop_import_started request_id={} file_count={}",
                            import_request_id,
                            paths.len()
                        );
                        let result = crate::desktop::files::chat_files_from_paths(
                            &paths,
                            &crate::config::application::tinybot_data_root(),
                        );
                        emit_result(&import_app, import_request_id, result);
                    })
                {
                    emit_result(
                        &app,
                        request_id,
                        Err(format!("failed to start desktop pet file import: {error}")),
                    );
                }
                Ok(())
            }));
            let mut token = 0;
            unsafe { core.add_WebMessageReceived(&handler, &mut token) }.map_err(|error| {
                format!("failed to register desktop pet file-drop bridge: {error}")
            })?;
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("desktop_pet_file_drop_bridge_registration_failed error={error}");
        }
    })
}

#[tauri::command]
pub(crate) fn desktop_pet_drop_signal(request_id: String) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = request_id;
        return Err("desktop pet file drops require Windows WebView2".to_string());
    }
    #[cfg(windows)]
    {
        validate_request_id(&request_id)?;
        eprintln!("desktop_pet_file_drop_signal_received request_id={request_id}");
        Ok(())
    }
}

#[cfg(windows)]
fn drop_signal_from_message(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebMessageReceivedEventArgs,
    invoke_key: &str,
) -> Option<DropIpcMessage> {
    let mut raw = PWSTR::null();
    unsafe { args.TryGetWebMessageAsString(&mut raw) }.ok()?;
    let message = webview2_com::take_pwstr(raw);
    let value = serde_json::from_str::<serde_json::Value>(&message).ok()?;
    if value.get("cmd").and_then(serde_json::Value::as_str) != Some(DROP_SIGNAL_COMMAND) {
        return None;
    }
    let signal = match serde_json::from_value::<DropIpcMessage>(value) {
        Ok(signal) => signal,
        Err(error) => {
            eprintln!("desktop_pet_file_drop_signal_invalid error={error}");
            return None;
        }
    };
    if signal.cmd != DROP_SIGNAL_COMMAND || signal.invoke_key != invoke_key {
        eprintln!("desktop_pet_file_drop_signal_rejected reason=invalid_command_or_invoke_key");
        return None;
    }
    if let Err(error) = validate_request_id(&signal.payload.request_id) {
        eprintln!("desktop_pet_file_drop_signal_rejected reason={error}");
        return None;
    }
    Some(signal)
}

#[cfg(windows)]
fn dropped_paths(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebMessageReceivedEventArgs,
) -> Result<Vec<PathBuf>, String> {
    let args2: ICoreWebView2WebMessageReceivedEventArgs2 = args
        .cast()
        .map_err(|error| format!("desktop pet drop does not expose WebView2 files: {error}"))?;
    let objects = unsafe { args2.AdditionalObjects() }
        .map_err(|error| format!("failed to read desktop pet dropped files: {error}"))?;
    let mut count = 0;
    unsafe { objects.Count(&mut count) }
        .map_err(|error| format!("failed to count desktop pet dropped files: {error}"))?;
    if count == 0 || count > MAX_DROPPED_FILES {
        return Err(format!(
            "desktop pet file drops require 1 to {MAX_DROPPED_FILES} files"
        ));
    }
    (0..count)
        .map(|index| {
            let object = unsafe { objects.GetValueAtIndex(index) }
                .map_err(|error| format!("failed to read dropped object {index}: {error}"))?;
            let file: ICoreWebView2File = object
                .cast()
                .map_err(|error| format!("dropped object {index} is not a local file: {error}"))?;
            let mut raw_path = PWSTR::null();
            unsafe { file.Path(&mut raw_path) }
                .map_err(|error| format!("failed to read dropped file path {index}: {error}"))?;
            let path = PathBuf::from(webview2_com::take_pwstr(raw_path));
            if path.as_os_str().is_empty() {
                return Err(format!("dropped file path {index} is empty"));
            }
            Ok(path)
        })
        .collect()
}

#[cfg(windows)]
fn emit_result<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request_id: String,
    result: Result<Vec<crate::desktop::files::PickedChatFile>, String>,
) {
    let (files, error) = match result {
        Ok(files) => {
            eprintln!(
                "desktop_pet_file_drop_import_completed request_id={} file_count={}",
                request_id,
                files.len()
            );
            (Some(files), None)
        }
        Err(error) => {
            eprintln!(
                "desktop_pet_file_drop_import_failed request_id={} error={}",
                request_id, error
            );
            (None, Some(error))
        }
    };
    let payload = FileDropResult {
        schema_version: FILE_DROP_SCHEMA_VERSION,
        request_id,
        files,
        error,
    };
    if let Err(error) = app.emit_to(
        super::pet::DESKTOP_PET_WINDOW_LABEL,
        FILE_DROP_RESULT_EVENT,
        payload,
    ) {
        eprintln!("desktop_pet_file_drop_result_emit_failed error={error}");
    }
}

fn validate_request_id(request_id: &str) -> Result<(), String> {
    if request_id.starts_with("pet-file-drop-") && request_id.len() <= 128 {
        Ok(())
    } else {
        Err("invalid desktop pet file-drop request ID".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_bounded_file_drop_request_ids() {
        assert!(validate_request_id("pet-file-drop-abc123").is_ok());
        assert!(validate_request_id("").is_err());
        assert!(validate_request_id("chat-drop-abc123").is_err());
        assert!(validate_request_id(&format!("pet-file-drop-{}", "x".repeat(128))).is_err());
    }
}
