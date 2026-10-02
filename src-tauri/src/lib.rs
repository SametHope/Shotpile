mod commands;
mod db;
mod dupes;
mod log;
mod scan;
mod undo;

use std::sync::{Mutex, MutexGuard};

use db::Db;
use tauri::Manager;
use undo::UndoStack;

/// How many actions Ctrl+Z can walk back in one session.
const UNDO_LIMIT: usize = 200;

pub struct AppState {
    pub db: Mutex<Db>,
    /// Session-only undo stack. Decisions themselves are persisted; only the
    /// ability to walk them back is per-session, which is all Ctrl+Z promises.
    ///
    /// Lock order: `db` first, then `undo`, in every command that holds both,
    /// so two commands can never deadlock each other.
    pub undo: Mutex<UndoStack>,
}

/// Locks without poisoning the app: a panic in one command should not make every
/// later command fail.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Test-only entry points so `tests/e2e.rs` can drive the real command bodies
/// without standing up a Tauri app. The `#[cfg(test)]`-free `pub` is deliberate:
/// an integration test links the lib as an external crate.
#[doc(hidden)]
pub fn open_db_for_tests(path: &std::path::Path) -> Result<Db, String> {
    Db::open(path)
}

/// An undo stack with the app's limit, standing in for `AppState::undo`.
#[doc(hidden)]
pub fn undo_stack_for_tests() -> UndoStack {
    UndoStack::new(UNDO_LIMIT)
}

#[doc(hidden)]
pub fn scan_root_for_tests(db: &Db, path: &str) -> Result<commands::ScanReport, String> {
    commands::walk_and_store(db, path)
}

#[doc(hidden)]
pub fn decide_for_tests(
    db: &Db,
    undo: &mut UndoStack,
    id: i64,
    kind: &str,
) -> Result<db::Shot, String> {
    commands::apply_decision(db, undo, id, kind, None, None)
}

#[doc(hidden)]
pub fn undo_last_for_tests(db: &Db, undo: &mut UndoStack) -> Result<Option<db::Shot>, String> {
    commands::apply_undo(db, undo)
}

#[doc(hidden)]
pub fn forget_root_for_tests(db: &Db, undo: &mut UndoStack, root_id: i64) -> Result<(), String> {
    commands::apply_forget_root(db, undo, root_id)
}

/// The same three steps as `commands::commit_deletes`, minus the worker hop.
#[doc(hidden)]
pub fn commit_deletes_for_tests(
    db: &Db,
    undo: &mut UndoStack,
) -> Result<commands::CommitReport, String> {
    let rows = db.staged_rows(None)?;
    let outcome = commands::trash_staged(rows);
    commands::apply_commit(db, undo, None, outcome)
}

#[doc(hidden)]
pub fn find_duplicates_for_tests(
    db: &Db,
    root_id: i64,
) -> Result<Vec<dupes::DuplicateGroup>, String> {
    dupes::find_duplicates(db, root_id)
}

/// The data folder and database name before the app was renamed to Shotpile.
const LEGACY_DIR: &str = "com.hope.screenshotsifter";
const LEGACY_DB: &str = "sifter.db";

/// Moves a database left by the app under its old name (v1.0.0, "Screenshot
/// Sifter") into `dir`, so an update keeps every decision. A rename only:
/// nothing is deleted, and an existing `shotpile.db` is never replaced.
/// Returns the folder it came from, if it moved one.
fn adopt_legacy_db(dir: &std::path::Path) -> std::io::Result<Option<String>> {
    let target = dir.join("shotpile.db");
    let Some(old_dir) = dir.parent().map(|p| p.join(LEGACY_DIR)) else {
        return Ok(None);
    };
    let old = old_dir.join(LEGACY_DB);
    if target.exists() || !old.exists() {
        return Ok(None);
    }
    std::fs::rename(&old, &target)?;
    // SQLite's side files belong with the database; without them the last
    // writes of a crashed session would be lost.
    for ext in ["-wal", "-shm"] {
        let side = old_dir.join(format!("{LEGACY_DB}{ext}"));
        if side.exists() {
            std::fs::rename(side, dir.join(format!("shotpile.db{ext}")))?;
        }
    }
    Ok(Some(old_dir.display().to_string()))
}

