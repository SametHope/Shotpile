use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

use crate::db::{
    Db, MonthStat, Root, Shot, StagedRow, Summary, STATUS_DELETED, STATUS_KEPT, STATUS_PENDING,
    STATUS_SKIPPED, STATUS_STAGED,
};
use crate::scan::{self, CollectStats, ScannedFile};
use crate::undo::{UndoEntry, UndoStack};
use crate::{lock, AppState};

/// A frontend log scope is a short tag such as `decide`. A longer one is a bug
/// upstream, but it still must not break the one-entry-per-line log.
const MAX_UI_SCOPE_CHARS: usize = 64;

#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub data_dir: String,
    pub db_path: String,
    pub log_path: String,
    pub schema_version: i64,
    pub app_version: String,
    pub image_exts: Vec<String>,
    pub unviewable_exts: Vec<String>,
    pub tauri_version: String,
    pub webview_version: String,
    pub sqlite_version: String,
    /// What this OS calls the bin and the file manager, for the UI text.
    pub trash_name: String,
    pub file_manager: String,
}

#[derive(Debug, Serialize)]
pub struct ScanReport {
    pub root: String,
    pub found: usize,
    pub added: usize,
    pub refreshed: usize,
    /// Committed files found on disk again (restored from the Recycle Bin),
    /// now kept.
    pub restored: usize,
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
    /// Total size of the files moved to the Recycle Bin. A file that was
    /// already gone freed nothing here, so it is not counted.
    pub bytes_freed: i64,
    pub failed: Vec<FailedItem>,
    pub still_staged: usize,
}

/// What the Recycle Bin pass did, before any of it is written back.
#[derive(Debug, Default)]
pub struct TrashOutcome {
    /// Rows whose file is now in the Recycle Bin.
    pub moved: Vec<StagedRow>,
    /// Rows whose file could not be moved.
    pub failed: Vec<FailedItem>,
}

/// Payload of the `scan-progress` event: images found so far in `path`.
#[derive(Debug, Clone, Serialize)]
pub struct ScanProgress {
    pub path: String,
    pub found: usize,
}

/// Payload of the `commit-progress` event: files deleted so far.
#[derive(Debug, Clone, Serialize)]
pub struct CommitProgress {
    pub current: usize,
    pub total: usize,
    pub current_file: String,
}

/// How often `scan_root` reports progress. The walk finds thousands of files a
/// second on a fast disk; the UI only needs to look alive.
const PROGRESS_EVERY: std::time::Duration = std::time::Duration::from_millis(120);

#[derive(Debug, Serialize)]
pub struct MonthThumbs {
    pub month: String,
    pub paths: Vec<String>,
}

/// Local statistics counters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CounterGroup {
    pub name: String,
    pub label: String,
    pub counters: Vec<(String, i64)>,
}

fn tz_offset_min(tz: Option<i64>) -> i64 {
    tz.unwrap_or(0)
}

fn validate_scope(scope: &str) -> Result<&str, String> {
    match scope {
        "month" | "random" | "unreviewed" | "skipped" | "staged" | "kept" => Ok(scope),
        other => Err(format!("invalid queue: {other}")),
    }
}

/// Walks a folder and times it. This is the slow, IO-bound half of a scan and
/// touches no database state, so `scan_root` can run it on a worker without
/// holding the lock.
fn walk(path: &str) -> Result<(Vec<ScannedFile>, CollectStats, u128), String> {
    walk_with(path, |_| {})
}

/// `walk`, passing the running count of images found to `progress`.
fn walk_with(
    path: &str,
    progress: impl FnMut(usize),
) -> Result<(Vec<ScannedFile>, CollectStats, u128), String> {
    let root = Path::new(path);
    if !root.is_dir() {
        return Err(format!("folder not found: {path}"));
    }
    let started = std::time::Instant::now();
    let (files, stats) = scan::collect(root, progress);
    Ok((files, stats, started.elapsed().as_millis()))
}

/// Writes a finished directory walk into the database.
pub fn store_scan(
    db: &Db,
    path: &str,
    files: Vec<ScannedFile>,
    stats: CollectStats,
    elapsed_ms: u128,
) -> Result<ScanReport, String> {
    let unviewable = files.iter().filter(|f| !scan::is_viewable(&f.ext)).count();
    crate::log::debug(
        "scan",
        &format!(
            "{path}: writing {} files ({unviewable} without preview)",
            files.len()
        ),
    );
    let root_id = db.upsert_root(path)?;
    db.flag_root_missing(root_id)?;
    let (added, refreshed, restored) = db.upsert_shots_bulk(root_id, &files)?;
    let total_in_root = db.count_in_root(root_id)?;
    let missing = db.count_missing_in_root(root_id)?;
    db.touch_root(root_id, scan::now_ms())?;

    Ok(ScanReport {
        root: path.to_string(),
        found: stats.found,
        added,
        refreshed,
        restored,
        skipped_other: stats.skipped_other,
        unreadable: stats.unreadable,
        unviewable,
        missing: missing as usize,
        total_in_root,
        elapsed_ms,
    })
}

