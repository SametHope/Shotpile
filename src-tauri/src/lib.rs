mod commands;
mod db;
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
    commands::apply_decision(db, undo, id, kind)
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
    let rows = db.staged_rows()?;
    let outcome = commands::trash_staged(rows);
    commands::apply_commit(db, undo, outcome)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let log_path = dir.join("logs").join("sifter.log");
            if let Some(parent) = log_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            log::init(&log_path);
            log::install_panic_hook();
            log::info(
                "boot",
                &format!("screenshot sifter {}", env!("CARGO_PKG_VERSION")),
            );
            let db = match Db::open(&dir.join("sifter.db")) {
                Ok(db) => db,
                Err(e) => {
                    log::error("boot", &format!("couldn't open the database: {e}"));
                    return Err(e.into());
                }
            };
            log::info(
                "boot",
                &format!("database opened: {}", dir.join("sifter.db").display()),
            );
            // The window starts hidden and the page shows it once painted; if
            // the page never does (a script error, say), show it anyway.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                let _ = commands::show_main_window(&handle);
            });
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
            commands::staged_list,
            commands::commit_deletes,
            commands::log_read,
            commands::log_write,
            commands::open_devtools,
            commands::reveal,
            commands::set_zoom,
            commands::app_ready,
        ])
        .run(tauri::generate_context!())
        .expect("Screenshot Sifter failed to start");
}