/// Binds F11 to the window's own fullscreen, on Windows.
///
/// WebView2 keeps F11 for itself: Chromium's browser process handles it as
/// "enter browser fullscreen", so the key never reaches the page and a JS
/// keydown listener cannot see it. A menu accelerator does not get round that
/// either, and it is worth saying why, because it looks like it should: Tauri
/// runs a message hook that calls `TranslateAcceleratorW` with the accelerator
/// tables of its stashed menus before the webview is offered the key, so an
/// F11 menu item is caught first. But the hook translates against
/// `MSG.hwnd`, which is the window with keyboard focus -- WebView2's
/// `Chrome_WidgetWin_1` child, not ours -- so the `WM_COMMAND` is delivered to
/// a window that has no menu on it, the item never fires, and the keypress is
/// swallowed on the way. (Verified: the item's accelerator is in the table, the
/// hook runs, F11 and Alt+F11 both go nowhere, and clicking the same item does
/// reach `on_menu_event`.)
///
/// `RegisterHotKey` posts `WM_HOTKEY` to the window we name, whatever has the
/// focus, so the main window gets it either way. A window-proc subclass
/// (installed while the window is still hidden) turns that into the same
/// `apply_toggle_fullscreen` the command uses, so the window state cannot
/// drift between the two paths.
///
/// F11 reaches the page on macOS and Linux, so the frontend binding is the path
/// there and this only covers Windows.
#[cfg(target_os = "windows")]
mod fullscreen_key {
    use std::ffi::c_void;
    use std::ptr;
    use std::sync::atomic::{AtomicPtr, Ordering};
    use std::sync::Mutex;

    use tauri::AppHandle;

    /// Any unused id; the window proc only acts on this one.
    const HOTKEY_ID: usize = 0xF011;
    const WM_HOTKEY: u32 = 0x0312;
    const GWLP_WNDPROC: i32 = -4;
    const VK_F11: u32 = 0x7A;

    extern "system" {
        fn SetWindowLongPtrW(hwnd: *mut c_void, index: i32, value: *mut c_void) -> *mut c_void;
        fn CallWindowProcW(
            prev: *const c_void,
            hwnd: *mut c_void,
            msg: u32,
            wparam: usize,
            lparam: isize,
        ) -> isize;
        fn RegisterHotKey(hwnd: *mut c_void, id: i32, mods: u32, vk: u32) -> i32;
        fn GetForegroundWindow() -> *mut c_void;
    }

    /// tao's window proc, kept so every message we do not want still reaches it.
    static PREV_PROC: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());
    static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

    unsafe extern "system" fn wnd_proc(
        hwnd: *mut c_void,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        if msg == WM_HOTKEY && wparam == HOTKEY_ID {
            // A system-wide hotkey arrives even when another app has the focus.
            // Toggling Shotpile out of sight would be a surprise, so only our
            // own foreground counts.
            if GetForegroundWindow() == hwnd {
                let app = APP.lock().ok().and_then(|app| app.clone());
                if let Some(app) = app {
                    match crate::commands::apply_toggle_fullscreen(&app) {
                        Ok(on) => crate::log::info(
                            "fullscreen",
                            &format!("F11: {}", if on { "on" } else { "off" }),
                        ),
                        Err(e) => crate::log::warn("fullscreen", &format!("F11 failed: {e}")),
                    }
                    return 0;
                }
            }
        }
        CallWindowProcW(
            PREV_PROC.load(Ordering::Relaxed) as *const c_void,
            hwnd,
            msg,
            wparam,
            lparam,
        )
    }

    /// Installs the subclass and registers F11. Called on the UI thread while
    /// the window is still hidden.
    pub fn install(app: &AppHandle, hwnd: *mut c_void) {
        // The subclass goes in first, so no WM_HOTKEY can land before we can
        // see it.
        unsafe {
            PREV_PROC.store(
                SetWindowLongPtrW(hwnd, GWLP_WNDPROC, wnd_proc as *mut c_void),
                Ordering::Relaxed,
            );
        }
        if PREV_PROC.load(Ordering::Relaxed).is_null() {
            crate::log::warn(
                "fullscreen",
                "couldn't subclass the window; F11 stays a menu-less no-op",
            );
            return;
        }
        if let Ok(mut slot) = APP.lock() {
            *slot = Some(app.clone());
        }
        // 0 is ERROR_SUCCESS; anything else means F11 is taken (usually by
        // another app with a system-wide hotkey) and the frontend binding is
        // the only path left.
        let ok = unsafe { RegisterHotKey(hwnd, HOTKEY_ID as i32, 0, VK_F11) } != 0;
        crate::log::info(
            "fullscreen",
            if ok {
                "F11 hotkey registered"
            } else {
                "F11 hotkey unavailable (already registered elsewhere)"
            },
        );
    }
}