/// A whole scan on the calling thread: what `scan_root` does, minus the worker.
pub fn walk_and_store(db: &Db, path: &str) -> Result<ScanReport, String> {
    let (files, stats, elapsed_ms) = walk(path)?;
    store_scan(db, path, files, stats, elapsed_ms)
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> Result<AppInfo, String> {
    let db = lock(&state.db);
    let path = db
        .path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "(in memory)".to_string());
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
        log_path: crate::log::path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        schema_version: db.schema_version(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        image_exts: scan::IMAGE_EXTS.iter().map(|e| e.to_string()).collect(),
        unviewable_exts: unviewable,
        tauri_version: tauri::VERSION.to_string(),
        webview_version: tauri::webview_version().unwrap_or_else(|_| "unknown".to_string()),
        sqlite_version: rusqlite::version().to_string(),
        trash_name: if cfg!(windows) {
            "Recycle Bin"
        } else {
            "Trash"
        }
        .to_string(),
        file_manager: if cfg!(windows) {
            "File Explorer"
        } else if cfg!(target_os = "macos") {
            "Finder"
        } else {
            "the file manager"
        }
        .to_string(),
    })
}

/// The project page that Options > About opens.
const REPO_URL: &str = "https://github.com/SametHope/Shotpile";

/// Shows a known place: the data folder, the logs folder, or one screenshot
/// (selected in its folder) in the file manager, or the project page in the
/// browser. The frontend names the place, never a path or a URL, so this
/// cannot be pointed anywhere else.
#[tauri::command]
pub fn reveal(state: State<'_, AppState>, target: String, id: Option<i64>) -> Result<(), String> {
    let path = match target.as_str() {
        "data" => lock(&state.db)
            .path()
            .and_then(|p| p.parent())
            .map(Path::to_path_buf)
            .ok_or("the database has no folder")?,
        "logs" => crate::log::path()
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .ok_or("the file log is not open")?,
        "shot" => {
            let id = id.ok_or("no screenshot given")?;
            let shot = lock(&state.db)
                .shot(id)?
                .ok_or_else(|| format!("no such screenshot: {id}"))?;
            std::path::PathBuf::from(shot.path)
        }
        "repo" => {
            open_url(REPO_URL)?;
            crate::log::info("reveal", REPO_URL);
            return Ok(());
        }
        other => return Err(format!("unknown place: {other}")),
    };
    open_in_file_manager(&path)?;
    crate::log::info("reveal", &format!("{target}: {}", path.display()));
    Ok(())
}

/// Copies an image file to the clipboard. Only called for image files (PNG, JPG, etc).
#[tauri::command]
pub fn copy_image(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let shot = lock(&state.db)
        .shot(id)?
        .ok_or_else(|| format!("no such screenshot: {id}"))?;
    let path = std::path::Path::new(&shot.path);
    if !path.exists() {
        return Err(format!("{} no longer exists", path.display()));
    }
    copy_image_file_to_clipboard(path)?;
    crate::log::info("copy-image", &format!("id {}", id));
    Ok(())
}

fn copy_image_file_to_clipboard(path: &Path) -> Result<(), String> {
    let (width, height, bytes) = load_rgba(path)?;
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("couldn't reach the clipboard: {e}"))?;
    clipboard
        .set_image(arboard::ImageData {
            width,
            height,
            bytes: bytes.into(),
        })
        .map_err(|e| format!("couldn't put the image on the clipboard: {e}"))?;
    Ok(())
}

/// Decodes an image file to straight RGBA, plus its size. Kept apart from the
/// clipboard so it can be tested without a display or a real clipboard.
fn load_rgba(path: &Path) -> Result<(usize, usize, Vec<u8>), String> {
    let reader = image::ImageReader::open(path)
        .map_err(|e| format!("couldn't open the image: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("couldn't read the image format: {e}"))?;
    let img = reader
        .decode()
        .map_err(|e| format!("couldn't decode the image: {e}"))?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    Ok((w as usize, h as usize, rgba.into_raw()))
}

fn open_url(url: &str) -> Result<(), String> {
    let spawned = if cfg!(windows) {
        // `start` is a cmd builtin; the empty string is its window title.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
    } else {
        std::process::Command::new(if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        })
        .arg(url)
        .spawn()
    };
    spawned
        .map(|_| ())
        .map_err(|e| format!("couldn't open the browser: {e}"))
}

fn open_in_file_manager(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("{} no longer exists", path.display()));
    }
    spawn_in_file_manager(path)
}

/// Opens the OS file manager at `path`, selecting the file when it is one.
///
/// Windows is separate because explorer.exe parses its own command line: it
/// wants the *path* quoted inside `/select,...`, not the whole token. Rust's
/// `arg` wraps the whole token once it contains a space (`"/select,C:\some
/// path\a.png"`), which explorer rejects and answers by opening Documents.
/// `raw_arg` passes the quoting built here through untouched. Forward slashes
/// are normalised too; explorer mishandles them in the file part.
#[cfg(windows)]
fn spawn_in_file_manager(path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("explorer");
    if path.is_file() {
        cmd.raw_arg(explorer_select_arg(path));
    } else {
        cmd.raw_arg(format!("\"{}\"", path.display()));
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("couldn't open the file manager: {e}"))
}

/// The one argument explorer.exe needs to reveal `path` in its folder:
/// `/select,"C:\dir\file.png"`. Pure so it is unit tested.
#[cfg(windows)]
fn explorer_select_arg(path: &Path) -> String {
    format!("/select,\"{}\"", path.to_string_lossy().replace('/', "\\"))
}

