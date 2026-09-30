use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::db::{MonthStat, Root, Shot, Summary, STATUS_DELETED, STATUS_PENDING, STATUS_STAGED};
use crate::scan;
use crate::{lock, AppState};

#[derive(Debug, Clone)]
pub struct UndoEntry {
    pub id: i64,
    pub prev: String,
    pub prev_decided_ms: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub data_dir: String,
    pub db_path: String,
    pub schema_version: i64,
    pub app_version: String,
    pub image_exts: Vec<String>,
    pub unviewable_exts: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ScanReport {
    pub root: String,
    pub found: usize,
    pub added: usize,
    pub refreshed: usize,
    pub skipped_other: usize,
    pub unreadable: usize,
    pub unviewable: usize,
    pub missing: usize,
    pub total_in_root: i64,
    pub elapsed_ms: u128,
}

#[derive(Debug, Serialize)]
pub struct FailedItem {
    pub id: i64,
    pub name: String,
    pub error: String,
    /// The file was already gone, so it was marked deleted instead of staged.
    pub gone: bool,
}

#[derive(Debug, Serialize)]
pub struct CommitReport {
    pub deleted: usize,
    pub failed: Vec<FailedItem>,
    pub still_staged: usize,
}

fn tz_offset_min(tz: Option<i64>) -> i64 {
    tz.unwrap_or(0)
}

fn validate_scope(scope: &str) -> Result<&str, String> {
    match scope {
        "month" | "random" | "unreviewed" | "skipped" | "staged" => Ok(scope),
        other => Err(format!("geçersiz kuyruk: {other}")),
    }
}

/// Writes a finished directory walk into the database.
pub fn store_scan(
    db: &crate::db::Db,
    path: &str,
    files: Vec<scan::ScannedFile>,
    stats: scan::CollectStats,
    elapsed_ms: u128,
) -> Result<ScanReport, String> {
    let unviewable = files.iter().filter(|f| !scan::is_viewable(&f.ext)).count();
    let root_id = db.upsert_root(path)?;
    db.flag_root_missing(root_id)?;
    let (added, refreshed) = db.upsert_shots_bulk(root_id, &files)?;
    let total_in_root = db.count_in_root(root_id)?;
    let missing = db.count_missing_in_root(root_id)?;
    db.touch_root(root_id, scan::now_ms())?;

    Ok(ScanReport {
        root: path.to_string(),
        found: stats.found,
        added,
        refreshed,
        skipped_other: stats.skipped_other,
        unreadable: stats.unreadable,
        unviewable,
        missing: missing as usize,
        total_in_root,
        elapsed_ms,
    })
}

pub fn walk_and_store(db: &crate::db::Db, path: &str) -> Result<ScanReport, String> {
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err(format!("klasör bulunamadı: {path}"));
    }
    let started = std::time::Instant::now();
    let (files, stats) = scan::collect(&root);
    let elapsed = started.elapsed().as_millis();
    store_scan(db, path, files, stats, elapsed)
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> Result<AppInfo, String> {
    let db = lock(&state.db);
    let path = db
        .path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "(bellek içi)".to_string());
    let dir = db
        .path()
        .and_then(|p| p.parent())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let unviewable: Vec<String> = scan::IMAGE_EXTS
        .iter()
        .filter(|e| !scan::is_viewable(e))
        .map(|e| e.to_string())
        .collect();
    Ok(AppInfo {
        data_dir: dir,
        db_path: path,
        schema_version: db.schema_version(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        image_exts: scan::IMAGE_EXTS.iter().map(|e| e.to_string()).collect(),
        unviewable_exts: unviewable,
    })
}

#[tauri::command]
pub async fn pick_folder() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Ekran görüntüleri klasörü")
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn scan_root(state: State<'_, AppState>, path: String) -> Result<ScanReport, String> {
    // The walk is IO-bound, so it runs off the UI thread. The database is not
    // touched until that finishes, which keeps the mutex guard out of the
    // closure and off the worker thread.
    let walk_path = path.clone();
    let collected = tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&walk_path);
        if !root.is_dir() {
            return Err(format!("klasör bulunamadı: {walk_path}"));
        }
        let started = std::time::Instant::now();
        let (files, stats) = scan::collect(&root);
        Ok::<_, String>((files, stats, started.elapsed().as_millis()))
    })
    .await
    .map_err(|e| e.to_string())??;

    let (files, stats, elapsed_ms) = collected;
    let db = lock(&state.db);
    store_scan(&db, &path, files, stats, elapsed_ms)
}

#[tauri::command]
pub fn list_roots(state: State<'_, AppState>) -> Result<Vec<Root>, String> {
    lock(&state.db).list_roots()
}

#[tauri::command]
pub fn months(
    state: State<'_, AppState>,
    root_id: Option<i64>,
    tz: Option<i64>,
) -> Result<Vec<MonthStat>, String> {
    lock(&state.db).months(root_id, tz_offset_min(tz))
}

