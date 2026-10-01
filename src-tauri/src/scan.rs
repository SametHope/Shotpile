use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{Local, NaiveDate, NaiveTime, TimeZone};
use regex::Regex;
use walkdir::WalkDir;

/// Extensions tracked as screenshots. Everything else in the tree is ignored.
pub const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "jfif", "webp", "bmp", "gif", "tif", "tiff", "avif", "heic", "heif",
];

/// Extensions WebView2 can actually decode. The rest are still tracked (so they
/// can be reviewed by name and deleted) but render as a placeholder.
pub const VIEWABLE_EXTS: &[&str] = &["png", "jpg", "jpeg", "jfif", "webp", "bmp", "gif", "avif"];

pub fn is_image(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext.to_ascii_lowercase().as_str())
}

pub fn is_viewable(ext: &str) -> bool {
    VIEWABLE_EXTS.contains(&ext.to_ascii_lowercase().as_str())
}

pub fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default()
}

struct Patterns {
    /// 2026-09-27 / 2026.09.27 / 2026_09_27
    iso: Regex,
    /// 20260927
    compact: Regex,
    /// 27.09.2026 (day-first, the common local format)
    dotted: Regex,
    /// 21-42-12 / 21.42.12 / 21 42 12
    time_sep: Regex,
    /// 214212
    time_compact: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| Patterns {
        // The `regex` crate has no lookaround, so digit boundaries are checked
        // separately via `digit_bounded`.
        iso: Regex::new(r"(\d{4})[-_.](\d{1,2})[-_.](\d{1,2})").unwrap(),
        compact: Regex::new(r"(\d{4})(\d{2})(\d{2})").unwrap(),
        dotted: Regex::new(r"(\d{1,2})[-_.](\d{1,2})[-_.](\d{4})").unwrap(),
        time_sep: Regex::new(r"(\d{1,2})[-_. ](\d{1,2})[-_. ](\d{1,2})").unwrap(),
        time_compact: Regex::new(r"(\d{2})(\d{2})(\d{2})").unwrap(),
    })
}

/// True when the match at `start..end` is not glued to other digits.
fn digit_bounded(s: &str, start: usize, end: usize) -> bool {
    let before = s[..start]
        .chars()
        .next_back()
        .is_some_and(|c| c.is_ascii_digit());
    let after = s[end..].chars().next().is_some_and(|c| c.is_ascii_digit());
    !before && !after
}

/// Pulls a clock time out of the text following a date.
///
/// `time_sep` is tried first: with a name like `_21-42-12_123456` it keeps a
/// trailing digit run from being mistaken for the time. Then `time_compact`
/// walks every 6-digit run and keeps the first that is not glued to a longer
/// number, which is what makes `20260927_143055` work while `20260102_20260102`
/// still resolves to the trailing time.
fn find_time_ms(stem: &str, from: usize) -> Option<(u32, u32, u32)> {
    let p = patterns();
    let tail = &stem[from..];
    let triple = |caps: &regex::Captures<'_>| -> Option<(u32, u32, u32)> {
        let h: u32 = caps[1].parse().ok()?;
        let mi: u32 = caps[2].parse().ok()?;
        let s: u32 = caps[3].parse().ok()?;
        (h <= 23 && mi <= 59 && s <= 59).then_some((h, mi, s))
    };
    for caps in p.time_sep.captures_iter(tail) {
        if let Some(t) = triple(&caps) {
            return Some(t);
        }
    }
    for caps in p.time_compact.captures_iter(tail) {
        let m = caps.get(0).unwrap();
        if !digit_bounded(tail, m.start(), m.end()) {
            continue;
        }
        if let Some(t) = triple(&caps) {
            return Some(t);
        }
    }
    None
}