#[cfg(target_os = "macos")]
fn spawn_in_file_manager(path: &Path) -> Result<(), String> {
    let mut cmd = std::process::Command::new("open");
    if path.is_file() {
        cmd.arg("-R");
    }
    cmd.arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("couldn't open the file manager: {e}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_in_file_manager(path: &Path) -> Result<(), String> {
    // Try the freedesktop FileManager1 DBus interface to select the file,
    // falling back to xdg-open on the parent directory.
    let spawned = if path.is_file() {
        if let Ok(uri) = path_to_file_uri(path) {
            if try_show_items_dbus(&uri).is_ok() {
                return Ok(());
            }
        }
        let dir = path.parent().unwrap_or(path);
        std::process::Command::new("xdg-open").arg(dir).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(path).spawn()
    };
    spawned
        .map(|_| ())
        .map_err(|e| format!("couldn't open the file manager: {e}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn path_to_file_uri(path: &Path) -> Result<String, String> {
    // Convert an absolute path to a file:// URI.
    let abs =
        std::fs::canonicalize(path).map_err(|e| format!("couldn't canonicalize path: {e}"))?;
    let path_str = abs.to_string_lossy();
    Ok(format!("file://{}", path_str.replace("\\", "/")))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn try_show_items_dbus(uri: &str) -> Result<(), String> {
    // Try to select the file using org.freedesktop.FileManager1.ShowItems via DBus.
    // This uses gdbus call, which is usually available on freedesktop systems.
    let output = std::process::Command::new("gdbus")
        .args([
            "call",
            "--session",
            "--dest=org.freedesktop.FileManager1",
            "--object-path=/org/freedesktop/FileManager1",
            "--method=org.freedesktop.FileManager1.ShowItems",
            &format!("['{}']", uri),
            "''",
        ])
        .output()
        .map_err(|e| format!("gdbus call failed: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("gdbus call failed: {}", stderr))
    }
}

/// Shows the main window. It starts hidden (`visible: false` in
/// tauri.conf.json) so the WebView's blank white never shows; the frontend
/// calls this once its first view is painted. lib.rs shows it anyway after a
/// few seconds, in case the page never gets that far.
#[tauri::command]
pub fn app_ready(app: tauri::AppHandle) -> Result<(), String> {
    show_main_window(&app)
}

pub fn show_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    if !window.is_visible().unwrap_or(false) {
        window
            .show()
            .map_err(|e| format!("couldn't show the window: {e}"))?;
        let _ = window.set_focus();
    }
    Ok(())
}

/// Sets the page zoom of the main window (1.0 is 100%). The frontend keeps the
/// preference and applies it at start-up and from the zoom shortcuts.
#[tauri::command]
pub fn set_zoom(app: tauri::AppHandle, factor: f64) -> Result<(), String> {
    let factor = factor.clamp(0.5, 2.0);
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window
        .set_zoom(factor)
        .map_err(|e| format!("couldn't set the zoom: {e}"))
}

/// Sets the window and webview background to the current theme's colour,
/// as `#rrggbb`. WebView2's default background is white and shows through
/// before the page repaints — the flash on the first scroll in a fullscreen
/// window. `tauri.conf.json` only pins the light colour at creation; the
/// frontend calls this again when the theme changes.
#[tauri::command]
pub fn set_window_background(app: tauri::AppHandle, color: String) -> Result<(), String> {
    let color = color
        .parse::<tauri::window::Color>()
        .map_err(|_| format!("invalid colour: {color}"))?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window
        .set_background_color(Some(color))
        .map_err(|e| format!("couldn't set the background: {e}"))
}

/// Toggle real fullscreen and report the new state.
///
/// F11 never reaches the page: WebView2 treats it as one of its own browser
/// keys and swallows it, so the key is bound natively instead (see
/// `install_fullscreen_key` in lib.rs). This command is the fallback for other
/// platforms, and for a rebound key that the webview does pass on.
#[tauri::command]
pub fn toggle_fullscreen(app: tauri::AppHandle) -> Result<bool, String> {
    apply_toggle_fullscreen(&app)
}

/// The fullscreen flip itself, shared by the command and the F11 accelerator.
/// The state lives on the window rather than the frontend so it cannot drift
/// after an OS-level change.
pub fn apply_toggle_fullscreen(app: &tauri::AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let next = !window
        .is_fullscreen()
        .map_err(|e| format!("couldn't read the fullscreen state: {e}"))?;
    window
        .set_fullscreen(next)
        .map_err(|e| format!("couldn't set fullscreen: {e}"))?;
    Ok(next)
}

/// Returns the tail of the file log, for diagnosing a release build from inside
/// the app. `max_lines` is clamped so a caller cannot ask for the world.
#[tauri::command]
pub fn log_read(max_lines: Option<usize>) -> String {
    let n = max_lines.unwrap_or(500).min(5000);
    crate::log::read_tail(n)
}

/// Appends a frontend entry to the file log, so the UI side of a problem lands
/// next to the backend side even when DevTools was never open. The `ui:` scope
/// prefix tells the two apart. Unknown levels log at INFO.
#[tauri::command]
pub fn log_write(level: String, scope: String, msg: String) {
    crate::log::log(
        crate::log::Level::from_name(&level),
        &format!("ui:{}", crate::log::one_line(&scope, MAX_UI_SCOPE_CHARS)),
        &crate::log::one_line(&msg, crate::log::MAX_MSG_CHARS),
    );
}

/// Opens the WebView DevTools. Bound to F12 / Ctrl+Shift+I in the frontend, so a
/// release build can be inspected without a debug build.
#[tauri::command]
pub fn open_devtools(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.open_devtools();
    crate::log::info("devtools", "opened");
    Ok(())
}

#[tauri::command]
pub async fn pick_folder() -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Choose a screenshots folder")
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    match &picked {
        Some(p) => crate::log::info("pick_folder", &format!("picked: {p}")),
        None => crate::log::info("pick_folder", "cancelled"),
    }
    Ok(picked)
}

#[tauri::command]
pub async fn scan_root(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<ScanReport, String> {
    // The walk is IO-bound, so it runs off the UI thread. The database is not
    // touched until that finishes, which keeps the mutex guard out of the
    // closure and off the worker thread. Meanwhile a throttled `scan-progress`
    // event tells the UI how far it got, so a big first scan does not look
    // frozen.
    let walk_path = path.clone();
    let (files, stats, elapsed_ms) = tauri::async_runtime::spawn_blocking(move || {
        let mut last: Option<std::time::Instant> = None;
        walk_with(&walk_path, |found| {
            if last.is_some_and(|t| t.elapsed() < PROGRESS_EVERY) {
                return;
            }
            last = Some(std::time::Instant::now());
            let progress = ScanProgress {
                path: walk_path.clone(),
                found,
            };
            // Progress is cosmetic: a failed emit must not fail the scan.
            let _ = app.emit("scan-progress", progress);
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    let db = lock(&state.db);
    let report = store_scan(&db, &path, files, stats, elapsed_ms)?;
    crate::log::info(
        "scan",
        &format!(
            "{}: {} files ({} new, {} refreshed, {} without preview, {} missing) {} ms",
            path,
            report.found,
            report.added,
            report.refreshed,
            report.unviewable,
            report.missing,
            report.elapsed_ms
        ),
    );
    Ok(report)
}

#[tauri::command]
pub fn list_roots(state: State<'_, AppState>) -> Result<Vec<Root>, String> {
    lock(&state.db).list_roots()
}

/// The body of `forget_root`, minus the state plumbing.
pub fn apply_forget_root(db: &Db, undo: &mut UndoStack, root_id: i64) -> Result<(), String> {
    let ids = db.forget_root(root_id)?;
    undo.purge(&ids);
    crate::log::info(
        "forget_root",
        &format!("root {root_id}: {} rows forgotten", ids.len()),
    );
    Ok(())
}

/// Removes a saved folder from the app: its rows, decisions and staged entries
/// leave the database. Nothing on disk is touched, so the folder and every
/// file in it stay exactly where they are, and scanning it again starts over.
#[tauri::command]
pub fn forget_root(state: State<'_, AppState>, root_id: i64) -> Result<(), String> {
    let db = lock(&state.db);
    apply_forget_root(&db, &mut lock(&state.undo), root_id)
}

#[tauri::command]
pub fn months(
    state: State<'_, AppState>,
    root_id: Option<i64>,
    tz: Option<i64>,
) -> Result<Vec<MonthStat>, String> {
    lock(&state.db).months(root_id, tz_offset_min(tz))
}

/// Sample image paths per month, for the preview strip on each month row.
#[tauri::command]
pub fn month_thumbs(
    state: State<'_, AppState>,
    root_id: Option<i64>,
    tz: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<MonthThumbs>, String> {
    let db = lock(&state.db);
    let limit = limit.unwrap_or(5).min(12);
    db.month_thumbs(root_id, tz_offset_min(tz), limit)
        .map(|rows| {
            rows.into_iter()
                .map(|(month, paths)| MonthThumbs { month, paths })
                .collect()
        })
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

/// The body of `decide`, minus the state plumbing.
pub fn apply_decision(
    db: &Db,
    undo: &mut UndoStack,
    id: i64,
    kind: &str,
    swipe_dx: Option<f64>,
    swipe_dy: Option<f64>,
) -> Result<Shot, String> {
    let status = match kind {
        "keep" => STATUS_KEPT,
        "skip" => STATUS_SKIPPED,
        "delete" => STATUS_STAGED,
        other => return Err(format!("invalid decision: {other}")),
    };

    let before = db
        .shot(id)?
        .ok_or_else(|| format!("no such screenshot: {id}"))?;
    if before.status == STATUS_DELETED {
        // Its file is already in the Recycle Bin. A stale card must not turn
        // the row back into a live one.
        return Err(format!("{} is already in the Recycle Bin", before.name));
    }
    db.set_status(id, status, Some(scan::now_ms()))?;

    // Increment counter for this decision type
    let counter_name = match kind {
        "keep" => "decision:kept",
        "skip" => "decision:skipped",
        "delete" => "decision:staged",
        _ => "",
    };
    if !counter_name.is_empty() {
        let _ = db.incr_counter(counter_name, 1);
    }

    // Track swipe direction if provided
    if let (Some(dx), Some(dy)) = (swipe_dx, swipe_dy) {
        let threshold = 80.0;
        let abs_dx = dx.abs();
        let abs_dy = dy.abs();

        if abs_dx >= threshold || abs_dy >= threshold {
            if abs_dx > abs_dy {
                if dx > 0.0 {
                    let _ = db.incr_counter("swipe:right", 1);
                } else {
                    let _ = db.incr_counter("swipe:left", 1);
                }
            } else if dy > 0.0 {
                let _ = db.incr_counter("swipe:down", 1);
            } else {
                let _ = db.incr_counter("swipe:up", 1);
            }
        }
    }

    let shot = db
        .shot(id)?
        .ok_or_else(|| format!("no such screenshot: {id}"))?;
    undo.push(UndoEntry {
        id,
        prev: before.status,
        prev_decided_ms: before.decided_ms,
        next: status.to_string(),
        next_decided_ms: None,
    });
    crate::log::info("decide", &format!("{id} {} -> {status}", shot.name));
    Ok(shot)
}

#[tauri::command]
pub fn decide(
    state: State<'_, AppState>,
    id: i64,
    kind: String,
    swipe_dx: Option<f64>,
    swipe_dy: Option<f64>,
) -> Result<Shot, String> {
    let db = lock(&state.db);
    apply_decision(&db, &mut lock(&state.undo), id, &kind, swipe_dx, swipe_dy)
}

/// The body of `undo_last`: walks back the most recent action that still
/// applies. Entries whose row has moved on since (committed, decided again,
/// forgotten) are dropped on the way, so undo can never bring back a row whose
/// file is in the Recycle Bin.
pub fn apply_undo(db: &Db, undo: &mut UndoStack) -> Result<Option<Shot>, String> {
    let entry = undo.pop_valid(|id| db.status_of(id).map(|row| row.map(|(status, _)| status)))?;
    let Some(entry) = entry else {
        return Ok(None);
    };
    let next_decided_ms = db.status_of(entry.id)?.and_then(|(_, ms)| ms);
    db.set_status(entry.id, &entry.prev, entry.prev_decided_ms)?;

    // Decrement counter for the undone decision
    let counter_name = match entry.next.as_str() {
        "kept" => "decision:kept",
        "skipped" => "decision:skipped",
        "staged" => "decision:staged",
        _ => "",
    };
    if !counter_name.is_empty() {
        let _ = db.incr_counter(counter_name, -1);
    }

    // Increment counter for undos
    let _ = db.incr_counter("session:undos", 1);

    crate::log::info(
        "undo",
        &format!("{} {} -> {}", entry.id, entry.next, entry.prev),
    );
    let id = entry.id;
    undo.push_redo(entry, next_decided_ms);
    db.shot(id)
}

/// The body of `redo_last`: applies the most recently undone action again,
/// while its row still shows the status the undo restored. A committed row is
/// never touched.
pub fn apply_redo(db: &Db, undo: &mut UndoStack) -> Result<Option<Shot>, String> {
    let entry = undo.pop_redo(|id| db.status_of(id).map(|row| row.map(|(status, _)| status)))?;
    let Some(entry) = entry else {
        return Ok(None);
    };
    db.set_status(entry.id, &entry.next, entry.next_decided_ms)?;

    // Increment counter for the redone decision
    let counter_name = match entry.next.as_str() {
        "kept" => "decision:kept",
        "skipped" => "decision:skipped",
        "staged" => "decision:staged",
        _ => "",
    };
    if !counter_name.is_empty() {
        let _ = db.incr_counter(counter_name, 1);
    }

    // Increment counter for redos
    let _ = db.incr_counter("session:redos", 1);

    crate::log::info(
        "redo",
        &format!("{} {} -> {}", entry.id, entry.prev, entry.next),
    );
    let id = entry.id;
    undo.push_redone(entry);
    db.shot(id)
}

#[tauri::command]
pub fn redo_last(state: State<'_, AppState>) -> Result<Option<Shot>, String> {
    let db = lock(&state.db);
    apply_redo(&db, &mut lock(&state.undo))
}

#[tauri::command]
pub fn undo_last(state: State<'_, AppState>) -> Result<Option<Shot>, String> {
    let db = lock(&state.db);
    apply_undo(&db, &mut lock(&state.undo))
}

/// The body of `unstage`. Only a staged row changes: a committed one is refused
/// (its file is in the Recycle Bin), and any other is returned as it is, so a
/// repeated click is harmless.
pub fn apply_unstage(db: &Db, undo: &mut UndoStack, id: i64) -> Result<Shot, String> {
    let before = db
        .shot(id)?
        .ok_or_else(|| format!("no such screenshot: {id}"))?;
    match before.status.as_str() {
        STATUS_STAGED => {}
        STATUS_DELETED => {
            return Err(format!("{} is already in the Recycle Bin", before.name));
        }
        _ => return Ok(before),
    }
    db.set_status(id, STATUS_PENDING, None)?;
    undo.push(UndoEntry {
        id,
        prev: before.status,
        prev_decided_ms: before.decided_ms,
        next: STATUS_PENDING.to_string(),
        next_decided_ms: None,
    });
    crate::log::info(
        "unstage",
        &format!("{id} {} -> {STATUS_PENDING}", before.name),
    );
    db.shot(id)?
        .ok_or_else(|| format!("no such screenshot: {id}"))
}

#[tauri::command]
pub fn unstage(state: State<'_, AppState>, id: i64) -> Result<Shot, String> {
    let db = lock(&state.db);
    apply_unstage(&db, &mut lock(&state.undo), id)
}

/// Unstages multiple screenshots at once, restoring them to pending status.
/// This respects the per-folder pile rules: each folder's pile is processed
/// independently. Returns the count of successfully unstaged items.
#[tauri::command]
#[allow(dead_code)]
pub fn unstage_multiple(state: State<'_, AppState>, ids: Vec<i64>) -> Result<usize, String> {
    let db = lock(&state.db);
    let mut undo = lock(&state.undo);
    let mut count = 0;
    for id in ids {
        if apply_unstage(&db, &mut undo, id).is_ok() {
            count += 1;
        }
    }
    crate::log::info(
        "unstage_multiple",
        &format!("{count} file(s) restored from the pile"),
    );
    Ok(count)
}

#[tauri::command]
pub fn staged_list(state: State<'_, AppState>, root_id: Option<i64>) -> Result<Vec<Shot>, String> {
    let db = lock(&state.db);
    let ids = db.queue_ids("staged", None, root_id, 0)?;
    db.items(&ids)
}

/// Sends each staged file to the Windows Recycle Bin, one at a time so a single
/// locked file does not hold back the rest.
///
/// This is the only place files ever leave the disk, and it is never implicit:
/// a swipe left only marks a row as `staged`. It touches no database state,
/// which is what lets `commit_deletes` run it on a worker without the lock.
pub fn trash_staged(rows: Vec<StagedRow>) -> TrashOutcome {
    let mut outcome = TrashOutcome::default();
    for row in rows {
        match trash::delete(&row.path) {
            Ok(()) => outcome.moved.push(row),
            Err(e) => {
                crate::log::warn("commit", &format!("{}: {e}", row.name));
                outcome.failed.push(FailedItem {
                    id: row.id,
                    gone: !Path::new(&row.path).exists(),
                    name: row.name,
                    error: e.to_string(),
                });
            }
        }
    }
    outcome
}

/// Writes a Recycle Bin pass back to the database. Moved files become
/// `deleted`, and so does a file that had already vanished, since there is
/// nothing left to move. Anything else that failed stays staged so the user
/// can retry or unstage it. `root_id` is the pile the rows came from.
pub fn apply_commit(
    db: &Db,
    undo: &mut UndoStack,
    root_id: Option<i64>,
    outcome: TrashOutcome,
) -> Result<CommitReport, String> {
    let TrashOutcome { moved, failed } = outcome;
    let gone: Vec<i64> = failed.iter().filter(|f| f.gone).map(|f| f.id).collect();
    let done: Vec<i64> = moved
        .iter()
        .map(|r| r.id)
        .chain(gone.iter().copied())
        .collect();
    // These files are off the disk whether or not the writes below succeed, so
    // their undo entries go first.
    undo.purge(&done);
    let now = scan::now_ms();
    for &id in &done {
        db.set_status(id, STATUS_DELETED, Some(now))?;
    }

    // Increment deletion counters
    let _ = db.incr_counter("deletion:files_deleted", moved.len() as i64);
    let bytes_freed: i64 = moved.iter().map(|r| r.size).sum();
    let _ = db.incr_counter("deletion:bytes_deleted", bytes_freed);
    let _ = db.incr_counter("session:commits", 1);

    let (still_staged, _) = db.staged_totals(root_id)?;
    let report = CommitReport {
        deleted: moved.len(),
        bytes_freed,
        still_staged: still_staged as usize,
        failed,
    };
    crate::log::info(
        "commit",
        &format!(
            "{} moved to the Recycle Bin ({} bytes), {} already gone, {} failed, {} still staged",
            report.deleted,
            report.bytes_freed,
            gone.len(),
            report.failed.len() - gone.len(),
            report.still_staged
        ),
    );
    Ok(report)
}

/// Sends the deletion pile of one folder (or, without `root_id`, every
/// folder) to the Recycle Bin.
///
/// Reading the staged list and writing the results back are fast queries done
/// under the lock; the Recycle Bin calls in between (which shell out and can
/// block) run on a worker without it. Progress events are emitted periodically.
#[tauri::command]
pub async fn commit_deletes(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    root_id: Option<i64>,
) -> Result<CommitReport, String> {
    let rows = lock(&state.db).staged_rows(root_id)?;
    let total = rows.len();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut outcome = TrashOutcome::default();
        for (idx, row) in rows.into_iter().enumerate() {
            // Emit progress every 5 files or at the end
            if idx % 5 == 0 || idx == total - 1 {
                let _ = app.emit(
                    "commit-progress",
                    CommitProgress {
                        current: idx,
                        total,
                        current_file: row.name.clone(),
                    },
                );
            }
            match trash::delete(&row.path) {
                Ok(()) => outcome.moved.push(row),
                Err(e) => {
                    crate::log::warn("commit", &format!("{}: {e}", row.name));
                    outcome.failed.push(FailedItem {
                        id: row.id,
                        gone: !Path::new(&row.path).exists(),
                        name: row.name,
                        error: e.to_string(),
                    });
                }
            }
        }
        outcome
    })
    .await
    .map_err(|e| e.to_string())?;
    let db = lock(&state.db);
    apply_commit(&db, &mut lock(&state.undo), root_id, outcome)
}

#[tauri::command]
pub fn find_duplicates(
    state: State<'_, AppState>,
    root_id: i64,
) -> Result<Vec<crate::dupes::DuplicateGroup>, String> {
    let db = lock(&state.db);
    crate::dupes::find_duplicates(&db, root_id)
}

#[tauri::command]
pub fn get_counters(state: State<'_, AppState>) -> Result<Vec<CounterGroup>, String> {
    let db = lock(&state.db);
    let all = db.get_all_counters()?;

    let mut groups = Vec::new();

    // Decision counters
    let decision_counters: Vec<_> = all
        .iter()
        .filter(|(k, _)| k.starts_with("decision:"))
        .map(|(k, v)| (k.strip_prefix("decision:").unwrap_or("").to_string(), *v))
        .collect();
    if !decision_counters.is_empty() {
        groups.push(CounterGroup {
            name: "decision".to_string(),
            label: "Decisions".to_string(),
            counters: decision_counters,
        });
    }

    // Deletion counters
    let deletion_counters: Vec<_> = all
        .iter()
        .filter(|(k, _)| k.starts_with("deletion:"))
        .map(|(k, v)| (k.strip_prefix("deletion:").unwrap_or("").to_string(), *v))
        .collect();
    if !deletion_counters.is_empty() {
        groups.push(CounterGroup {
            name: "deletion".to_string(),
            label: "Deletion".to_string(),
            counters: deletion_counters,
        });
    }

    // The remaining groups share one shape: a prefix, a group id and a label.
    for (prefix, name, label) in [
        ("swipe:", "swipe", "Swipes"),
        ("review:", "review", "Review"),
        ("session:", "session", "Session"),
    ] {
        let counters: Vec<_> = all
            .iter()
            .filter(|(k, _)| k.starts_with(prefix))
            .map(|(k, v)| (k.strip_prefix(prefix).unwrap_or("").to_string(), *v))
            .collect();
        if !counters.is_empty() {
            groups.push(CounterGroup {
                name: name.to_string(),
                label: label.to_string(),
                counters,
            });
        }
    }

    Ok(groups)
}

#[tauri::command]
pub fn reset_counters(state: State<'_, AppState>, group: Option<String>) -> Result<(), String> {
    let db = lock(&state.db);
    if let Some(g) = group {
        db.reset_counter_group(&g)?;
    } else {
        db.reset_all_counters()?;
    }
    Ok(())
}

#[tauri::command]
#[allow(dead_code)]
pub fn incr_counter(state: State<'_, AppState>, name: String, amount: i64) -> Result<(), String> {
    let db = lock(&state.db);
    db.incr_counter(&name, amount)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Three pending shots in root 1, sized 100, 200 and 300 bytes.
    fn setup() -> (Db, UndoStack) {
        let db = Db::open_in_memory().expect("in-memory db");
        let root = db.upsert_root("/photos").unwrap();
        for i in 1..=3 {
            db.upsert_shot(
                root,
                &format!("/photos/{i}.png"),
                &format!("{i}.png"),
                "png",
                100 * i,
                1_000 * i,
                None,
                None,
                "filename",
            )
            .unwrap();
        }
        (db, UndoStack::new(200))
    }

    fn status(db: &Db, id: i64) -> (String, Option<i64>) {
        db.status_of(id).unwrap().unwrap()
    }

    /// What `trash_staged` reports when every staged file moves.
    fn all_moved(db: &Db) -> TrashOutcome {
        TrashOutcome {
            moved: db.staged_rows(None).unwrap(),
            failed: Vec::new(),
        }
    }

    #[cfg(windows)]
    #[test]
    fn explorer_select_quotes_only_the_path() {
        // The whole `/select,...` token must stay unquoted: with a space in the
        // path, `"/select,C:\a b\c.png"` makes explorer open Documents instead.
        let arg = explorer_select_arg(Path::new(r"C:\Users\a b\shot.png"));
        assert_eq!(arg, r#"/select,"C:\Users\a b\shot.png""#);
        assert!(
            !arg.starts_with('"'),
            "the /select, prefix must not be quoted"
        );
        // Forward slashes are normalised so a stored non-Windows separator
        // still resolves.
        assert_eq!(
            explorer_select_arg(Path::new("C:/Users/a b/shot.png")),
            r#"/select,"C:\Users\a b\shot.png""#
        );
    }

    #[test]
    fn load_rgba_decodes_an_image_to_straight_rgba() {
        let dir = std::env::temp_dir().join(format!("shotpile-rgba-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tiny.png");
        // 2x1: a red pixel and a translucent blue one.
        let mut img = image::RgbaImage::new(2, 1);
        img.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        img.put_pixel(1, 0, image::Rgba([0, 0, 255, 128]));
        img.save(&path).unwrap();

        let (w, h, bytes) = load_rgba(&path).unwrap();
        assert_eq!((w, h), (2, 1));
        assert_eq!(bytes, vec![255, 0, 0, 255, 0, 0, 255, 128]);

        // Tests may clean up the temp folders they create themselves.
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn undo_walks_decisions_back_with_their_times() {
        let (db, mut undo) = setup();
        apply_decision(&db, &mut undo, 1, "keep", None, None).unwrap();
        let kept_at = status(&db, 1).1;
        apply_decision(&db, &mut undo, 1, "skip", None, None).unwrap();

        let shot = apply_undo(&db, &mut undo).unwrap().unwrap();
        assert_eq!(
            (shot.status.as_str(), shot.decided_ms),
            (STATUS_KEPT, kept_at)
        );
        let shot = apply_undo(&db, &mut undo).unwrap().unwrap();
        assert_eq!(
            (shot.status.as_str(), shot.decided_ms),
            (STATUS_PENDING, None)
        );
        assert!(apply_undo(&db, &mut undo).unwrap().is_none());
    }

    #[test]
    fn redo_reapplies_an_undone_decision_with_its_time() {
        let (db, mut undo) = setup();
        apply_decision(&db, &mut undo, 1, "delete", None, None).unwrap();
        let decided = status(&db, 1);
        apply_undo(&db, &mut undo).unwrap().unwrap();
        assert_eq!(status(&db, 1).0, STATUS_PENDING);
        let shot = apply_redo(&db, &mut undo).unwrap().unwrap();
        assert_eq!(shot.status, STATUS_STAGED);
        assert_eq!(status(&db, 1), decided);
        assert!(apply_redo(&db, &mut undo).unwrap().is_none());
        // And it can be undone again.
        apply_undo(&db, &mut undo).unwrap().unwrap();
        assert_eq!(status(&db, 1).0, STATUS_PENDING);
    }

    #[test]
    fn redo_never_touches_a_committed_row() {
        let (db, mut undo) = setup();
        apply_decision(&db, &mut undo, 1, "delete", None, None).unwrap();
        apply_undo(&db, &mut undo).unwrap();
        db.set_status(1, STATUS_DELETED, Some(1)).unwrap();
        assert!(apply_redo(&db, &mut undo).unwrap().is_none());
        assert_eq!(status(&db, 1).0, STATUS_DELETED);
    }

    #[test]
    fn undoing_an_unstage_restores_the_original_stage_time() {
        let (db, mut undo) = setup();
        apply_decision(&db, &mut undo, 2, "delete", None, None).unwrap();
        let staged_at = status(&db, 2).1;
        assert!(staged_at.is_some());

        let shot = apply_unstage(&db, &mut undo, 2).unwrap();
        assert_eq!(shot.status, STATUS_PENDING);
        assert!(db.staged_rows(None).unwrap().is_empty());

        let shot = apply_undo(&db, &mut undo).unwrap().unwrap();
        assert_eq!(
            (shot.status.as_str(), shot.decided_ms),
            (STATUS_STAGED, staged_at)
        );
        assert_eq!(
            db.staged_rows(None).unwrap().len(),
            1,
            "back on the staged list"
        );
    }

    #[test]
    fn unstage_leaves_a_row_that_is_not_staged_alone() {
        let (db, mut undo) = setup();
        apply_decision(&db, &mut undo, 1, "keep", None, None).unwrap();
        let shot = apply_unstage(&db, &mut undo, 1).unwrap();
        assert_eq!(shot.status, STATUS_KEPT);
        assert_eq!(undo.len(), 1, "nothing new to undo");
        assert!(apply_unstage(&db, &mut undo, 999).is_err());
    }

    #[test]
    fn undo_after_a_commit_does_not_resurrect_the_row() {
        let (db, mut undo) = setup();
        apply_decision(&db, &mut undo, 1, "keep", None, None).unwrap();
        apply_decision(&db, &mut undo, 2, "delete", None, None).unwrap();
        let report = apply_commit(&db, &mut undo, None, all_moved(&db)).unwrap();
        assert_eq!(report.deleted, 1);
        assert_eq!(report.bytes_freed, 200);
        assert_eq!(report.still_staged, 0);

        // The delete was the newest action, but it is committed: undo walks
        // back the keep before it instead.
        assert_eq!(apply_undo(&db, &mut undo).unwrap().unwrap().id, 1);
        assert!(apply_undo(&db, &mut undo).unwrap().is_none());
        assert_eq!(status(&db, 2).0, STATUS_DELETED);
        assert!(db.staged_rows(None).unwrap().is_empty());
    }

    #[test]
    fn undo_refuses_a_committed_row_even_if_its_entry_survived() {
        // Belt and braces: without the commit's purge, the status check alone
        // still keeps the row deleted.
        let (db, mut undo) = setup();
        apply_decision(&db, &mut undo, 2, "delete", None, None).unwrap();
        db.set_status(2, STATUS_DELETED, Some(1)).unwrap();
        assert!(apply_undo(&db, &mut undo).unwrap().is_none());
        assert_eq!(status(&db, 2).0, STATUS_DELETED);
    }

    #[test]
    fn a_committed_row_cannot_be_decided_or_unstaged_again() {
        let (db, mut undo) = setup();
        apply_decision(&db, &mut undo, 2, "delete", None, None).unwrap();
        apply_commit(&db, &mut undo, None, all_moved(&db)).unwrap();
        for kind in ["keep", "skip", "delete"] {
            assert!(apply_decision(&db, &mut undo, 2, kind, None, None).is_err());
        }
        assert!(apply_unstage(&db, &mut undo, 2).is_err());
        assert_eq!(status(&db, 2).0, STATUS_DELETED);
        assert!(undo.is_empty());
    }

    #[test]
    fn commit_settles_gone_files_and_keeps_real_failures_staged() {
        let (db, mut undo) = setup();
        for id in 1..=3 {
            apply_decision(&db, &mut undo, id, "delete", None, None).unwrap();
        }
        let rows = db.staged_rows(None).unwrap();
        let (moved, gone, stuck) = (&rows[0], &rows[1], &rows[2]);
        let outcome = TrashOutcome {
            moved: vec![moved.clone()],
            failed: vec![
                FailedItem {
                    id: gone.id,
                    name: gone.name.clone(),
                    error: "not found".into(),
                    gone: true,
                },
                FailedItem {
                    id: stuck.id,
                    name: stuck.name.clone(),
                    error: "in use".into(),
                    gone: false,
                },
            ],
        };

        let report = apply_commit(&db, &mut undo, None, outcome).unwrap();
        assert_eq!(report.deleted, 1);
        assert_eq!(report.bytes_freed, moved.size, "a gone file freed nothing");
        assert_eq!(report.failed.len(), 2);
        assert_eq!(report.still_staged, 1);
        assert_eq!(status(&db, moved.id).0, STATUS_DELETED);
        assert_eq!(status(&db, gone.id).0, STATUS_DELETED);
        assert_eq!(status(&db, stuck.id).0, STATUS_STAGED);
        // Only the file still on disk can be walked back.
        assert_eq!(apply_undo(&db, &mut undo).unwrap().unwrap().id, stuck.id);
        assert!(apply_undo(&db, &mut undo).unwrap().is_none());
    }

    #[test]
    fn forgetting_a_root_purges_its_undo_entries() {
        let (db, mut undo) = setup();
        let other = db.upsert_root("/elsewhere").unwrap();
        db.upsert_shot(
            other,
            "/elsewhere/x.png",
            "x.png",
            "png",
            1,
            1,
            None,
            None,
            "filename",
        )
        .unwrap();
        let x = db.queue_ids("unreviewed", None, Some(other), 0).unwrap()[0];
        apply_decision(&db, &mut undo, 1, "delete", None, None).unwrap();
        apply_decision(&db, &mut undo, x, "keep", None, None).unwrap();

        apply_forget_root(&db, &mut undo, 1).unwrap();
        assert_eq!(undo.len(), 1, "only the other root's entry is left");
        assert_eq!(apply_undo(&db, &mut undo).unwrap().unwrap().id, x);
        assert!(
            apply_forget_root(&db, &mut undo, 1).is_err(),
            "already forgotten"
        );
    }

    #[test]
    fn walking_a_folder_that_does_not_exist_is_a_plain_error() {
        let err = walk("/definitely/not/a/shotpile/folder").unwrap_err();
        assert!(err.starts_with("folder not found: "), "{err}");
    }
}
