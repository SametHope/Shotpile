mod commands;
mod db;
mod scan;

use std::sync::{Mutex, MutexGuard};

use db::Db;
use tauri::Manager;

pub struct AppState {
    pub db: Mutex<Db>,
    /// Session-only undo stack. Decisions themselves are persisted; only the
    /// ability to walk them back is per-session, which is all Ctrl+Z promises.
    pub undo: Mutex<Vec<commands::UndoEntry>>,
    pub undo_limit: usize,
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

#[doc(hidden)]
pub fn scan_root_for_tests(db: &Db, path: &str) -> Result<commands::ScanReport, String> {
    commands::walk_and_store(db, path)
}

/// Mirror of the body of `commands::commit_deletes`, minus the async hop.
#[doc(hidden)]
pub fn commit_deletes_for_tests(db: &Db) -> Result<commands::CommitReport, String> {
    let rows = db.staged_rows()?;
    if rows.is_empty() {
        return Ok(commands::CommitReport {
            deleted: 0,
            failed: Vec::new(),
            still_staged: 0,
        });
    }
    let mut ok_ids: Vec<i64> = Vec::new();
    let mut failed = Vec::new();
    for (id, path, name) in rows {
        match trash::delete(&path) {
            Ok(()) => ok_ids.push(id),
            Err(e) => failed.push(commands::FailedItem {
                id,
                name,
                error: e.to_string(),
                gone: !std::path::Path::new(&path).exists(),
            }),
        }
    }
    let deleted = ok_ids.len();
    for id in ok_ids {
        db.set_status(id, db::STATUS_DELETED, Some(scan::now_ms()))?;
    }
    for f in &failed {
        if f.gone {
            db.set_status(f.id, db::STATUS_DELETED, Some(scan::now_ms()))?;
        }
    }
    Ok(commands::CommitReport {
        deleted,
        still_staged: db.staged_rows()?.len(),
        failed,
    })
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = Db::open(&dir.join("sifter.db"))?;
            app.manage(AppState {
                db: Mutex::new(db),
                undo: Mutex::new(Vec::new()),
                undo_limit: 200,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::pick_folder,
            commands::scan_root,
            commands::list_roots,
            commands::months,
            commands::summary,
            commands::queue_ids,
            commands::items,
            commands::decide,
            commands::undo_last,
            commands::unstage,
            commands::staged_list,
            commands::commit_deletes,
        ])
        .run(tauri::generate_context!())
        .expect("Screenshot Sifter başlatılamadı");
}
