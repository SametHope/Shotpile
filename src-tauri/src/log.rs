//! Minimal file logger.
//!
//! Writes leveled, timestamped lines to `<app_data>/logs/sifter.log` so a
//! release build can be diagnosed after the fact, even when DevTools was never
//! opened. Deliberately dependency-free: just `fs`, `Mutex` and `chrono`.
//!
//! The file is appended to and rotated once it passes [`MAX_BYTES`]; the
//! previous contents are kept as `sifter.log.old` so a crash right after a big
//! scan is still recoverable.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Rotate the log once it grows past this.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

struct Sink {
    file: File,
    path: PathBuf,
}

static SINK: OnceLock<Mutex<Option<Sink>>> = OnceLock::new();

fn sink() -> &'static Mutex<Option<Sink>> {
    SINK.get_or_init(|| Mutex::new(None))
}

/// Opens (or creates) the log file. Called once from `run()` after the app data
/// directory exists. A failure here is not fatal: the app works without a log.
pub fn init(path: &Path) {
    let mut guard = sink().lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() {
        return;
    }
    let file = match OpenOptions::new().create(true).append(true).open(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("log: {} açılamadı: {e}", path.display());
            return;
        }
    };
    *guard = Some(Sink {
        file,
        path: path.to_path_buf(),
    });
}

fn rotate(sink: &mut Sink) {
    let _ = sink.file.flush();
    let old = sink.path.with_extension("log.old");
    let _ = std::fs::rename(&sink.path, &old);
    if let Ok(f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&sink.path)
    {
        sink.file = f;
    }
}

pub fn log(level: Level, scope: &str, msg: &str) {
    let mut guard = sink().lock().unwrap_or_else(|e| e.into_inner());
    let Some(sink) = guard.as_mut() else {
        return;
    };
    if sink
        .file
        .metadata()
        .map(|m| m.len() >= MAX_BYTES)
        .unwrap_or(false)
    {
        rotate(sink);
    }
    let now = chrono::Local::now().format("%H:%M:%S%.3f");
    let _ = sink
        .file
        .write_all(format!("[{now}] {:5} [{}] {msg}\n", level.as_str(), scope).as_bytes());
    let _ = sink.file.flush();
}

pub fn debug(scope: &str, msg: &str) {
    log(Level::Debug, scope, msg);
}
pub fn info(scope: &str, msg: &str) {
    log(Level::Info, scope, msg);
}
pub fn warn(scope: &str, msg: &str) {
    log(Level::Warn, scope, msg);
}
pub fn error(scope: &str, msg: &str) {
    log(Level::Error, scope, msg);
}

/// The last `max_lines` lines of the log, oldest first.
pub fn read_tail(max_lines: usize) -> String {
    let guard = sink().lock().unwrap_or_else(|e| e.into_inner());
    let Some(sink) = guard.as_ref() else {
        return String::new();
    };
    let Ok(text) = std::fs::read_to_string(&sink.path) else {
        return String::new();
    };
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() > max_lines {
        lines[lines.len() - max_lines..].join("\n")
    } else {
        text
    }
}

pub fn path() -> Option<PathBuf> {
    let guard = sink().lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().map(|s| s.path.clone())
}

/// Test seam: drop the sink so a fresh `init` can run.
#[doc(hidden)]
pub fn _reset_for_tests() {
    let mut guard = sink().lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_writes_lines_and_read_tail_returns_them() {
        let dir = std::env::temp_dir().join(format!("sifter-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sifter.log");

        _reset_for_tests();
        init(&path);
        info("test", "hello");
        warn("test", "world");

        let tail = read_tail(10);
        assert!(tail.contains("hello"), "tail was: {tail}");
        assert!(tail.contains("world"), "tail was: {tail}");
        assert!(tail.contains("INFO"), "tail was: {tail}");

        _reset_for_tests();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_tail_without_init_is_empty() {
        _reset_for_tests();
        assert_eq!(read_tail(10), "");
        assert!(path().is_none());
    }
}
