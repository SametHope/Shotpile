//! Exact duplicate detection by size and content hash.
//!
//! Groups files by size, then by content hash, to identify files with identical content.
//! Content hashes are confirmed with full byte-by-byte comparison to avoid false positives.
//! This is useful for finding and removing duplicate screenshots.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use crate::db::{Db, Shot};

/// A group of identical files (same size and content hash).
#[derive(Debug, Clone, serde::Serialize)]
pub struct DuplicateGroup {
    /// The IDs of all files in this group (>= 2).
    pub ids: Vec<i64>,
    /// Size of each file in bytes.
    pub size: i64,
}

/// Simple non-cryptographic hash for content comparison.
/// Uses a quick rolling hash approach: read chunks and combine with multiplier.
fn content_hash(path: &Path) -> Result<u64, String> {
    let mut file =
        File::open(path).map_err(|e| format!("could not open file for hashing: {}", e))?;

    let mut hash: u64 = 5381;
    let mut buf = [0u8; 65536]; // 64KB chunks

    loop {
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                for &byte in &buf[..n] {
                    hash = hash.wrapping_mul(33).wrapping_add(byte as u64);
                }
            }
            Err(e) => return Err(format!("error reading file for hash: {}", e)),
        }
    }

    Ok(hash)
}

/// Compares two files byte-by-byte to confirm they are identical.
/// Returns true if the files have identical content, false otherwise.
/// If either file cannot be read, returns an error.
fn files_are_identical(path_a: &Path, path_b: &Path) -> Result<bool, String> {
    let mut file_a = File::open(path_a).map_err(|e| format!("could not open file A: {}", e))?;
    let mut file_b = File::open(path_b).map_err(|e| format!("could not open file B: {}", e))?;

    let mut buf_a = [0u8; 65536];
    let mut buf_b = [0u8; 65536];

    loop {
        let n_a = file_a
            .read(&mut buf_a)
            .map_err(|e| format!("error reading file A: {}", e))?;
        let n_b = file_b
            .read(&mut buf_b)
            .map_err(|e| format!("error reading file B: {}", e))?;

        if n_a != n_b || buf_a[..n_a] != buf_b[..n_b] {
            return Ok(false);
        }

        if n_a == 0 {
            break;
        }
    }

    Ok(true)
}

