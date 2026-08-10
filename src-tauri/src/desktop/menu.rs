use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
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

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopMenuShortcutBinding {
    pub(crate) id: String,
    pub(crate) accelerator: Option<String>,
}

const CONFIGURABLE_DESKTOP_MENU_COMMANDS: &[&str] = &[
    "new-chat",
    "stop-generation",
    "toggle-theme",
    "toggle-sidebar",
    "open-settings",
    "open-docs",
];

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

#[tauri::command]
pub(crate) fn desktop_set_menu_shortcuts<R: Runtime>(
    app: tauri::AppHandle<R>,
    bindings: Vec<DesktopMenuShortcutBinding>,
) -> Result<(), String> {
    let result = apply_desktop_menu_shortcuts(&app, &bindings);
    match result {
        Ok(()) => {
            eprintln!(
                "desktop_menu_shortcut_sync_completed count={}",
                bindings.len()
            );
            Ok(())
        }
        Err(error) => {
            eprintln!("desktop_menu_shortcut_sync_failed error={error}");
            Err(error)
        }
    }
}

fn apply_desktop_menu_shortcuts<R: Runtime>(
    app: &tauri::AppHandle<R>,
    bindings: &[DesktopMenuShortcutBinding],
) -> Result<(), String> {
    validate_desktop_menu_shortcut_bindings(bindings)?;
    let menu = app
        .menu()
        .ok_or_else(|| "desktop application menu is not installed".to_string())?;
    for binding in bindings {
        let item = find_menu_item(
            menu.items().map_err(|error| error.to_string())?,
            &binding.id,
        )?
        .ok_or_else(|| format!("desktop menu item '{}' was not found", binding.id))?;
        let result = match item {
            MenuItemKind::MenuItem(item) => item
                .set_accelerator(binding.accelerator.as_deref())
                .map_err(|error| error.to_string()),
            MenuItemKind::Check(item) => item
                .set_accelerator(binding.accelerator.as_deref())
                .map_err(|error| error.to_string()),
            _ => Err(format!(
                "desktop menu item '{}' cannot have an accelerator",
                binding.id
            )),
        };
        if let Err(error) = result {
            return Err(format!(
                "failed to set desktop menu shortcut for '{}': {error}",
                binding.id
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_desktop_menu_shortcut_bindings(
    bindings: &[DesktopMenuShortcutBinding],
) -> Result<(), String> {
    if bindings.len() != CONFIGURABLE_DESKTOP_MENU_COMMANDS.len() {
        return Err(format!(
            "expected {} desktop menu shortcut bindings, received {}",
            CONFIGURABLE_DESKTOP_MENU_COMMANDS.len(),
            bindings.len()
        ));
    }
    let mut command_ids = HashSet::new();
    let mut accelerators = HashSet::new();
    for binding in bindings {
        if !CONFIGURABLE_DESKTOP_MENU_COMMANDS.contains(&binding.id.as_str()) {
            return Err(format!(
                "desktop menu command '{}' is not configurable",
                binding.id
            ));
        }
        if !command_ids.insert(binding.id.as_str()) {
            return Err(format!(
                "desktop menu command '{}' appears more than once",
                binding.id
            ));
        }
        if let Some(accelerator) = binding.accelerator.as_deref() {
            if !is_supported_accelerator(accelerator) {
                return Err(format!(
                    "desktop menu shortcut '{accelerator}' is not supported"
                ));
            }
            if !accelerators.insert(accelerator) {
                return Err(format!(
                    "desktop menu shortcut '{accelerator}' is assigned more than once"
                ));
            }
        }
    }
    Ok(())
}

fn is_supported_accelerator(accelerator: &str) -> bool {
    let tokens: Vec<&str> = accelerator.split('+').collect();
    let Some(key) = tokens.last().copied() else {
        return false;
    };
    if key.is_empty() {
        return false;
    }
    let modifiers = &tokens[..tokens.len() - 1];
    let modifier_set: HashSet<&str> = modifiers.iter().copied().collect();
    if modifier_set.len() != modifiers.len()
        || modifiers
            .iter()
            .any(|modifier| !matches!(*modifier, "Ctrl" | "Alt" | "Shift"))
    {
        return false;
    }
    let function_key = key
        .strip_prefix('F')
        .and_then(|number| number.parse::<u8>().ok())
        .is_some_and(|number| (1..=12).contains(&number));
    let supported_key = key.chars().count() == 1
        || function_key
        || matches!(
            key,
            "ArrowDown"
                | "ArrowLeft"
                | "ArrowRight"
                | "ArrowUp"
                | "Backspace"
                | "Delete"
                | "End"
                | "Enter"
                | "Home"
                | "PageDown"
                | "PageUp"
                | "Space"
                | "Tab"
        );
    if !supported_key
        || (!modifier_set.contains("Ctrl") && !modifier_set.contains("Alt") && !function_key)
    {
        return false;
    }
    let canonical = [
        modifier_set.contains("Ctrl").then_some("Ctrl"),
        modifier_set.contains("Alt").then_some("Alt"),
        modifier_set.contains("Shift").then_some("Shift"),
        Some(key),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("+");
    canonical == accelerator
}

fn find_menu_item<R: Runtime>(
    items: Vec<MenuItemKind<R>>,
    id: &str,
) -> Result<Option<MenuItemKind<R>>, String> {
    for item in items {
        if item.id().0 == id {
            return Ok(Some(item));
        }
        if let MenuItemKind::Submenu(submenu) = &item {
            let items = submenu.items().map_err(|error| error.to_string())?;
            if let Some(found) = find_menu_item(items, id)? {
                return Ok(Some(found));
            }
        }
    }
    Ok(None)
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
        &[&search_sessions, &open_settings, &open_docs],
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
