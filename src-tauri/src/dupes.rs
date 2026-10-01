//! Exact duplicate detection by size and content hash.
//!
//! Groups files by size, then by content hash, to identify files with identical content.
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

/// Finds all groups of duplicate files (identical size and content) in a folder.
/// Returns groups where each group has 2+ files with identical content.
/// Only includes files that exist on disk (missing files are skipped).
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

        let mut by_hash: HashMap<u64, Vec<i64>> = HashMap::new();

        for shot in size_group {
            match content_hash(Path::new(&shot.path)) {
                Ok(hash) => {
                    by_hash.entry(hash).or_default().push(shot.id);
                }
                Err(_) => {
                    // File might have been deleted or become inaccessible since scan;
                    // skip it and continue
                }
            }
        }

        // Create a group for each hash that has 2+ files
        for (_hash, ids) in by_hash {
            if ids.len() >= 2 {
                groups.push(DuplicateGroup { ids, size: _size });
            }
        }
    }

    // Sort groups by size (largest first) for better UX
    groups.sort_by_key(|g| std::cmp::Reverse(g.size));

    Ok(groups)
}

