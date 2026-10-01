//! Minimal file logger.
//!
//! Writes leveled, timestamped lines to `<app_data>/logs/shotpile.log` so a
//! release build can be diagnosed after the fact, even when DevTools was never
//! opened. Deliberately dependency-free: just `fs`, `Mutex` and `chrono`.
//!
//! The file is appended to and rotated once it passes [`MAX_BYTES`]; the
//! previous contents are kept as `shotpile.log.old` so a crash right after a big
//! scan is still recoverable.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Rotate the log once it grows past this.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// The date is part of every stamp: one file spans days between rotations, and
/// a bare clock time cannot say which day a line belongs to.
const TIMESTAMP_FORMAT: &str = "%Y-%m-%d %H:%M:%S%.3f";

/// Longest message, in characters, taken from outside the backend (the
/// frontend, a panic payload) before it is cut.
pub const MAX_MSG_CHARS: usize = 4000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

    /// Maps a level name from the frontend, ignoring case. Anything unknown
    /// logs at INFO instead of being dropped: a typo in a level name should not
    /// cost the line.
    pub fn from_name(name: &str) -> Level {
        match name.to_ascii_lowercase().as_str() {
            "debug" => Level::Debug,
            "info" => Level::Info,
            "warn" => Level::Warn,
            "error" => Level::Error,
            _ => Level::Info,
        }
    }
}

struct Sink {
    file: File,
    path: PathBuf,
    /// Bytes in the current file. Tracked here so the rotation check is a
    /// comparison instead of a `metadata()` syscall on every line.
    size: u64,
}

static SINK: OnceLock<Mutex<Option<Sink>>> = OnceLock::new();

fn sink() -> &'static Mutex<Option<Sink>> {
    SINK.get_or_init(|| Mutex::new(None))
}

/// Opens `path` for appending, along with its current size.
fn open_append(path: &Path) -> std::io::Result<(File, u64)> {
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    Ok((file, size))
}

/// Opens (or creates) the log file. Called once from `run()` after the app data
/// directory exists. A failure here is not fatal: the app works without a log.
pub fn init(path: &Path) {
    let mut guard = sink().lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() {
        return;
    }
    let (file, size) = match open_append(path) {
        Ok(opened) => opened,
        Err(e) => {
            eprintln!("log: couldn't open {}: {e}", path.display());
            return;
        }
    };
    *guard = Some(Sink {
        file,
        path: path.to_path_buf(),
        size,
    });
}

fn rotate(sink: &mut Sink) {
    let _ = sink.file.flush();
    let old = sink.path.with_extension("log.old");
    let _ = std::fs::rename(&sink.path, &old);
    if let Ok((file, size)) = open_append(&sink.path) {
        sink.file = file;
        sink.size = size;
    }
}

/// `[2026-10-01 13:05:09.042] WARN  [scope] msg`, newline included.
fn format_line(at: &chrono::NaiveDateTime, level: Level, scope: &str, msg: &str) -> String {
    format!(
        "[{}] {:5} [{scope}] {msg}\n",
        at.format(TIMESTAMP_FORMAT),
        level.as_str()
    )
}

