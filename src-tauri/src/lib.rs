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
            commands::find_duplicates,
            commands::copy_image,
            commands::get_counters,
            commands::reset_counters,
            commands::log_read,
            commands::log_write,
            commands::open_devtools,
            commands::reveal,
            commands::set_zoom,
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