/// Binds F11 on Windows; nothing to do elsewhere, where the key reaches the
/// page and the frontend binding handles it.
#[cfg(target_os = "windows")]
fn install_fullscreen_key(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    fullscreen_key::install(app, hwnd.0);
}

#[cfg(not(target_os = "windows"))]
fn install_fullscreen_key(_app: &tauri::AppHandle) {}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let log_path = dir.join("logs").join("shotpile.log");
            if let Some(parent) = log_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            log::init(&log_path);
            log::install_panic_hook();
            log::info("boot", &format!("shotpile {}", env!("CARGO_PKG_VERSION")));
            match adopt_legacy_db(&dir) {
                Ok(Some(from)) => {
                    log::info("boot", &format!("moved the database over from {from}"))
                }
                Ok(None) => {}
                Err(e) => log::warn("boot", &format!("couldn't move the old database over: {e}")),
            }
            let db = match Db::open(&dir.join("shotpile.db")) {
                Ok(db) => db,
                Err(e) => {
                    log::error("boot", &format!("couldn't open the database: {e}"));
                    return Err(e.into());
                }
            };
            log::info(
                "boot",
                &format!("database opened: {}", dir.join("shotpile.db").display()),
            );
            // The window starts hidden and the page shows it once painted; if
            // the page never does (a script error, say), show it anyway.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                let _ = commands::show_main_window(&handle);
            });
            install_fullscreen_key(&app.handle().clone());
            app.manage(AppState {
                db: Mutex::new(db),
                undo: Mutex::new(UndoStack::new(UNDO_LIMIT)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::pick_folder,
            commands::scan_root,
            commands::list_roots,
            commands::forget_root,
            commands::months,
            commands::month_thumbs,
            commands::summary,
            commands::queue_ids,
            commands::items,
            commands::decide,
            commands::undo_last,
            commands::redo_last,
            commands::unstage,
            commands::unstage_multiple,
            commands::staged_list,
            commands::commit_deletes,
            commands::find_duplicates,
            commands::copy_image,
            commands::get_counters,
            commands::reset_counters,
            commands::incr_counter,
            commands::log_read,
            commands::log_write,
            commands::open_devtools,
            commands::reveal,
            commands::set_zoom,
            commands::set_window_background,
            commands::toggle_fullscreen,
            commands::app_ready,
        ])
        .run(tauri::generate_context!())
        .expect("Shotpile failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_legacy_database_moves_over_once_and_never_replaces_a_new_one() {
        let base = std::env::temp_dir().join(format!("shotpile-legacy-{}", std::process::id()));
        let old_dir = base.join(LEGACY_DIR);
        let dir = base.join("com.samethope.shotpile");
        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(old_dir.join(LEGACY_DB), b"old").unwrap();
        std::fs::write(old_dir.join("sifter.db-wal"), b"wal").unwrap();

        assert!(adopt_legacy_db(&dir).unwrap().is_some());
        assert_eq!(std::fs::read(dir.join("shotpile.db")).unwrap(), b"old");
        assert_eq!(std::fs::read(dir.join("shotpile.db-wal")).unwrap(), b"wal");
        assert!(!old_dir.join(LEGACY_DB).exists());

        // A second start, or a fresh old file next to an existing database,
        // changes nothing.
        std::fs::write(old_dir.join(LEGACY_DB), b"stray").unwrap();
        assert!(adopt_legacy_db(&dir).unwrap().is_none());
        assert_eq!(std::fs::read(dir.join("shotpile.db")).unwrap(), b"old");

        // Tests may clean up the temp folders they create themselves.
        std::fs::remove_dir_all(&base).unwrap();
    }
}