pub fn log(level: Level, scope: &str, msg: &str) {
    // Formatted before the lock is taken, so nothing that runs under the lock
    // can panic. The panic hook logs too, and a panic on a thread that already
    // held the lock would hang it instead of letting the process abort.
    let line = format_line(&chrono::Local::now().naive_local(), level, scope, msg);
    let mut guard = sink().lock().unwrap_or_else(|e| e.into_inner());
    let Some(sink) = guard.as_mut() else {
        return;
    };
    if sink.size >= MAX_BYTES {
        rotate(sink);
    }
    if sink.file.write_all(line.as_bytes()).is_ok() {
        sink.size += line.len() as u64;
    }
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

/// Makes text safe for a single log line. Each line break (`\r\n`, `\n` or
/// `\r`) becomes " ⏎ ", so one entry never spans lines (`read_tail` and the
/// in-app viewer count lines), and text past `max_chars` characters is cut on a
/// char boundary and marked with "…".
pub fn one_line(text: &str, max_chars: usize) -> String {
    let mut out = String::with_capacity(text.len().min(max_chars.saturating_mul(4)));
    let mut chars = text.chars().peekable();
    let mut taken = 0;
    while let Some(c) = chars.next() {
        if taken == max_chars {
            out.push('…');
            break;
        }
        taken += 1;
        match c {
            '\r' => {
                chars.next_if_eq(&'\n');
                out.push_str(" ⏎ ");
            }
            '\n' => out.push_str(" ⏎ "),
            c => out.push(c),
        }
    }
    out
}

/// Routes panics into the file log. Release builds use `panic = "abort"`, so a
/// panic ends the process on the spot and, without this, leaves no trace on a
/// machine where nobody had a console open. The previous hook still runs
/// afterwards, so debug builds keep their stderr report.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let msg = payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
            .unwrap_or("(no message)");
        let at = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "an unknown location".to_string());
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<unnamed>");
        error(
            "panic",
            &one_line(
                &format!("thread '{name}' panicked at {at}: {msg}"),
                MAX_MSG_CHARS,
            ),
        );
        previous(info);
    }));
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

    /// The sink is process-wide and tests run in parallel, so every test that
    /// opens or resets it holds this; otherwise one test's reset lands in the
    /// middle of another's write-then-read.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shotpile-log-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn init_writes_lines_and_read_tail_returns_them() {
        let _serial = serial();
        let dir = scratch("tail");
        let path = dir.join("shotpile.log");

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
        let _serial = serial();
        _reset_for_tests();
        assert_eq!(read_tail(10), "");
        assert!(path().is_none());
    }

    #[test]
    fn lines_are_stamped_with_the_date_and_milliseconds() {
        let at = chrono::NaiveDate::from_ymd_opt(2026, 10, 1)
            .unwrap()
            .and_hms_milli_opt(13, 5, 9, 42)
            .unwrap();
        assert_eq!(
            format_line(&at, Level::Warn, "scan", "slow"),
            "[2026-10-01 13:05:09.042] WARN  [scan] slow\n"
        );
        assert_eq!(
            format_line(&at, Level::Error, "boot", "x"),
            "[2026-10-01 13:05:09.042] ERROR [boot] x\n"
        );
    }

    #[test]
    fn level_names_map_case_insensitively_and_default_to_info() {
        assert_eq!(Level::from_name("debug"), Level::Debug);
        assert_eq!(Level::from_name("INFO"), Level::Info);
        assert_eq!(Level::from_name("Warn"), Level::Warn);
        assert_eq!(Level::from_name("eRRoR"), Level::Error);
        assert_eq!(Level::from_name("warning"), Level::Info);
        assert_eq!(Level::from_name(""), Level::Info);
    }

    #[test]
    fn one_line_flattens_line_breaks() {
        assert_eq!(one_line("a\nb", 100), "a ⏎ b");
        assert_eq!(one_line("a\r\nb\rc", 100), "a ⏎ b ⏎ c");
        assert_eq!(one_line("plain", 100), "plain");
        assert!(!one_line("x\n\ny\r\n", 100).contains(['\n', '\r']));
    }

    #[test]
    fn one_line_cuts_long_text_on_a_char_boundary() {
        // Exactly at the cap: kept whole, no marker.
        assert_eq!(one_line("abcd", 4), "abcd");
        // Past it: cut and marked.
        assert_eq!(one_line("abcdef", 4), "abcd…");
        // Multi-byte characters count as one each and are never split: two,
        // three and four bytes (the emoji) alike.
        assert_eq!(one_line("λ€日\u{1F600}x", 4), "λ€日\u{1F600}…");
        assert_eq!(
            one_line("\u{1F600}\u{1F600}\u{1F600}", 2),
            "\u{1F600}\u{1F600}…"
        );
        let long = "€".repeat(MAX_MSG_CHARS + 10);
        let cut = one_line(&long, MAX_MSG_CHARS);
        assert_eq!(cut.chars().count(), MAX_MSG_CHARS + 1);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn panic_hook_logs_the_message_and_location() {
        let _serial = serial();
        let dir = scratch("panic");
        _reset_for_tests();
        init(&dir.join("shotpile.log"));

        install_panic_hook();
        let line = line!() + 1;
        let joined = std::thread::spawn(|| panic!("boom {}", 42)).join();
        // Put the default hook back so later panics in this process are not
        // routed into this test's log.
        let _ = std::panic::take_hook();
        assert!(joined.is_err());

        let tail = read_tail(1000);
        assert!(tail.contains("ERROR [panic]"), "tail was: {tail}");
        assert!(tail.contains("boom 42"), "tail was: {tail}");
        assert!(
            tail.contains(&format!("{}:{line}:", file!())),
            "tail was: {tail}"
        );

        _reset_for_tests();
        std::fs::remove_dir_all(&dir).ok();
    }
}
