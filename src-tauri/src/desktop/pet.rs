pub(crate) const DESKTOP_PET_WINDOW_LABEL: &str = "desktop-pet";
pub(crate) const DESKTOP_PET_QUICK_CHAT_WINDOW_LABEL: &str = "desktop-pet-chat";
pub(crate) const DESKTOP_PET_CLOSE_REQUESTED_EVENT: &str = "desktop-pet-close-requested";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DesktopWindowMenuScope {
    Application,
    Isolated,
}

fn desktop_window_menu_scope(label: &str) -> DesktopWindowMenuScope {
    if is_desktop_pet_window(label) || is_desktop_pet_quick_chat_window(label) {
        DesktopWindowMenuScope::Isolated
    } else {
        DesktopWindowMenuScope::Application
    }
}

#[cfg(windows)]
fn isolated_desktop_window_menu<R: tauri::Runtime>(
    app: &tauri::App<R>,
    label: &str,
) -> tauri::Result<tauri::menu::Menu<R>> {
    assert_eq!(
        desktop_window_menu_scope(label),
        DesktopWindowMenuScope::Isolated,
        "desktop auxiliary window must own an isolated menu",
    );
    tauri::menu::Menu::new(app)
}

#[cfg(windows)]
pub(crate) fn create_desktop_pet_window<R: tauri::Runtime>(
    app: &mut tauri::App<R>,
) -> tauri::Result<()> {
    let drop_script = super::pet_file_drop::initialization_script(app.invoke_key());
    let app_handle = app.handle().clone();
    let invoke_key = app.invoke_key().to_string();
    let window = tauri::WebviewWindowBuilder::new(
        app,
        DESKTOP_PET_WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html?surface=desktop-pet".into()),
    )
    .menu(isolated_desktop_window_menu(app, DESKTOP_PET_WINDOW_LABEL)?)
    .title("Tinybot Desktop Pet")
    .inner_size(76.0, 76.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .shadow(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .disable_drag_drop_handler()
    .initialization_script(drop_script)
    .build()?;
    window.hide_menu()?;
    super::pet_file_drop::register_bridge(&window, app_handle, invoke_key)?;
    eprintln!("desktop_pet_window_created visible=false menu_scope=isolated");
    Ok(())
}

#[cfg(windows)]
pub(crate) fn create_desktop_pet_quick_chat_window<R: tauri::Runtime>(
    app: &mut tauri::App<R>,
) -> tauri::Result<()> {
    let window = tauri::WebviewWindowBuilder::new(
        app,
        DESKTOP_PET_QUICK_CHAT_WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html?surface=desktop-pet-chat".into()),
    )
    .menu(isolated_desktop_window_menu(
        app,
        DESKTOP_PET_QUICK_CHAT_WINDOW_LABEL,
    )?)
    .title("Tinybot Quick Chat")
    .inner_size(420.0, 600.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .shadow(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .disable_drag_drop_handler()
    .enable_clipboard_access()
    .build()?;
    window.hide_menu()?;
    eprintln!("desktop_pet_quick_chat_window_created visible=false menu_scope=isolated");
    Ok(())
}

pub(crate) fn is_desktop_pet_window(label: &str) -> bool {
    label == DESKTOP_PET_WINDOW_LABEL
}

pub(crate) fn is_desktop_pet_quick_chat_window(label: &str) -> bool {
    label == DESKTOP_PET_QUICK_CHAT_WINDOW_LABEL
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_the_desktop_pet_window_label() {
        assert!(is_desktop_pet_window("desktop-pet"));
        assert!(!is_desktop_pet_window("main"));
        assert!(!is_desktop_pet_window("desktop-pet-preview"));
    }

    #[test]
    fn recognizes_only_the_desktop_pet_quick_chat_window_label() {
        assert!(is_desktop_pet_quick_chat_window("desktop-pet-chat"));
        assert!(!is_desktop_pet_quick_chat_window("desktop-pet"));
        assert!(!is_desktop_pet_quick_chat_window(
            "desktop-pet-chat-preview"
        ));
    }

    #[test]
    fn desktop_pet_windows_do_not_inherit_the_application_menu() {
        for label in [
            DESKTOP_PET_WINDOW_LABEL,
            DESKTOP_PET_QUICK_CHAT_WINDOW_LABEL,
        ] {
            assert_eq!(
                desktop_window_menu_scope(label),
                DesktopWindowMenuScope::Isolated,
                "{label} inherited the application menu",
            );
        }
    }
}
