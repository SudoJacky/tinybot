use serde::Serialize;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    Manager, Runtime,
};

#[derive(Clone, Copy)]
pub(crate) struct DesktopMenuItemDescriptor {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    pub(crate) accelerator: Option<&'static str>,
    pub(crate) enabled: bool,
    pub(crate) checked: bool,
}

#[derive(Clone, Serialize)]
pub(crate) struct DesktopMenuCommandPayload {
    pub(crate) id: String,
}

const DESKTOP_MENU_ITEM_DESCRIPTORS: &[DesktopMenuItemDescriptor] = &[
    DesktopMenuItemDescriptor {
        id: "new-chat",
        label: "New Chat",
        accelerator: Some("Ctrl+N"),
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "stop-generation",
        label: "Stop Generation",
        accelerator: Some("Ctrl+."),
        enabled: false,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "search-sessions",
        label: "Search Sessions",
        accelerator: Some("Ctrl+F"),
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "open-settings",
        label: "Settings",
        accelerator: Some("Ctrl+,"),
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "open-docs",
        label: "Documentation",
        accelerator: Some("F1"),
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "open-shortcut-help",
        label: "Shortcut Help",
        accelerator: Some("Ctrl+/"),
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "open-page-help",
        label: "Page Help",
        accelerator: Some("Ctrl+Shift+/"),
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "open-backend-logs",
        label: "Backend Logs",
        accelerator: None,
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "toggle-theme",
        label: "Toggle Theme",
        accelerator: Some("Ctrl+Shift+T"),
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "toggle-sidebar",
        label: "Toggle Sidebar",
        accelerator: Some("Ctrl+B"),
        enabled: true,
        checked: true,
    },
    DesktopMenuItemDescriptor {
        id: "open-command-palette",
        label: "Command Palette",
        accelerator: Some("Ctrl+Shift+P"),
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "refresh-gateway-status",
        label: "Gateway Status",
        accelerator: Some("Ctrl+Shift+G"),
        enabled: true,
        checked: false,
    },
];

pub(crate) fn desktop_menu_item_descriptors() -> &'static [DesktopMenuItemDescriptor] {
    DESKTOP_MENU_ITEM_DESCRIPTORS
}

pub(crate) fn install_desktop_application_menu<R: Runtime>(
    app: &tauri::App<R>,
) -> tauri::Result<()> {
    let menu = build_desktop_application_menu(app.app_handle())?;
    app.set_menu(menu)?;
    Ok(())
}

fn build_desktop_application_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let new_chat = menu_item(app, "new-chat")?;
    let stop_generation = menu_item(app, "stop-generation")?;
    let search_sessions = menu_item(app, "search-sessions")?;
    let open_settings = menu_item(app, "open-settings")?;
    let open_docs = menu_item(app, "open-docs")?;
    let toggle_theme = check_menu_item(app, "toggle-theme")?;
    let toggle_sidebar = check_menu_item(app, "toggle-sidebar")?;
    let open_command_palette = menu_item(app, "open-command-palette")?;
    let refresh_gateway_status = menu_item(app, "refresh-gateway-status")?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_chat,
            &stop_generation,
            &PredefinedMenuItem::separator(app)?,
            &open_command_palette,
        ],
    )?;
    let navigate_menu = Submenu::with_items(
        app,
        "Navigate",
        true,
        &[
            &search_sessions,
            &open_settings,
            &open_docs,
            &refresh_gateway_status,
        ],
    )?;
    let view_menu = Submenu::with_items(app, "View", true, &[&toggle_theme, &toggle_sidebar])?;

    Menu::with_items(app, &[&file_menu, &navigate_menu, &view_menu])
}

fn menu_item<R: Runtime>(
    app: &tauri::AppHandle<R>,
    id: &'static str,
) -> tauri::Result<MenuItem<R>> {
    let descriptor = desktop_menu_descriptor(id);
    MenuItem::with_id(
        app,
        descriptor.id,
        descriptor.label,
        descriptor.enabled,
        descriptor.accelerator,
    )
}

fn check_menu_item<R: Runtime>(
    app: &tauri::AppHandle<R>,
    id: &'static str,
) -> tauri::Result<CheckMenuItem<R>> {
    let descriptor = desktop_menu_descriptor(id);
    CheckMenuItem::with_id(
        app,
        descriptor.id,
        descriptor.label,
        descriptor.enabled,
        descriptor.checked,
        descriptor.accelerator,
    )
}

fn desktop_menu_descriptor(id: &str) -> DesktopMenuItemDescriptor {
    desktop_menu_item_descriptors()
        .iter()
        .copied()
        .find(|item| item.id == id)
        .expect("desktop menu descriptor should exist")
}

pub(crate) fn is_desktop_menu_command(id: &str) -> bool {
    desktop_menu_item_descriptors()
        .iter()
        .any(|item| item.id == id)
}