fn to_local_ms(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> Option<i64> {
    let date = NaiveDate::from_ymd_opt(y, mo, d)?;
    let time = NaiveTime::from_hms_opt(h, mi, s)?;
    Local
        .from_local_datetime(&date.and_time(time))
        .earliest()
        .map(|dt| dt.timestamp_millis())
}

fn ms_of(t: Option<SystemTime>) -> Option<i64> {
    t.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

/// Best guess at when a screenshot was actually taken.
///
/// Order: a date in the filename (most screenshot tools embed one), then the
/// file's creation time, then its modified time. Modified time alone is
/// unreliable because copying a folder rewrites it, so it is the last resort.
pub fn infer_taken_ms(
    stem: &str,
    created: Option<SystemTime>,
    modified: Option<SystemTime>,
) -> (i64, &'static str) {
    let p = patterns();
    let now = now_ms();

    let mut candidates: Vec<(i32, u32, u32, usize)> = Vec::new();
    for caps in p.iso.captures_iter(stem) {
        let m = caps.get(0).unwrap();
        if !digit_bounded(stem, m.start(), m.end()) {
            continue;
        }
        if let (Ok(y), Ok(mo), Ok(d)) = (
            caps[1].parse::<i32>(),
            caps[2].parse::<u32>(),
            caps[3].parse::<u32>(),
        ) {
            candidates.push((y, mo, d, m.end()));
        }
    }
    for caps in p.compact.captures_iter(stem) {
        let m = caps.get(0).unwrap();
        if !digit_bounded(stem, m.start(), m.end()) {
            continue;
        }
        if let (Ok(y), Ok(mo), Ok(d)) = (
            caps[1].parse::<i32>(),
            caps[2].parse::<u32>(),
            caps[3].parse::<u32>(),
        ) {
            candidates.push((y, mo, d, m.end()));
        }
    }
    for caps in p.dotted.captures_iter(stem) {
        let m = caps.get(0).unwrap();
        if !digit_bounded(stem, m.start(), m.end()) {
            continue;
        }
        if let (Ok(d), Ok(mo), Ok(y)) = (
            caps[1].parse::<u32>(),
            caps[2].parse::<u32>(),
            caps[3].parse::<i32>(),
        ) {
            candidates.push((y, mo, d, m.end()));
        }
    }

    for (y, mo, d, end) in candidates {
        let (h, mi, s) = find_time_ms(stem, end).unwrap_or((12, 0, 0));
        if let Some(ms) = to_local_ms(y, mo, d, h, mi, s) {
            return (ms, "filename");
        }
        // A date without a usable time still beats file metadata.
        if let Some(ms) = to_local_ms(y, mo, d, 12, 0, 0) {
            return (ms, "filename");
        }
    }

    if let Some(ms) = ms_of(created) {
        return (ms, "created");
    }
    if let Some(ms) = ms_of(modified) {
        return (ms, "modified");
    }
    (now, "unknown")
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScannedFile {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub size: i64,
    pub taken_ms: i64,
    pub created_ms: Option<i64>,
    pub modified_ms: Option<i64>,
    pub date_source: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CollectStats {
    pub found: usize,
    pub skipped_other: usize,
    pub unreadable: usize,
    pub dirs: usize,
}

/// Walks `root` and returns every image file it can stat, reporting the running
/// count of images found after each one so a caller can show progress on a big
/// tree (the callback runs on the walking thread; throttling is the caller's
/// business).
///
/// Symlinks are not followed, dot-directories are skipped, and a failing stat is
/// counted rather than aborting the whole scan.
pub fn collect(root: &Path, mut progress: impl FnMut(usize)) -> (Vec<ScannedFile>, CollectStats) {
    let mut out = Vec::new();
    let mut stats = CollectStats::default();

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(e.file_type().is_dir() && name.starts_with('.'))
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                stats.unreadable += 1;
                continue;
            }
        };
        if entry.file_type().is_dir() {
            stats.dirs += 1;
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }

        let path: PathBuf = entry.path().to_path_buf();
        let name = entry.file_name().to_string_lossy().to_string();
        let ext = ext_of(&name);
        if !is_image(&ext) {
            stats.skipped_other += 1;
            continue;
        }

        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => {
                stats.unreadable += 1;
                continue;
            }
        };
        let created = meta.created().ok();
        let modified = meta.modified().ok();
        let stem = Path::new(&name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| name.clone());
        let (taken_ms, source) = infer_taken_ms(&stem, created, modified);

        out.push(ScannedFile {
            path: path.to_string_lossy().to_string(),
            name,
            ext: ext.to_ascii_lowercase(),
            size: meta.len() as i64,
            taken_ms,
            created_ms: ms_of(created),
            modified_ms: ms_of(modified),
            date_source: source.to_string(),
        });
        stats.found += 1;
        progress(stats.found);
    }

    (out, stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, Timelike};
    use std::time::Duration;

    fn parts(ms: i64) -> (i32, u32, u32, u32, u32, u32) {
        let dt = chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .with_timezone(&Local);
        (
            dt.year(),
            dt.month(),
            dt.day(),
            dt.hour(),
            dt.minute(),
            dt.second(),
        )
    }

    #[test]
    fn parses_windows_style_filename_with_separated_time() {
        let (ms, source) = infer_taken_ms("Screenshot 2026-09-27 21-42-12", None, None);
        assert_eq!(source, "filename");
        assert_eq!(parts(ms), (2026, 9, 27, 21, 42, 12));
    }

    #[test]
    fn parses_compact_date_and_time() {
        let (ms, source) = infer_taken_ms("Ekran Görüntüsü 20260927_143055", None, None);
        assert_eq!(source, "filename");
        assert_eq!(parts(ms), (2026, 9, 27, 14, 30, 55));
    }

    #[test]
    fn parses_iso_date_without_a_time() {
        let (ms, source) = infer_taken_ms("Snipaste_2026-01-02-18-00-00", None, None);
        assert_eq!(source, "filename");
        assert_eq!(parts(ms), (2026, 1, 2, 18, 0, 0));
    }

    #[test]
    fn date_only_filename_defaults_to_midday() {
        let (ms, source) = infer_taken_ms("image_2026-03-04", None, None);
        assert_eq!(source, "filename");
        assert_eq!(parts(ms), (2026, 3, 4, 12, 0, 0));
    }

    #[test]
    fn parses_day_first_dotted_names() {
        let (ms, source) = infer_taken_ms("27.09.2026 ekran", None, None);
        assert_eq!(source, "filename");
        assert_eq!(parts(ms), (2026, 9, 27, 12, 0, 0));
    }

    #[test]
    fn prefers_separated_time_over_a_later_digit_run() {
        let (ms, _) = infer_taken_ms("Snipaste_2026-09-27_21-42-12_123456", None, None);
        assert_eq!(parts(ms), (2026, 9, 27, 21, 42, 12));
    }

    #[test]
    fn rejects_impossible_dates_and_falls_back_to_created() {
        let created = UNIX_EPOCH + Duration::from_millis(1_700_000_000_000);
        let (ms, source) = infer_taken_ms("shot 2026-13-45", Some(created), None);
        assert_eq!(source, "created");
        assert_eq!(ms, 1_700_000_000_000);
    }

    #[test]
    fn falls_back_to_modified_then_now() {
        let modified = UNIX_EPOCH + Duration::from_millis(1_600_000_000_000);
        let (ms, source) = infer_taken_ms("no-date-here", None, Some(modified));
        assert_eq!(source, "modified");
        assert_eq!(ms, 1_600_000_000_000);

        let (ms, source) = infer_taken_ms("no-date-here", None, None);
        assert_eq!(source, "unknown");
        assert!(ms > 1_700_000_000_000);
    }

    #[test]
    fn a_compact_run_glued_to_more_digits_is_not_a_date() {
        let created = UNIX_EPOCH + Duration::from_millis(1_700_000_000_000);
        let (ms, source) = infer_taken_ms("20260927123456789", Some(created), None);
        assert_eq!(source, "created");
        assert_eq!(ms, 1_700_000_000_000);
    }

    #[test]
    fn a_repeated_compact_date_still_yields_the_trailing_time() {
        let (ms, source) = infer_taken_ms("Screenshot_20260927-214212", None, None);
        assert_eq!(source, "filename");
        assert_eq!(parts(ms), (2026, 9, 27, 21, 42, 12));

        let (ms, _) = infer_taken_ms("Backup_20260102_20260102_101010", None, None);
        assert_eq!(parts(ms), (2026, 1, 2, 10, 10, 10));
    }

    #[test]
    fn a_leading_digit_run_is_not_treated_as_a_date() {
        let created = UNIX_EPOCH + Duration::from_millis(1_700_000_000_000);
        let (ms, source) = infer_taken_ms("120260927", Some(created), None);
        assert_eq!(source, "created");
        assert_eq!(ms, 1_700_000_000_000);
    }

    #[test]
    fn viewable_set_excludes_formats_webview_cannot_decode() {
        assert!(is_viewable("png"));
        assert!(is_viewable("JPG"));
        assert!(is_viewable("avif"));
        assert!(!is_viewable("heic"));
        assert!(!is_viewable("tiff"));
        assert!(is_image("HEIF"));
        assert!(!is_image("txt"));
    }

    #[test]
    fn ext_of_handles_missing_and_mixed_case() {
        assert_eq!(ext_of("a.PNG"), "PNG");
        assert_eq!(ext_of("no-ext"), "");
        assert_eq!(ext_of("a.tar.gz"), "gz");
    }

    #[test]
    fn collect_reports_a_running_count_of_images() {
        let dir = std::env::temp_dir().join(format!("shotpile-progress-{}", now_ms()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        for name in ["a.png", "b.jpg", "sub/c.webp"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();

        let mut seen = Vec::new();
        let (files, stats) = collect(&dir, |n| seen.push(n));
        assert_eq!(seen, vec![1, 2, 3], "one call per image, counting up");
        assert_eq!(files.len(), 3);
        assert_eq!(stats.found, 3);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn collect_finds_images_recursively_and_ignores_others() {
        let dir = std::env::temp_dir().join(format!("shotpile-scan-{}", now_ms()));
        let sub = dir.join("2026");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(dir.join("a.png"), b"x").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        std::fs::write(sub.join("b.jpg"), b"x").unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git").join("hidden.png"), b"x").unwrap();

        let (files, stats) = collect(&dir, |_| {});
        assert_eq!(stats.found, 2);
        assert_eq!(stats.skipped_other, 1);
        let mut names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["a.png", "b.jpg"]);
        assert!(files.iter().all(|f| f.size == 1));

        std::fs::remove_dir_all(&dir).ok();
    }
}
