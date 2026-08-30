use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

pub(crate) const MAIN_WINDOW_LABEL: &str = "main";

const DESKTOP_TRAY_ID: &str = "tinybot-desktop-tray";
const SHOW_MAIN_WINDOW_MENU_ID: &str = "tray-show-main-window";
const QUIT_APPLICATION_MENU_ID: &str = "tray-quit-application";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DesktopTrayMenuAction {
    ShowMainWindow,
    QuitApplication,
    Ignore,
}

pub(crate) fn install_desktop_tray<R: Runtime>(app: &tauri::App<R>) -> Result<(), String> {
    let show_main_window = MenuItem::with_id(
        app,
        SHOW_MAIN_WINDOW_MENU_ID,
        "显示 Tinybot",
        true,
        None::<&str>,
    )
    .map_err(|error| format!("failed to create tray show command: {error}"))?;
    let quit_application = MenuItem::with_id(
        app,
        QUIT_APPLICATION_MENU_ID,
        "退出 Tinybot",
        true,
        None::<&str>,
    )
    .map_err(|error| format!("failed to create tray quit command: {error}"))?;
    let menu = Menu::with_items(app, &[&show_main_window, &quit_application])
        .map_err(|error| format!("failed to create desktop tray menu: {error}"))?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "desktop tray requires the configured application icon".to_string())?;

    TrayIconBuilder::with_id(DESKTOP_TRAY_ID)
        .icon(icon)
        .tooltip("Tinybot Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .build(app)
        .map_err(|error| format!("failed to install desktop tray: {error}"))?;

    eprintln!("desktop_tray_installed id={DESKTOP_TRAY_ID}");
    Ok(())
}

pub(crate) fn desktop_tray_menu_action(id: &str) -> DesktopTrayMenuAction {
    match id {
        SHOW_MAIN_WINDOW_MENU_ID => DesktopTrayMenuAction::ShowMainWindow,
        QUIT_APPLICATION_MENU_ID => DesktopTrayMenuAction::QuitApplication,
        _ => DesktopTrayMenuAction::Ignore,
    }
}

pub(crate) fn should_restore_main_window(event: &TrayIconEvent) -> bool {
    match event {
        TrayIconEvent::Click {
            button,
            button_state,
            ..
        } => should_restore_main_window_from_click(*button, *button_state),
        _ => false,
    }
}

fn should_restore_main_window_from_click(
    button: MouseButton,
    button_state: MouseButtonState,
) -> bool {
    button == MouseButton::Left && button_state == MouseButtonState::Up
}

pub(crate) fn show_main_window<R: Runtime>(
    app: &AppHandle<R>,
    reason: &'static str,
) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main desktop window is unavailable".to_string())?;
    window
        .show()
        .map_err(|error| format!("failed to show main desktop window: {error}"))?;
    if window
        .is_minimized()
        .map_err(|error| format!("failed to read main desktop window state: {error}"))?
    {
        window
            .unminimize()
            .map_err(|error| format!("failed to restore minimized desktop window: {error}"))?;
    }
    window
        .set_focus()
        .map_err(|error| format!("failed to focus main desktop window: {error}"))?;
    eprintln!("desktop_main_window_shown reason={reason}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_menu_ids_map_only_to_owned_actions() {
        assert_eq!(
            desktop_tray_menu_action(SHOW_MAIN_WINDOW_MENU_ID),
            DesktopTrayMenuAction::ShowMainWindow
        );
        assert_eq!(
            desktop_tray_menu_action(QUIT_APPLICATION_MENU_ID),
            DesktopTrayMenuAction::QuitApplication
        );
        assert_eq!(
            desktop_tray_menu_action("new-chat"),
            DesktopTrayMenuAction::Ignore
        );
    }

    #[test]
    fn only_a_released_left_click_restores_the_main_window() {
        assert!(should_restore_main_window_from_click(
            MouseButton::Left,
            MouseButtonState::Up
        ));
        assert!(!should_restore_main_window_from_click(
            MouseButton::Left,
            MouseButtonState::Down
        ));
        assert!(!should_restore_main_window_from_click(
            MouseButton::Right,
            MouseButtonState::Up
        ));
    }
}
