use std::sync::{Mutex, OnceLock};

use tauri::menu::{Menu, MenuItem, MenuItemKind, HELP_SUBMENU_ID};
use tauri::Manager;

use crate::work_gate::{DeviceWorkGate, WorkPermit};

const CHECK_FOR_UPDATES_ID: &str = "node_check_for_updates";
static WORK_GATE: OnceLock<DeviceWorkGate> = OnceLock::new();
static UPDATE_PERMIT: Mutex<Option<WorkPermit>> = Mutex::new(None);

extern "C" {
    fn node_sparkle_start() -> bool;
    fn node_sparkle_check_for_updates();
}

#[no_mangle]
extern "C" fn node_sparkle_reserve_idle_node() -> bool {
    let Ok(mut permit) = UPDATE_PERMIT.lock() else {
        return false;
    };
    if permit.is_none() {
        *permit = WORK_GATE.get().and_then(DeviceWorkGate::try_reserve_update);
    }
    permit.is_some()
}

#[no_mangle]
extern "C" fn node_sparkle_release_node() {
    if let Ok(mut permit) = UPDATE_PERMIT.lock() {
        permit.take();
    }
}

pub fn install(app: &mut tauri::App) -> tauri::Result<()> {
    let _ = WORK_GATE.set(app.state::<DeviceWorkGate>().inner().clone());
    // Tauri setup and menu callbacks run on the Cocoa main thread.
    if !unsafe { node_sparkle_start() } {
        return Ok(());
    }

    let menu = Menu::default(app.handle())?;
    if let Some(MenuItemKind::Submenu(help)) = menu.get(HELP_SUBMENU_ID) {
        help.append(&MenuItem::with_id(
            app,
            CHECK_FOR_UPDATES_ID,
            "Check for Updates…",
            true,
            None::<&str>,
        )?)?;
    }
    app.set_menu(menu)?;
    app.on_menu_event(|_, event| {
        if event.id().0 == CHECK_FOR_UPDATES_ID {
            unsafe { node_sparkle_check_for_updates() };
        }
    });
    Ok(())
}