/// Finds all groups of duplicate files (identical size and content) in a folder.
/// Returns groups where each group has 2+ files with identical content.
/// Only includes files that exist on disk (missing files are skipped).
/// Uses hash-based grouping followed by byte-by-byte confirmation to avoid false positives.
pub fn find_duplicates(db: &Db, root_id: i64) -> Result<Vec<DuplicateGroup>, String> {
    // Get all non-deleted files in this root that exist on disk
    let shots = db.root_shots(root_id)?;

    // Group by size
    let mut by_size: HashMap<i64, Vec<Shot>> = HashMap::new();
    for shot in shots {
        if shot.missing || shot.status == "deleted" {
            continue; // Skip missing files and deleted files
        }
        by_size.entry(shot.size).or_default().push(shot);
    }

    // For each size group with 2+ files, compute hashes and group by hash
    let mut groups = Vec::new();

    for (_size, size_group) in by_size {
        if size_group.len() < 2 {
            continue; // No duplicates in this size group
        }

        let mut by_hash: HashMap<u64, Vec<Shot>> = HashMap::new();

        for shot in size_group {
            match content_hash(Path::new(&shot.path)) {
                Ok(hash) => {
                    by_hash.entry(hash).or_default().push(shot);
                }
                Err(_) => {
                    // File might have been deleted or become inaccessible since scan;
                    // skip it and continue
                }
            }
        }

        // For each hash group with 2+ files, confirm with byte-by-byte comparison
        // and split groups if files differ.
        for (_hash, shots_in_group) in by_hash {
            if shots_in_group.len() < 2 {
                continue;
            }

            // Use the first file as the reference and group others by actual identity.
            let mut confirmed_groups: Vec<Vec<i64>> = Vec::new();

            for shot in &shots_in_group {
                let reference_path = Path::new(&shots_in_group[0].path);
                let shot_path = Path::new(&shot.path);

                // Skip the reference file itself
                if shot.id == shots_in_group[0].id {
                    if confirmed_groups.is_empty() {
                        confirmed_groups.push(vec![shot.id]);
                    } else {
                        confirmed_groups[0].push(shot.id);
                    }
                    continue;
                }

                // Check if this file is identical to the reference
                let is_identical =
                    files_are_identical(reference_path, shot_path).unwrap_or_default();

                if is_identical {
                    if confirmed_groups.is_empty() {
                        confirmed_groups.push(vec![shots_in_group[0].id, shot.id]);
                    } else {
                        confirmed_groups[0].push(shot.id);
                    }
                } else {
                    // This file is different; start a new group with it as reference
                    confirmed_groups.push(vec![shot.id]);
                }
            }

            // Add only groups with 2+ identical files
            for ids in confirmed_groups {
                if ids.len() >= 2 {
                    groups.push(DuplicateGroup { ids, size: _size });
                }
            }
        }
    }

    // Sort groups by size (largest first) for better UX
    groups.sort_by_key(|g| std::cmp::Reverse(g.size));

    Ok(groups)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to create a temp directory with a unique name for tests.
    fn temp_test_dir(name: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!(
            "shotpile-dupes-test-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("failed to create temp test dir");
        base
    }

    #[test]
    fn identical_files_are_grouped() {
        let test_dir = temp_test_dir("identical");
        let db = crate::Db::open_in_memory().expect("in-memory db");
        let root = db.upsert_root(test_dir.to_str().unwrap()).unwrap();

        // Create two identical files
        let file1 = test_dir.join("file1.bin");
        let file2 = test_dir.join("file2.bin");
        let content = b"identical content here";
        std::fs::write(&file1, content).unwrap();
        std::fs::write(&file2, content).unwrap();

        // Insert them into the database
        db.upsert_shot(
            root,
            file1.to_str().unwrap(),
            "file1.bin",
            "bin",
            content.len() as i64,
            1000,
            None,
            None,
            "filename",
        )
        .unwrap();
        db.upsert_shot(
            root,
            file2.to_str().unwrap(),
            "file2.bin",
            "bin",
            content.len() as i64,
            2000,
            None,
            None,
            "filename",
        )
        .unwrap();

        let groups = find_duplicates(&db, root).unwrap();
        assert_eq!(groups.len(), 1, "Should find one duplicate group");
        assert_eq!(
            groups[0].ids.len(),
            2,
            "Group should contain 2 identical files"
        );
        assert_eq!(
            groups[0].size,
            content.len() as i64,
            "Group size should match file size"
        );

        let _ = std::fs::remove_dir_all(&test_dir);
    }

    #[test]
    fn same_size_different_content_not_grouped() {
        let test_dir = temp_test_dir("different_content");
        let db = crate::Db::open_in_memory().expect("in-memory db");
        let root = db.upsert_root(test_dir.to_str().unwrap()).unwrap();

        // Create two files with same size but different content
        let file1 = test_dir.join("file1.bin");
        let file2 = test_dir.join("file2.bin");
        let content1 = b"content number one";
        let content2 = b"content number two"; // Same length, different content

        std::fs::write(&file1, content1).unwrap();
        std::fs::write(&file2, content2).unwrap();

        db.upsert_shot(
            root,
            file1.to_str().unwrap(),
            "file1.bin",
            "bin",
            content1.len() as i64,
            1000,
            None,
            None,
            "filename",
        )
        .unwrap();
        db.upsert_shot(
            root,
            file2.to_str().unwrap(),
            "file2.bin",
            "bin",
            content2.len() as i64,
            2000,
            None,
            None,
            "filename",
        )
        .unwrap();

        let groups = find_duplicates(&db, root).unwrap();
        assert_eq!(
            groups.len(),
            0,
            "Should not group files with different content"
        );

        let _ = std::fs::remove_dir_all(&test_dir);
    }

    #[test]
    fn different_sizes_not_grouped() {
        let test_dir = temp_test_dir("different_sizes");
        let db = crate::Db::open_in_memory().expect("in-memory db");
        let root = db.upsert_root(test_dir.to_str().unwrap()).unwrap();

        // Create two files with different sizes
        let file1 = test_dir.join("file1.bin");
        let file2 = test_dir.join("file2.bin");
        let content1 = b"small";
        let content2 = b"much larger content";

        std::fs::write(&file1, content1).unwrap();
        std::fs::write(&file2, content2).unwrap();

        db.upsert_shot(
            root,
            file1.to_str().unwrap(),
            "file1.bin",
            "bin",
            content1.len() as i64,
            1000,
            None,
            None,
            "filename",
        )
        .unwrap();
        db.upsert_shot(
            root,
            file2.to_str().unwrap(),
            "file2.bin",
            "bin",
            content2.len() as i64,
            2000,
            None,
            None,
            "filename",
        )
        .unwrap();

        let groups = find_duplicates(&db, root).unwrap();
        assert_eq!(
            groups.len(),
            0,
            "Should not group files with different sizes"
        );

        let _ = std::fs::remove_dir_all(&test_dir);
    }

    #[test]
    fn single_file_not_grouped() {
        let test_dir = temp_test_dir("single_file");
        let db = crate::Db::open_in_memory().expect("in-memory db");
        let root = db.upsert_root(test_dir.to_str().unwrap()).unwrap();

        // Create one file (no duplicates)
        let file1 = test_dir.join("file1.bin");
        let content = b"single file content";
        std::fs::write(&file1, content).unwrap();

        db.upsert_shot(
            root,
            file1.to_str().unwrap(),
            "file1.bin",
            "bin",
            content.len() as i64,
            1000,
            None,
            None,
            "filename",
        )
        .unwrap();

        let groups = find_duplicates(&db, root).unwrap();
        assert_eq!(
            groups.len(),
            0,
            "Should not return groups with only one file"
        );

        let _ = std::fs::remove_dir_all(&test_dir);
    }

    #[test]
    fn three_identical_files_are_grouped() {
        let test_dir = temp_test_dir("three_identical");
        let db = crate::Db::open_in_memory().expect("in-memory db");
        let root = db.upsert_root(test_dir.to_str().unwrap()).unwrap();

        // Create three identical files
        let files = [
            test_dir.join("file1.bin"),
            test_dir.join("file2.bin"),
            test_dir.join("file3.bin"),
        ];
        let content = b"shared identical content";

        for file in &files {
            std::fs::write(file, content).unwrap();
        }

        for (i, file) in files.iter().enumerate() {
            db.upsert_shot(
                root,
                file.to_str().unwrap(),
                &format!("file{}.bin", i + 1),
                "bin",
                content.len() as i64,
                1000 + (i as i64),
                None,
                None,
                "filename",
            )
            .unwrap();
        }

        let groups = find_duplicates(&db, root).unwrap();
        assert_eq!(groups.len(), 1, "Should find one duplicate group");
        assert_eq!(
            groups[0].ids.len(),
            3,
            "Group should contain all 3 identical files"
        );

        let _ = std::fs::remove_dir_all(&test_dir);
    }
}