#[tauri::command]
pub fn summary(
    state: State<'_, AppState>,
    root_id: Option<i64>,
    tz: Option<i64>,
) -> Result<Summary, String> {
    lock(&state.db).summary(root_id, tz_offset_min(tz))
}

#[tauri::command]
pub fn queue_ids(
    state: State<'_, AppState>,
    scope: String,
    month: Option<String>,
    root_id: Option<i64>,
    tz: Option<i64>,
) -> Result<Vec<i64>, String> {
    let scope = validate_scope(&scope)?;
    lock(&state.db).queue_ids(scope, month.as_deref(), root_id, tz_offset_min(tz))
}

#[tauri::command]
pub fn items(state: State<'_, AppState>, ids: Vec<i64>) -> Result<Vec<Shot>, String> {
    lock(&state.db).items(&ids)
}

#[tauri::command]
pub fn decide(state: State<'_, AppState>, id: i64, kind: String) -> Result<Shot, String> {
    let status = match kind.as_str() {
        "keep" => crate::db::STATUS_KEPT,
        "skip" => crate::db::STATUS_SKIPPED,
        "delete" => STATUS_STAGED,
        other => return Err(format!("geçersiz karar: {other}")),
    };

    let db = lock(&state.db);
    let prev = db
        .status_of(id)?
        .ok_or_else(|| format!("kayıt bulunamadı: {id}"))?;
    db.set_status(id, status, Some(scan::now_ms()))?;
    let shot = db
        .shot(id)?
        .ok_or_else(|| format!("kayıt bulunamadı: {id}"))?;
    drop(db);

    let mut undo = lock(&state.undo);
    undo.push(UndoEntry {
        id,
        prev: prev.0,
        prev_decided_ms: prev.1,
    });
    let limit = state.undo_limit;
    if undo.len() > limit {
        let excess = undo.len() - limit;
        undo.drain(0..excess);
    }
    Ok(shot)
}

#[tauri::command]
pub fn undo_last(state: State<'_, AppState>) -> Result<Option<Shot>, String> {
    let entry = lock(&state.undo).pop();
    let Some(entry) = entry else {
        return Ok(None);
    };
    let db = lock(&state.db);
    if db.shot(entry.id)?.is_none() {
        return Ok(None);
    }
    db.set_status(entry.id, &entry.prev, entry.prev_decided_ms)?;
    db.shot(entry.id)
}

#[tauri::command]
pub fn unstage(state: State<'_, AppState>, id: i64) -> Result<Shot, String> {
    let db = lock(&state.db);
    if db.shot(id)?.is_none() {
        return Err(format!("kayıt bulunamadı: {id}"));
    }
    db.set_status(id, STATUS_PENDING, None)?;
    let mut undo = lock(&state.undo);
    undo.push(UndoEntry {
        id,
        prev: STATUS_STAGED.to_string(),
        prev_decided_ms: None,
    });
    Ok(db.shot(id)?.expect("checked above"))
}

#[tauri::command]
pub fn staged_list(state: State<'_, AppState>) -> Result<Vec<Shot>, String> {
    let db = lock(&state.db);
    let ids = db.queue_ids("staged", None, None, 0)?;
    db.items(&ids)
}

/// Sends every staged file to the Windows Recycle Bin.
///
/// This is the only place files ever leave the disk, and it is never implicit:
/// a swipe left only marks a row as `staged`.
#[tauri::command]
pub async fn commit_deletes(state: State<'_, AppState>) -> Result<CommitReport, String> {
    // Reading the staged list is a fast query, so it stays on this thread and
    // only the Recycle Bin calls (which shell out and can block) move to a
    // worker.
    let rows = lock(&state.db).staged_rows()?;
    if rows.is_empty() {
        return Ok(CommitReport {
            deleted: 0,
            failed: Vec::new(),
            still_staged: 0,
        });
    }
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut ok_ids: Vec<i64> = Vec::new();
        let mut failed = Vec::new();
        for (id, path, name) in rows {
            match trash::delete(&path) {
                Ok(()) => ok_ids.push(id),
                Err(e) => failed.push((id, name, path, e.to_string())),
            }
        }
        (ok_ids, failed)
    })
    .await
    .map_err(|e| e.to_string())?;

    let (ok_ids, raw_failed) = outcome;
    let db = lock(&state.db);
    let deleted = ok_ids.len();
    for id in ok_ids {
        db.set_status(id, STATUS_DELETED, Some(scan::now_ms()))?;
    }
    let mut failed = Vec::with_capacity(raw_failed.len());
    for (id, name, path, error) in raw_failed {
        // A file that has already vanished counts as done; anything else stays
        // staged so the user can retry or unstage it.
        let gone = !Path::new(&path).exists();
        if gone {
            db.set_status(id, STATUS_DELETED, Some(scan::now_ms()))?;
        }
        failed.push(FailedItem {
            id,
            name,
            error,
            gone,
        });
    }
    let still_staged = db.staged_rows()?.len();
    Ok(CommitReport {
        deleted,
        failed,
        still_staged,
    })
}
