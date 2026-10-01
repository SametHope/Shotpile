//! End-to-end smoke test against a real folder: scan it, walk every queue,
//! decide files, and commit staged deletes into the Recycle Bin.
//!
//! Run with:  cargo test --test e2e -- --nocapture --test-threads=1
//!
//! The test builds its own PNGs in a temp directory, so it needs no fixtures.
//! Committing sends files to the *real* Recycle Bin, which is why every file it
//! stages is one it created itself.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Writes a valid 1x1 PNG so WebView2 and the trash crate both see a real file.
fn write_png(path: &Path) {
    const PNG: [u8; 67] = [
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, PNG).unwrap();
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("shotpile-e2e-{name}-{}", now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn build_tree(root: &Path) {
    // September: three shots, plus noise the scanner must ignore.
    write_png(&root.join("Screenshot 2026-09-27 21-42-12.png"));
    write_png(&root.join("Screenshot 2026-09-27 21-43-40.png"));
    write_png(&root.join("Screenshot 2026-09-28 09-15-00.png"));
    // August, nested one level down.
    write_png(&root.join("2026-08/Snipaste_2026-08-14_18-00-00.png"));
    write_png(&root.join("2026-08/Snipaste_2026-08-15_09-30-00.png"));
    // A tracked-but-unpreviewable format, dated so it groups into August.
    write_png(&root.join("2026-08/IMG_20260816_120000.heic"));
    // Non-images: must be ignored.
    std::fs::write(root.join("notes.txt"), b"ignore me").unwrap();
    std::fs::write(root.join("clip.mp4"), b"ignore me").unwrap();
}

#[test]
fn full_review_cycle() {
    let root = scratch("cycle");
    build_tree(&root);
    let path = root.to_string_lossy().to_string();

    let db = shotpile_lib::open_db_for_tests(
        &std::env::temp_dir().join(format!("shotpile-e2e-db-{}.db", now_ms())),
    )
    .expect("open db");
    let mut undo = shotpile_lib::undo_stack_for_tests();

    // ---- scan -------------------------------------------------------------
    let report = shotpile_lib::scan_root_for_tests(&db, &path).expect("scan");
    assert_eq!(report.found, 6, "6 image files, ignoring txt/mp4");
    assert_eq!(report.added, 6);
    assert_eq!(report.refreshed, 0);
    assert_eq!(report.skipped_other, 2);
    assert_eq!(report.unviewable, 1, "the .heic has no WebView2 preview");
    assert_eq!(report.total_in_root, 6);
    assert_eq!(report.missing, 0);

    // Rescan is idempotent for decisions and counts.
    let again = shotpile_lib::scan_root_for_tests(&db, &path).expect("rescan");
    assert_eq!(again.added, 0);
    assert_eq!(again.refreshed, 6);

    // ---- months -----------------------------------------------------------
    let months = db.months(None, 0).unwrap();
    let keys: Vec<&str> = months.iter().map(|m| m.month.as_str()).collect();
    assert_eq!(keys, vec!["2026-09", "2026-08"], "two months, newest first");
    let sep = &months[0];
    assert_eq!(sep.total, 3);
    assert_eq!(sep.remaining, 3);
    let aug = &months[1];
    assert_eq!(aug.total, 3); // 2 png + 1 heic

    // ---- review September: keep, stage, skip ------------------------------
    let queue = db.queue_ids("month", Some("2026-09"), None, 0).unwrap();
    assert_eq!(queue.len(), 3);
    let ordered = db.items(&queue).unwrap();
    assert!(
        ordered[0].taken_ms <= ordered[1].taken_ms,
        "oldest first within a month"
    );
    assert!(ordered.iter().all(|s| s.viewable));

    db.set_status(queue[0], "kept", Some(now_ms())).unwrap();
    db.set_status(queue[1], "staged", Some(now_ms())).unwrap();
    db.set_status(queue[2], "skipped", Some(now_ms())).unwrap();

    let sept = db.months(None, 0).unwrap()[0].clone();
    assert_eq!(sept.kept, 1);
    assert_eq!(sept.staged, 1);
    assert_eq!(sept.skipped, 1);
    assert_eq!(sept.remaining, 0, "every file has a decision");
    assert_eq!(sept.reviewed, 1, "only keep/delete count as reviewed");
    assert!(
        db.queue_ids("month", Some("2026-09"), None, 0)
            .unwrap()
            .is_empty(),
        "a finished month has nothing left in its queue"
    );

    // ---- other queues -----------------------------------------------------
    assert_eq!(db.queue_ids("unreviewed", None, None, 0).unwrap().len(), 3);
    assert_eq!(
        db.queue_ids("skipped", None, None, 0).unwrap(),
        vec![queue[2]]
    );
    assert_eq!(db.queue_ids("random", None, None, 0).unwrap().len(), 3);
    assert_eq!(
        db.queue_ids("staged", None, None, 0).unwrap(),
        vec![queue[1]]
    );

    // ---- unstage, then stage again ---------------------------------------
    db.set_status(queue[1], "pending", None).unwrap();
    assert!(db.staged_rows().unwrap().is_empty());
    db.set_status(queue[1], "staged", Some(now_ms())).unwrap();
    assert_eq!(db.staged_rows().unwrap().len(), 1);

    // ---- the file on disk is still there before commit ---------------------
    let staged_path = db.shot(queue[1]).unwrap().unwrap().path;
    assert!(Path::new(&staged_path).exists(), "staging must not delete");

    // ---- vanish detection -------------------------------------------------
    let removed = root.join("Screenshot 2026-09-28 09-15-00.png");
    std::fs::remove_file(&removed).unwrap();
    let third = shotpile_lib::scan_root_for_tests(&db, &path).expect("rescan after delete");
    assert_eq!(third.missing, 1);
    let missing = db.shot(queue[2]).unwrap().unwrap();
    assert!(missing.missing, "the removed file is flagged");
    assert_eq!(
        missing.status, "skipped",
        "flagging does not reset decisions"
    );

    // ---- commit ------------------------------------------------------------
    let staged_size = db.shot(queue[1]).unwrap().unwrap().size;
    let report = shotpile_lib::commit_deletes_for_tests(&db, &mut undo).expect("commit");
    assert_eq!(report.deleted, 1);
    assert_eq!(report.bytes_freed, staged_size);
    assert!(report.failed.is_empty(), "no failures expected: {report:?}");
    assert_eq!(report.still_staged, 0);
    assert!(
        !Path::new(&staged_path).exists(),
        "committed file left the disk (into the Recycle Bin)"
    );
    let shot = db.shot(queue[1]).unwrap().unwrap();
    assert_eq!(shot.status, "deleted");
    assert!(db.staged_rows().unwrap().is_empty());

    // Committing again is a harmless no-op.
    let empty = shotpile_lib::commit_deletes_for_tests(&db, &mut undo).expect("empty commit");
    assert_eq!(empty.deleted, 0);
    assert_eq!(empty.bytes_freed, 0);
    assert_eq!(empty.still_staged, 0);

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn decisions_survive_reopening_the_database() {
    let root = scratch("persist");
    build_tree(&root);
    let db_path = std::env::temp_dir().join(format!("shotpile-e2e-persist-{}.db", now_ms()));

    {
        let db = shotpile_lib::open_db_for_tests(&db_path).expect("open");
        let report = shotpile_lib::scan_root_for_tests(&db, root.to_str().unwrap()).expect("scan");
        assert_eq!(report.found, 6);
        let ids = db.queue_ids("unreviewed", None, None, 0).unwrap();
        assert_eq!(ids.len(), 6);
        db.set_status(ids[0], "kept", Some(now_ms())).unwrap();
        db.set_status(ids[1], "staged", Some(now_ms())).unwrap();
    } // db dropped here

    let db = shotpile_lib::open_db_for_tests(&db_path).expect("reopen");
    let summary = db.summary(None, 0).unwrap();
    assert_eq!(summary.total, 6);
    assert_eq!(summary.kept, 1);
    assert_eq!(summary.staged, 1);
    assert_eq!(summary.pending, 4);

    // The staged row survived too, so the pending delete is still recoverable.
    let staged = db.staged_rows().unwrap();
    assert_eq!(staged.len(), 1);
    assert!(
        Path::new(&staged[0].path).exists(),
        "a staged file must never be removed by a restart"
    );

    db.set_status(staged[0].id, "pending", None).unwrap();
    assert!(db.staged_rows().unwrap().is_empty());

    std::fs::remove_dir_all(&root).ok();
    for suffix in ["", "-wal", "-shm"] {
        let mut p = db_path.clone().into_os_string();
        p.push(suffix);
        std::fs::remove_file(PathBuf::from(p)).ok();
    }
}

#[test]
fn undo_never_resurrects_a_committed_file() {
    let root = scratch("undo");
    build_tree(&root);
    let db_dir = scratch("undo-db");
    let db = shotpile_lib::open_db_for_tests(&db_dir.join("shotpile.db")).expect("open db");
    let mut undo = shotpile_lib::undo_stack_for_tests();
    shotpile_lib::scan_root_for_tests(&db, root.to_str().unwrap()).expect("scan");

    let queue = db.queue_ids("month", Some("2026-09"), None, 0).unwrap();
    let (kept, binned) = (queue[0], queue[1]);
    shotpile_lib::decide_for_tests(&db, &mut undo, kept, "keep").unwrap();
    let staged = shotpile_lib::decide_for_tests(&db, &mut undo, binned, "delete").unwrap();
    assert!(Path::new(&staged.path).exists(), "staging must not delete");

    let report = shotpile_lib::commit_deletes_for_tests(&db, &mut undo).expect("commit");
    assert_eq!(report.deleted, 1);
    assert_eq!(report.bytes_freed, staged.size);
    assert!(
        !Path::new(&staged.path).exists(),
        "committed into the Recycle Bin"
    );

    // The delete is the newest action, but its file is in the bin: undo skips
    // it and walks back the keep before it.
    let undone = shotpile_lib::undo_last_for_tests(&db, &mut undo)
        .unwrap()
        .expect("the keep is still undoable");
    assert_eq!(undone.id, kept);
    assert_eq!(undone.status, "pending");
    assert!(
        shotpile_lib::undo_last_for_tests(&db, &mut undo)
            .unwrap()
            .is_none(),
        "nothing else to undo"
    );

    let shot = db.shot(binned).unwrap().unwrap();
    assert_eq!(shot.status, "deleted", "the committed row stays deleted");
    assert!(db.staged_rows().unwrap().is_empty());
    // A stale card cannot bring it back either.
    assert!(shotpile_lib::decide_for_tests(&db, &mut undo, binned, "keep").is_err());
    assert_eq!(db.shot(binned).unwrap().unwrap().status, "deleted");

    // Closed first: Windows will not remove an open database file.
    drop(db);
    std::fs::remove_dir_all(&root).ok();
    std::fs::remove_dir_all(&db_dir).ok();
}

#[test]
fn forgetting_a_folder_leaves_its_files_on_disk() {
    let root = scratch("forget");
    build_tree(&root);
    let path = root.to_string_lossy().to_string();
    let db_dir = scratch("forget-db");
    let db = shotpile_lib::open_db_for_tests(&db_dir.join("shotpile.db")).expect("open db");
    let mut undo = shotpile_lib::undo_stack_for_tests();
    shotpile_lib::scan_root_for_tests(&db, &path).expect("scan");

    let ids = db.queue_ids("unreviewed", None, None, 0).unwrap();
    shotpile_lib::decide_for_tests(&db, &mut undo, ids[0], "delete").unwrap();
    let staged_path = db.staged_rows().unwrap()[0].path.clone();
    let root_id = db.list_roots().unwrap()[0].id;

    shotpile_lib::forget_root_for_tests(&db, &mut undo, root_id).expect("forget");
    assert!(db.list_roots().unwrap().is_empty());
    assert!(db.staged_rows().unwrap().is_empty());
    assert_eq!(db.summary(None, 0).unwrap().total, 0);
    assert!(shotpile_lib::undo_last_for_tests(&db, &mut undo)
        .unwrap()
        .is_none());

    // Database only: the staged file is still there, and so is every other one,
    // which a fresh scan proves by finding all six again, undecided.
    assert!(
        Path::new(&staged_path).exists(),
        "forgetting must not delete"
    );
    let again = shotpile_lib::scan_root_for_tests(&db, &path).expect("rescan");
    assert_eq!(again.added, 6);
    assert_eq!(db.queue_ids("unreviewed", None, None, 0).unwrap().len(), 6);

    // Closed first: Windows will not remove an open database file.
    drop(db);
    std::fs::remove_dir_all(&root).ok();
    std::fs::remove_dir_all(&db_dir).ok();
}
