use std::collections::{HashMap, HashSet};

use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: i64 = 1;

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_STAGED: &str = "staged";
pub const STATUS_KEPT: &str = "kept";
pub const STATUS_DELETED: &str = "deleted";
pub const STATUS_SKIPPED: &str = "skipped";

pub const ALL_STATUSES: [&str; 5] = [
    STATUS_PENDING,
    STATUS_STAGED,
    STATUS_KEPT,
    STATUS_DELETED,
    STATUS_SKIPPED,
];

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roots (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  last_scan_ms INTEGER
);

CREATE TABLE IF NOT EXISTS screenshots (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL,
  taken_ms INTEGER NOT NULL,
  created_ms INTEGER,
  modified_ms INTEGER,
  date_source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_ms INTEGER,
  missing INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_shots_taken ON screenshots(taken_ms);
CREATE INDEX IF NOT EXISTS idx_shots_status ON screenshots(status);
CREATE INDEX IF NOT EXISTS idx_shots_root ON screenshots(root_id);

CREATE TABLE IF NOT EXISTS staged (
  screenshot_id INTEGER PRIMARY KEY REFERENCES screenshots(id) ON DELETE CASCADE,
  staged_ms INTEGER NOT NULL
);
"#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Root {
    pub id: i64,
    pub path: String,
    pub last_scan_ms: Option<i64>,
    pub total: i64,
    pub pending: i64,
    pub kept: i64,
    pub deleted: i64,
    pub skipped: i64,
    pub staged: i64,
    pub missing: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Shot {
    pub id: i64,
    pub path: String,
    pub root_id: i64,
    pub name: String,
    pub ext: String,
    pub size: i64,
    pub taken_ms: i64,
    pub created_ms: Option<i64>,
    pub modified_ms: Option<i64>,
    pub date_source: String,
    pub status: String,
    pub decided_ms: Option<i64>,
    pub missing: bool,
    /// Whether WebView2 can decode this format. Non-viewable files are still
    /// tracked so they can be reviewed by name and deleted, but the card shows
    /// a placeholder instead of an image.
    pub viewable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MonthStat {
    pub month: String,
    pub total: i64,
    pub reviewed: i64,
    pub kept: i64,
    pub deleted: i64,
    pub skipped: i64,
    pub staged: i64,
    pub remaining: i64,
}

/// Header figures for one root (or every root). Every count and size except
/// `missing` and the `*_staged_all` pair leaves out rows flagged missing, the
/// same rows `months` groups, so the header and the month list always agree.
/// Committed rows are never flagged missing (see `flag_root_missing`), so the
/// deleted figures keep their history across rescans.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Summary {
    pub total: i64,
    pub pending: i64,
    pub staged: i64,
    /// Staged across every root, because `staged_list` and `commit_deletes`
    /// are global. `staged` is root-filtered and only used for month rows.
    /// Missing files count here too: the commit still has to settle them.
    pub staged_all: i64,
    /// Size of everything in `staged_all`.
    pub bytes_staged_all: i64,
    pub kept: i64,
    pub deleted: i64,
    pub skipped: i64,
    /// Rows whose file was not found by the last scan of their folder.
    pub missing: i64,
    pub bytes_pending: i64,
    pub bytes_total: i64,
    /// Size of the files committed to the Recycle Bin: the space already freed.
    pub bytes_deleted: i64,
    pub months: i64,
}

/// A staged file, as the commit needs it.
#[derive(Debug, Clone, PartialEq)]
pub struct StagedRow {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub size: i64,
}

const SHOT_COLUMNS: &str = "id, path, root_id, name, ext, size, taken_ms, created_ms, \
     modified_ms, date_source, status, decided_ms, missing";

fn shot_from_row(row: &Row<'_>) -> rusqlite::Result<Shot> {
    let ext: String = row.get(4)?;
    Ok(Shot {
        id: row.get(0)?,
        path: row.get(1)?,
        root_id: row.get(2)?,
        name: row.get(3)?,
        viewable: super::scan::is_viewable(&ext),
        ext,
        size: row.get(5)?,
        taken_ms: row.get(6)?,
        created_ms: row.get(7)?,
        modified_ms: row.get(8)?,
        date_source: row.get(9)?,
        status: row.get(10)?,
        decided_ms: row.get(11)?,
        missing: row.get::<_, i64>(12)? != 0,
    })
}

fn month_expr(tz_offset_min: i64) -> String {
    format!(
        "strftime('%Y-%m', (taken_ms + {}) / 1000, 'unixepoch')",
        tz_offset_min * 60_000
    )
}

/// Optional `root_id` restriction, as an SQL fragment plus its bind values.
fn root_filter(root_id: Option<i64>) -> (String, Vec<Value>) {
    match root_id {
        Some(id) => (" AND root_id = ?".to_string(), vec![Value::Integer(id)]),
        None => (String::new(), Vec::new()),
    }
}

fn to_sql_refs(args: &[Value]) -> Vec<&dyn rusqlite::ToSql> {
    args.iter().map(|v| v as &dyn rusqlite::ToSql).collect()
}

pub struct Db {
    conn: Connection,
    path: Option<std::path::PathBuf>,
}

impl Db {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        let db = Self::from_conn(conn)?;
        Ok(Self {
            path: Some(path.to_path_buf()),
            ..db
        })
    }

    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        Self::from_conn(conn)
    }

    /// `None` for the in-memory database used by tests.
    pub fn path(&self) -> Option<&std::path::Path> {
        self.path.as_deref()
    }

    fn from_conn(conn: Connection) -> Result<Self, String> {
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        let db = Self { conn, path: None };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), String> {
        self.conn
            .execute_batch(SCHEMA)
            .map_err(|e| format!("schema: {e}"))?;
        let stored: String = self
            .conn
            .query_row(
                "SELECT COALESCE((SELECT v FROM meta WHERE k = 'schema_version'), '0')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let current: i64 = stored.parse().unwrap_or(0);
        if current == 0 {
            self.conn
                .execute(
                    "INSERT INTO meta(k, v) VALUES('schema_version', ?1)",
                    params![SCHEMA_VERSION.to_string()],
                )
                .map_err(|e| e.to_string())?;
        } else if current > SCHEMA_VERSION {
            return Err(format!(
                "this database was written by a newer version of the app (schema {current}); \
                 update the app to open it"
            ));
        } else if current < SCHEMA_VERSION {
            self.conn
                .execute(
                    "UPDATE meta SET v = ?1 WHERE k = 'schema_version'",
                    params![SCHEMA_VERSION.to_string()],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn schema_version(&self) -> i64 {
        self.conn
            .query_row(
                "SELECT CAST(v AS INTEGER) FROM meta WHERE k = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    // ---- roots ----

    pub fn upsert_root(&self, path: &str) -> Result<i64, String> {
        self.conn
            .execute(
                "INSERT INTO roots(path) VALUES(?1) ON CONFLICT(path) DO NOTHING",
                params![path],
            )
            .map_err(|e| e.to_string())?;
        self.conn
            .query_row("SELECT id FROM roots WHERE path = ?1", params![path], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())
    }

    pub fn touch_root(&self, root_id: i64, ms: i64) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE roots SET last_scan_ms = ?2 WHERE id = ?1",
                params![root_id, ms],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_roots(&self) -> Result<Vec<Root>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT r.id, r.path, r.last_scan_ms,
                        COUNT(s.id),
                        COALESCE(SUM(s.status = 'pending'), 0),
                        COALESCE(SUM(s.status = 'kept'), 0),
                        COALESCE(SUM(s.status = 'deleted'), 0),
                        COALESCE(SUM(s.status = 'skipped'), 0),
                        COALESCE(SUM(s.status = 'staged'), 0),
                        COALESCE(SUM(s.missing = 1), 0)
                 FROM roots r
                 LEFT JOIN screenshots s ON s.root_id = r.id
                 GROUP BY r.id
                 ORDER BY COALESCE(r.last_scan_ms, 0) DESC, r.path",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Root {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    last_scan_ms: row.get(2)?,
                    total: row.get(3)?,
                    pending: row.get(4)?,
                    kept: row.get(5)?,
                    deleted: row.get(6)?,
                    skipped: row.get(7)?,
                    staged: row.get(8)?,
                    missing: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    /// Forgets a saved folder. Only the root row is deleted; ON DELETE CASCADE
    /// takes its screenshot rows and their staged entries with it. Database
    /// only: nothing on disk is touched, and scanning the folder again starts
    /// it fresh.
    ///
    /// Returns the ids of the screenshot rows that went, so the caller can drop
    /// them from the undo stack.
    pub fn forget_root(&self, root_id: i64) -> Result<Vec<i64>, String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| format!("transaction: {e}"))?;
        let ids = {
            let mut stmt = tx
                .prepare("SELECT id FROM screenshots WHERE root_id = ?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![root_id], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?
        };
        let removed = tx
            .execute("DELETE FROM roots WHERE id = ?1", params![root_id])
            .map_err(|e| e.to_string())?;
        if removed == 0 {
            return Err(format!("no saved folder with id {root_id}"));
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(ids)
    }

    // ---- scan ----

    /// Flags every row of a root as missing ahead of a rescan, which un-flags
    /// the files it finds again.
    ///
    /// Committed rows are left out. Their file is in the Recycle Bin because
    /// this app put it there, which is not "missing": flagging them dropped
    /// them from the deleted counts and the freed-space figure after every
    /// rescan, and reported the app's own deletes as files missing on disk.
    /// The same statement clears the flag on committed rows an older version
    /// set, so existing databases heal on their next scan.
    pub fn flag_root_missing(&self, root_id: i64) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE screenshots SET missing = (status != 'deleted') WHERE root_id = ?1",
                params![root_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn count_in_root(&self, root_id: i64) -> Result<i64, String> {
        self.conn
            .query_row(
                "SELECT COUNT(*) FROM screenshots WHERE root_id = ?1 AND missing = 0",
                params![root_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
    }

    pub fn count_missing_in_root(&self, root_id: i64) -> Result<i64, String> {
        self.conn
            .query_row(
                "SELECT COUNT(*) FROM screenshots WHERE root_id = ?1 AND missing = 1",
                params![root_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
    }

    const UPSERT_SQL: &'static str = "INSERT INTO screenshots
         (path, root_id, name, ext, size, taken_ms, created_ms, modified_ms, date_source, status, missing)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', 0)
         ON CONFLICT(path) DO UPDATE SET
            root_id = excluded.root_id,
            name = excluded.name,
            ext = excluded.ext,
            size = excluded.size,
            taken_ms = excluded.taken_ms,
            created_ms = excluded.created_ms,
            modified_ms = excluded.modified_ms,
            date_source = excluded.date_source,
            missing = 0";

    /// Upserts a whole scan in one transaction. Returns `(added, refreshed)`.
    pub fn upsert_shots_bulk(
        &self,
        root_id: i64,
        files: &[super::scan::ScannedFile],
    ) -> Result<(usize, usize), String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| format!("transaction: {e}"))?;

        // One query for the known paths. A per-row `SELECT` would need a
        // statement reset between executions, which `CachedStatement` keeps
        // private.
        let known: HashSet<String> = {
            let mut stmt = tx
                .prepare("SELECT path FROM screenshots WHERE root_id = ?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![root_id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut set = HashSet::with_capacity(files.len());
            for p in rows {
                set.insert(p.map_err(|e| e.to_string())?);
            }
            set
        };

        let mut added = 0usize;
        let mut refreshed = 0usize;
        {
            let mut upsert = tx
                .prepare_cached(Self::UPSERT_SQL)
                .map_err(|e| e.to_string())?;
            for f in files {
                upsert
                    .execute(params![
                        f.path,
                        root_id,
                        f.name,
                        f.ext,
                        f.size,
                        f.taken_ms,
                        f.created_ms,
                        f.modified_ms,
                        f.date_source
                    ])
                    .map_err(|e| format!("{}: {e}", f.path))?;
                if known.contains(&f.path) {
                    refreshed += 1;
                } else {
                    added += 1;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok((added, refreshed))
    }

    /// Returns `true` when the path was new, `false` when an existing row was refreshed.
    ///
    /// `upsert_shots_bulk` is the one to use for real scans; this single-row
    /// form exists for tests and one-off callers.
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_shot(
        &self,
        root_id: i64,
        path: &str,
        name: &str,
        ext: &str,
        size: i64,
        taken_ms: i64,
        created_ms: Option<i64>,
        modified_ms: Option<i64>,
        date_source: &str,
    ) -> Result<bool, String> {
        let existed: bool = self
            .conn
            .query_row(
                "SELECT 1 FROM screenshots WHERE path = ?1",
                params![path],
                |_| Ok(true),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(false);
        // Decisions (status / decided_ms) are intentionally left untouched so a
        // rescan never resurrects a file the user already reviewed.
        self.conn
            .execute(
                Self::UPSERT_SQL,
                params![
                    path,
                    root_id,
                    name,
                    ext,
                    size,
                    taken_ms,
                    created_ms,
                    modified_ms,
                    date_source
                ],
            )
            .map_err(|e| format!("{path}: {e}"))?;
        Ok(!existed)
    }

    // ---- reads ----

    pub fn months(
        &self,
        root_id: Option<i64>,
        tz_offset_min: i64,
    ) -> Result<Vec<MonthStat>, String> {
        let (filter, args) = root_filter(root_id);
        let sql = format!(
            "SELECT {month} AS m,
                    COUNT(*),
                    COALESCE(SUM(status IN ('kept', 'deleted')), 0),
                    COALESCE(SUM(status = 'kept'), 0),
                    COALESCE(SUM(status = 'deleted'), 0),
                    COALESCE(SUM(status = 'skipped'), 0),
                    COALESCE(SUM(status = 'staged'), 0),
                    COALESCE(SUM(status = 'pending'), 0)
             FROM screenshots
             WHERE missing = 0{filter}
             GROUP BY m
             ORDER BY m DESC",
            month = month_expr(tz_offset_min),
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let refs = to_sql_refs(&args);
        let rows = stmt
            .query_map(refs.as_slice(), |row| {
                Ok(MonthStat {
                    month: row.get(0)?,
                    total: row.get(1)?,
                    reviewed: row.get(2)?,
                    kept: row.get(3)?,
                    deleted: row.get(4)?,
                    skipped: row.get(5)?,
                    staged: row.get(6)?,
                    remaining: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    pub fn summary(&self, root_id: Option<i64>, tz_offset_min: i64) -> Result<Summary, String> {
        let (filter, args) = root_filter(root_id);
        // `missing = 0` everywhere except the `missing` column itself, and the
        // month count is the number of groups `months` would return, without
        // running it.
        let sql = format!(
            "SELECT COALESCE(SUM(missing = 0), 0),
                    COALESCE(SUM(missing = 0 AND status = 'pending'), 0),
                    COALESCE(SUM(missing = 0 AND status = 'staged'), 0),
                    COALESCE(SUM(missing = 0 AND status = 'kept'), 0),
                    COALESCE(SUM(missing = 0 AND status = 'deleted'), 0),
                    COALESCE(SUM(missing = 0 AND status = 'skipped'), 0),
                    COALESCE(SUM(missing = 1), 0),
                    COALESCE(SUM(CASE WHEN missing = 0 AND status = 'pending' THEN size ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN missing = 0 THEN size ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN missing = 0 AND status = 'deleted' THEN size ELSE 0 END), 0),
                    COUNT(DISTINCT CASE WHEN missing = 0 THEN {month} END)
             FROM screenshots
             WHERE 1 = 1{filter}",
            month = month_expr(tz_offset_min),
        );
        let (staged_all, bytes_staged_all) = self.staged_totals()?;
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let refs = to_sql_refs(&args);
        stmt.query_row(refs.as_slice(), |row| {
            Ok(Summary {
                total: row.get(0)?,
                pending: row.get(1)?,
                staged: row.get(2)?,
                staged_all,
                bytes_staged_all,
                kept: row.get(3)?,
                deleted: row.get(4)?,
                skipped: row.get(5)?,
                missing: row.get(6)?,
                bytes_pending: row.get(7)?,
                bytes_total: row.get(8)?,
                bytes_deleted: row.get(9)?,
                months: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())
    }

    /// Ids for a review queue, in display order.
    ///
    /// Scopes: `month` (needs `month`), `random`, `unreviewed`, `skipped`, `staged`.
    pub fn queue_ids(
        &self,
        scope: &str,
        month: Option<&str>,
        root_id: Option<i64>,
        tz_offset_min: i64,
    ) -> Result<Vec<i64>, String> {
        let (filter, root_args) = root_filter(root_id);
        let (status_clause, order) = match scope {
            "month" => (" AND status = 'pending'", "taken_ms ASC, id ASC"),
            "random" => (" AND status = 'pending'", "RANDOM()"),
            "unreviewed" => (" AND status = 'pending'", "taken_ms DESC, id DESC"),
            "skipped" => (" AND status = 'skipped'", "taken_ms ASC, id ASC"),
            "staged" => (" AND status = 'staged'", "taken_ms ASC, id ASC"),
            _ => ("", "taken_ms DESC, id DESC"),
        };
        // A file that vanished from disk has nothing to review, and `months`
        // already leaves it out. The staged queue keeps it: the commit is what
        // settles a gone file (it marks it deleted), so it stays visible there
        // until then.
        let missing_clause = if scope == "staged" {
            ""
        } else {
            " AND missing = 0"
        };
        let month_param: Option<&str> = if scope == "month" { month } else { None };
        let month_clause = match month_param {
            Some(_) => format!(" AND {} = ?", month_expr(tz_offset_min)),
            None => String::new(),
        };
        let mut args = root_args;
        if let Some(m) = month_param {
            args.push(Value::Text(m.to_string()));
        }
        let sql = format!(
            "SELECT id FROM screenshots
             WHERE 1 = 1{filter}{month_clause}{status_clause}{missing_clause}
             ORDER BY {order}"
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let refs = to_sql_refs(&args);
        let rows = stmt
            .query_map(refs.as_slice(), |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    pub fn shot(&self, id: i64) -> Result<Option<Shot>, String> {
        let sql = format!("SELECT {SHOT_COLUMNS} FROM screenshots WHERE id = ?1");
        self.conn
            .query_row(&sql, params![id], shot_from_row)
            .optional()
            .map_err(|e| e.to_string())
    }

    /// Hydrates ids into shots, preserving the order of `ids`.
    pub fn items(&self, ids: &[i64]) -> Result<Vec<Shot>, String> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut found: HashMap<i64, Shot> = HashMap::with_capacity(ids.len());
        for chunk in ids.chunks(400) {
            let holes = vec!["?"; chunk.len()].join(",");
            let sql = format!("SELECT {SHOT_COLUMNS} FROM screenshots WHERE id IN ({holes})");
            let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
            let refs: Vec<&dyn rusqlite::ToSql> =
                chunk.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
            let rows = stmt
                .query_map(refs.as_slice(), shot_from_row)
                .map_err(|e| e.to_string())?;
            for s in rows {
                let s = s.map_err(|e| e.to_string())?;
                found.insert(s.id, s);
            }
        }
        Ok(ids.iter().filter_map(|id| found.remove(id)).collect())
    }

    // ---- decisions ----

    pub fn set_status(&self, id: i64, status: &str, decided_ms: Option<i64>) -> Result<(), String> {
        if !ALL_STATUSES.contains(&status) {
            return Err(format!("invalid status: {status}"));
        }
        self.conn
            .execute(
                "UPDATE screenshots SET status = ?2, decided_ms = ?3 WHERE id = ?1",
                params![id, status, decided_ms],
            )
            .map_err(|e| e.to_string())?;
        if status == STATUS_STAGED {
            self.conn
                .execute(
                    "INSERT INTO staged(screenshot_id, staged_ms) VALUES(?1, ?2)
                     ON CONFLICT(screenshot_id) DO UPDATE SET staged_ms = excluded.staged_ms",
                    params![id, decided_ms.unwrap_or(0)],
                )
                .map_err(|e| e.to_string())?;
        } else {
            self.conn
                .execute("DELETE FROM staged WHERE screenshot_id = ?1", params![id])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn status_of(&self, id: i64) -> Result<Option<(String, Option<i64>)>, String> {
        self.conn
            .query_row(
                "SELECT status, decided_ms FROM screenshots WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    /// Sample image paths per month, newest first, for the month-list preview
    /// strip. `limit` caps how many thumbnails each month contributes.
    ///
    /// Only files on disk qualify. A missing row has nothing to show, and a
    /// committed one is in the Recycle Bin; committed rows are never flagged
    /// missing, so the status check is what keeps their paths out.
    pub fn month_thumbs(
        &self,
        root_id: Option<i64>,
        tz_offset_min: i64,
        limit: usize,
    ) -> Result<Vec<(String, Vec<String>)>, String> {
        let (filter, mut args) = root_filter(root_id);
        args.push(Value::Integer(i64::try_from(limit).unwrap_or(i64::MAX)));
        // Ranking inside SQL means only `limit` paths per month leave the
        // database, instead of every path in the root.
        let sql = format!(
            "SELECT m, path FROM (
                 SELECT m, path,
                        ROW_NUMBER() OVER (PARTITION BY m ORDER BY taken_ms DESC, id DESC) AS rn
                 FROM (SELECT {month} AS m, path, taken_ms, id
                       FROM screenshots
                       WHERE missing = 0 AND status != 'deleted'{filter})
             )
             WHERE rn <= ?
             ORDER BY m DESC, rn",
            month = month_expr(tz_offset_min),
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let refs = to_sql_refs(&args);
        let rows = stmt
            .query_map(refs.as_slice(), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        // Rows arrive grouped by month, so each one either extends the last
        // group or starts the next.
        let mut out: Vec<(String, Vec<String>)> = Vec::new();
        for row in rows {
            let (m, path) = row.map_err(|e| e.to_string())?;
            match out.last_mut() {
                Some((last, paths)) if *last == m => paths.push(path),
                _ => out.push((m, vec![path])),
            }
        }
        Ok(out)
    }

    /// Staged rows joined with their screenshot paths, oldest first.
    pub fn staged_rows(&self) -> Result<Vec<StagedRow>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT s.id, s.path, s.name, s.size FROM staged g
                 JOIN screenshots s ON s.id = g.screenshot_id
                 ORDER BY g.staged_ms ASC, s.taken_ms ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(StagedRow {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    name: r.get(2)?,
                    size: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    /// `(count, bytes)` of everything staged, across every root. One aggregate
    /// over the same join `staged_rows` reads, so the badge counts exactly what
    /// a commit would process.
    pub fn staged_totals(&self) -> Result<(i64, i64), String> {
        self.conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(s.size), 0) FROM staged g
                 JOIN screenshots s ON s.id = g.screenshot_id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        let db = Db::open_in_memory().expect("in-memory db");
        // Every seeded row hangs off root 1, so it must exist up front.
        assert_eq!(db.upsert_root("/photos").unwrap(), 1);
        db
    }

    fn seed(db: &Db, path: &str, taken_ms: i64) -> bool {
        db.upsert_shot(
            1, path, "a.png", "png", 100, taken_ms, None, None, "filename",
        )
        .unwrap()
    }

    #[test]
    fn schema_is_created_with_version() {
        let db = db();
        assert_eq!(db.schema_version(), SCHEMA_VERSION);
    }

    #[test]
    fn opening_a_newer_database_is_refused() {
        let db = db();
        db.conn
            .execute(
                "UPDATE meta SET v = ?1 WHERE k = 'schema_version'",
                params![(SCHEMA_VERSION + 1).to_string()],
            )
            .unwrap();
        // from_conn runs migrate again; simulate by re-running migrate logic.
        assert!(Db::from_conn(db.conn).is_err());
    }

    #[test]
    fn upsert_root_is_idempotent() {
        let db = db();
        let a = db.upsert_root("/photos").unwrap();
        let b = db.upsert_root("/photos").unwrap();
        assert_eq!(a, b);
        assert_eq!(db.list_roots().unwrap().len(), 1);
    }

    #[test]
    fn first_upsert_reports_new_then_existing() {
        let db = db();
        assert!(seed(&db, "/photos/a.png", 1_000));
        assert!(!seed(&db, "/photos/a.png", 1_000));
    }

    #[test]
    fn rescan_keeps_decisions_but_refreshes_metadata() {
        let db = db();
        seed(&db, "/photos/a.png", 1_000);
        db.set_status(1, STATUS_KEPT, Some(5)).unwrap();

        db.upsert_shot(
            1,
            "/photos/a.png",
            "a.png",
            "png",
            999,
            2_000,
            None,
            None,
            "created",
        )
        .unwrap();
        let shot = db.shot(1).unwrap().unwrap();
        assert_eq!(shot.status, STATUS_KEPT);
        assert_eq!(shot.decided_ms, Some(5));
        assert_eq!(shot.size, 999);
        assert_eq!(shot.taken_ms, 2_000);
        assert_eq!(shot.date_source, "created");
    }

    #[test]
    fn scan_flags_vanished_files_but_keeps_the_row() {
        let db = db();
        seed(&db, "/photos/a.png", 1_000);
        seed(&db, "/photos/b.png", 2_000);
        db.flag_root_missing(1).unwrap();
        seed(&db, "/photos/a.png", 1_000); // seen again -> un-flagged
        let a = db.shot(1).unwrap().unwrap();
        let b = db.shot(2).unwrap().unwrap();
        assert!(!a.missing);
        assert!(b.missing);
    }

    #[test]
    fn a_rescan_never_flags_committed_files_missing() {
        let db = db();
        seed(&db, "/photos/a.png", 1_000);
        seed(&db, "/photos/b.png", 2_000);
        seed(&db, "/photos/c.png", 3_000);
        db.set_status(1, STATUS_DELETED, Some(1)).unwrap();
        db.set_status(2, STATUS_DELETED, Some(1)).unwrap();
        // An older version flagged committed rows missing; this one must heal.
        db.conn
            .execute("UPDATE screenshots SET missing = 1 WHERE id = 2", [])
            .unwrap();

        // A rescan that finds only c.png: a and b are in the Recycle Bin.
        db.flag_root_missing(1).unwrap();
        seed(&db, "/photos/c.png", 3_000);

        assert!(
            !db.shot(1).unwrap().unwrap().missing,
            "committed, not missing"
        );
        assert!(!db.shot(2).unwrap().unwrap().missing, "healed");
        assert_eq!(db.count_missing_in_root(1).unwrap(), 0);
        let s = db.summary(None, 0).unwrap();
        assert_eq!(s.deleted, 2, "the freed-space history survives the rescan");
        assert_eq!(s.bytes_deleted, 200);
    }

    #[test]
    fn months_group_by_local_month_and_count_states() {
        let db = db();
        // 2026-01-15T11:20Z and 2026-01-20T11:20Z fall in the same month for any
        // real UTC offset; the third is deliberately two months later.
        let jan_a = 1_768_476_000_000i64;
        let jan_b = jan_a + 5 * 86_400_000;
        let mar = jan_a + 60 * 86_400_000;
        seed(&db, "/photos/1.png", jan_a);
        seed(&db, "/photos/2.png", jan_b);
        seed(&db, "/photos/3.png", mar);
        db.set_status(1, STATUS_KEPT, Some(1)).unwrap();
        db.set_status(2, STATUS_STAGED, Some(2)).unwrap();

        let months = db.months(None, 0).unwrap();
        assert_eq!(months.len(), 2);
        assert_eq!(months[0].month, "2026-03");
        assert_eq!(months[1].month, "2026-01");
        let jan = &months[1];
        assert_eq!(jan.total, 2);
        assert_eq!(jan.kept, 1);
        assert_eq!(jan.staged, 1);
        assert_eq!(jan.remaining, 0);
        assert_eq!(jan.reviewed, 1);
    }

    #[test]
    fn month_thumbs_returns_sample_paths_per_month() {
        let db = db();
        let jan_a = 1_768_476_000_000i64;
        let jan_b = jan_a + 86_400_000;
        let mar = jan_a + 60 * 86_400_000;
        seed(&db, "/photos/1.png", jan_a);
        seed(&db, "/photos/2.png", jan_b);
        seed(&db, "/photos/3.png", mar);

        let thumbs = db.month_thumbs(None, 0, 2).unwrap();
        assert_eq!(thumbs.len(), 2);
        // Newest month first.
        assert_eq!(thumbs[0].0, "2026-03");
        assert_eq!(thumbs[0].1.len(), 1);
        assert_eq!(thumbs[1].0, "2026-01");
        // Capped at the limit even though January has two files.
        assert_eq!(thumbs[1].1.len(), 2);
    }

    #[test]
    fn month_queue_only_contains_pending_of_that_month() {
        let db = db();
        let jan_a = 1_768_476_000_000i64;
        let jan_b = jan_a + 86_400_000;
        let mar = jan_a + 60 * 86_400_000;
        seed(&db, "/photos/1.png", jan_a);
        seed(&db, "/photos/2.png", jan_b);
        seed(&db, "/photos/3.png", mar);
        db.set_status(1, STATUS_KEPT, Some(1)).unwrap();

        let ids = db.queue_ids("month", Some("2026-01"), None, 0).unwrap();
        assert_eq!(ids, vec![2]);
        assert_eq!(
            db.queue_ids("month", Some("2026-03"), None, 0).unwrap(),
            vec![3]
        );
    }

    #[test]
    fn queue_scopes_filter_by_status() {
        let db = db();
        seed(&db, "/photos/1.png", 1_000);
        seed(&db, "/photos/2.png", 2_000);
        seed(&db, "/photos/3.png", 3_000);
        db.set_status(1, STATUS_KEPT, Some(1)).unwrap();
        db.set_status(2, STATUS_SKIPPED, Some(2)).unwrap();
        db.set_status(3, STATUS_STAGED, Some(3)).unwrap();

        assert_eq!(
            db.queue_ids("unreviewed", None, None, 0).unwrap(),
            Vec::<i64>::new()
        );
        assert_eq!(db.queue_ids("skipped", None, None, 0).unwrap(), vec![2]);
        assert_eq!(db.queue_ids("staged", None, None, 0).unwrap(), vec![3]);
        assert_eq!(db.queue_ids("random", None, None, 0).unwrap().len(), 0);
    }

    #[test]
    fn unreviewed_queue_is_newest_first() {
        let db = db();
        seed(&db, "/photos/1.png", 1_000);
        seed(&db, "/photos/2.png", 3_000);
        seed(&db, "/photos/3.png", 2_000);
        assert_eq!(
            db.queue_ids("unreviewed", None, None, 0).unwrap(),
            vec![2, 3, 1]
        );
    }

    #[test]
    fn random_queue_returns_every_pending_item() {
        let db = db();
        for i in 1..=25 {
            seed(&db, &format!("/photos/{i}.png"), i * 1_000);
        }
        let ids = db.queue_ids("random", None, None, 0).unwrap();
        assert_eq!(ids.len(), 25);
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 25);
    }

    #[test]
    fn items_preserve_requested_order_and_skip_unknown_ids() {
        let db = db();
        seed(&db, "/photos/1.png", 1_000);
        seed(&db, "/photos/2.png", 2_000);
        seed(&db, "/photos/3.png", 3_000);
        let got = db.items(&[3, 999, 1]).unwrap();
        assert_eq!(got.iter().map(|s| s.id).collect::<Vec<_>>(), vec![3, 1]);
        assert!(db.items(&[]).unwrap().is_empty());
    }

    #[test]
    fn items_survive_ids_longer_than_one_sql_chunk() {
        let db = db();
        for i in 0..950 {
            db.upsert_shot(
                1,
                &format!("/photos/{i}.png"),
                "a.png",
                "png",
                1,
                i,
                None,
                None,
                "created",
            )
            .unwrap();
        }
        let ids: Vec<i64> = (900..950).collect();
        let got = db.items(&ids).unwrap();
        assert_eq!(got.len(), 50);
        assert_eq!(got.first().unwrap().id, 900);
    }

    #[test]
    fn staging_maintains_the_staged_table() {
        let db = db();
        seed(&db, "/photos/1.png", 1_000);
        seed(&db, "/photos/2.png", 2_000);

        db.set_status(1, STATUS_STAGED, Some(10)).unwrap();
        assert_eq!(db.staged_rows().unwrap().len(), 1);

        // flipping to kept must also unstage
        db.set_status(1, STATUS_KEPT, Some(11)).unwrap();
        assert!(db.staged_rows().unwrap().is_empty());

        // re-staging reuses the same row
        db.set_status(1, STATUS_STAGED, Some(12)).unwrap();
        assert_eq!(db.staged_rows().unwrap().len(), 1);
        db.set_status(1, STATUS_STAGED, Some(13)).unwrap();
        assert_eq!(db.staged_rows().unwrap().len(), 1);

        // committed deletes leave the staged table
        db.set_status(1, STATUS_DELETED, Some(14)).unwrap();
        assert!(db.staged_rows().unwrap().is_empty());
        assert_eq!(db.shot(1).unwrap().unwrap().status, STATUS_DELETED);
    }

    #[test]
    fn set_status_rejects_unknown_states() {
        let db = db();
        seed(&db, "/photos/1.png", 1_000);
        assert!(db.set_status(1, "banana", Some(1)).is_err());
    }

    #[test]
    fn summary_counts_states_and_bytes() {
        let db = db();
        db.upsert_shot(
            1,
            "/photos/1.png",
            "a.png",
            "png",
            100,
            1_000,
            None,
            None,
            "created",
        )
        .unwrap();
        db.upsert_shot(
            1,
            "/photos/2.png",
            "b.png",
            "png",
            200,
            2_000,
            None,
            None,
            "created",
        )
        .unwrap();
        db.upsert_shot(
            1,
            "/photos/3.png",
            "c.png",
            "png",
            400,
            3_000,
            None,
            None,
            "created",
        )
        .unwrap();
        db.set_status(1, STATUS_KEPT, Some(1)).unwrap();
        db.set_status(2, STATUS_STAGED, Some(2)).unwrap();

        let s = db.summary(None, 0).unwrap();
        assert_eq!(s.total, 3);
        assert_eq!(s.kept, 1);
        assert_eq!(s.staged, 1);
        assert_eq!(s.pending, 1);
        assert_eq!(s.bytes_pending, 400);
        assert_eq!(s.bytes_total, 700);
        assert_eq!(s.months, 1);
    }

    #[test]
    fn summary_reports_staged_across_all_roots() {
        let db = Db::open_in_memory().expect("in-memory db");
        let a = db.upsert_root("/a").unwrap();
        let b = db.upsert_root("/b").unwrap();
        for root in [a, b] {
            for i in 0..2 {
                assert!(db
                    .upsert_shot(
                        root,
                        &format!("/{}/shot{i}.png", root),
                        &format!("shot{i}.png"),
                        "png",
                        100,
                        1_000 + i,
                        None,
                        None,
                        "filename",
                    )
                    .unwrap());
            }
        }
        // Stage one file in each root.
        let a_ids = db.queue_ids("unreviewed", None, Some(a), 0).unwrap();
        let b_ids = db.queue_ids("unreviewed", None, Some(b), 0).unwrap();
        db.set_status(a_ids[0], STATUS_STAGED, Some(1)).unwrap();
        db.set_status(b_ids[0], STATUS_STAGED, Some(2)).unwrap();

        // The root-filtered view is per root...
        assert_eq!(db.summary(Some(a), 0).unwrap().staged, 1);
        assert_eq!(db.summary(Some(b), 0).unwrap().staged, 1);
        // ...but the drawer and the commit are global, so this must be too.
        assert_eq!(db.summary(Some(a), 0).unwrap().staged_all, 2);
        assert_eq!(db.summary(Some(b), 0).unwrap().staged_all, 2);
        assert_eq!(db.summary(None, 0).unwrap().staged_all, 2);
        assert_eq!(db.summary(Some(a), 0).unwrap().bytes_staged_all, 200);
    }

    /// Seeds a row in root 1 with an explicit size and returns its id.
    fn seed_sized(db: &Db, path: &str, taken_ms: i64, size: i64) -> i64 {
        db.upsert_shot(
            1, path, "a.png", "png", size, taken_ms, None, None, "filename",
        )
        .unwrap();
        db.conn
            .query_row(
                "SELECT id FROM screenshots WHERE path = ?1",
                params![path],
                |r| r.get(0),
            )
            .unwrap()
    }

    /// What a rescan does to a row whose file it no longer finds.
    fn mark_missing(db: &Db, id: i64) {
        db.conn
            .execute(
                "UPDATE screenshots SET missing = 1 WHERE id = ?1",
                params![id],
            )
            .unwrap();
    }

    #[test]
    fn queues_leave_out_missing_files_except_the_staged_queue() {
        let db = db();
        let jan = 1_768_476_000_000i64;
        let at = |hour: i64| jan + hour * 3_600_000;
        let pending_here = seed_sized(&db, "/photos/1.png", at(0), 1);
        let pending_gone = seed_sized(&db, "/photos/2.png", at(1), 1);
        let skipped_here = seed_sized(&db, "/photos/3.png", at(2), 1);
        let skipped_gone = seed_sized(&db, "/photos/4.png", at(3), 1);
        let staged_here = seed_sized(&db, "/photos/5.png", at(4), 1);
        let staged_gone = seed_sized(&db, "/photos/6.png", at(5), 1);
        for id in [skipped_here, skipped_gone] {
            db.set_status(id, STATUS_SKIPPED, Some(1)).unwrap();
        }
        for id in [staged_here, staged_gone] {
            db.set_status(id, STATUS_STAGED, Some(1)).unwrap();
        }
        for id in [pending_gone, skipped_gone, staged_gone] {
            mark_missing(&db, id);
        }

        let q = |scope: &str, month: Option<&str>| db.queue_ids(scope, month, None, 0).unwrap();
        assert_eq!(q("month", Some("2026-01")), vec![pending_here]);
        assert_eq!(q("unreviewed", None), vec![pending_here]);
        assert_eq!(q("random", None), vec![pending_here]);
        assert_eq!(q("skipped", None), vec![skipped_here]);
        // The commit is what settles a gone file, so it stays listed until then.
        assert_eq!(q("staged", None), vec![staged_here, staged_gone]);
        // The month queue now agrees with the month row's own count.
        let month = &db.months(None, 0).unwrap()[0];
        assert_eq!(month.remaining, q("month", Some("2026-01")).len() as i64);
    }

    #[test]
    fn summary_leaves_missing_files_out_of_everything_but_missing() {
        let db = db();
        let jan = 1_768_476_000_000i64;
        let mar = jan + 60 * 86_400_000;
        seed_sized(&db, "/photos/1.png", jan, 100); // pending, on disk
        let pending_gone = seed_sized(&db, "/photos/2.png", jan, 200);
        let deleted_here = seed_sized(&db, "/photos/3.png", jan, 400);
        let deleted_gone = seed_sized(&db, "/photos/4.png", jan, 800);
        let staged_here = seed_sized(&db, "/photos/5.png", jan, 1_600);
        // March holds only a missing file, so it is not a month the list shows.
        let staged_gone = seed_sized(&db, "/photos/6.png", mar, 3_200);
        for id in [deleted_here, deleted_gone] {
            db.set_status(id, STATUS_DELETED, Some(1)).unwrap();
        }
        for id in [staged_here, staged_gone] {
            db.set_status(id, STATUS_STAGED, Some(1)).unwrap();
        }
        for id in [pending_gone, deleted_gone, staged_gone] {
            mark_missing(&db, id);
        }
        // Another root's freed space must not leak into root 1's figures.
        let other = db.upsert_root("/other").unwrap();
        db.upsert_shot(
            other,
            "/other/x.png",
            "x.png",
            "png",
            10_000,
            jan,
            None,
            None,
            "filename",
        )
        .unwrap();
        let x = db.queue_ids("unreviewed", None, Some(other), 0).unwrap()[0];
        db.set_status(x, STATUS_DELETED, Some(1)).unwrap();

        let s = db.summary(Some(1), 0).unwrap();
        assert_eq!(
            (s.total, s.pending, s.staged, s.deleted, s.kept, s.skipped),
            (3, 1, 1, 1, 0, 0)
        );
        assert_eq!(s.missing, 3, "missing still counts the missing rows");
        assert_eq!(s.bytes_total, 100 + 400 + 1_600);
        assert_eq!(s.bytes_pending, 100);
        assert_eq!(s.bytes_deleted, 400);
        // The staged pair is the commit's scope, gone file included.
        assert_eq!((s.staged_all, s.bytes_staged_all), (2, 1_600 + 3_200));
        assert_eq!(db.summary(None, 0).unwrap().bytes_deleted, 400 + 10_000);

        // The header and the month list count the same rows.
        let months = db.months(Some(1), 0).unwrap();
        assert_eq!(s.months, 1);
        assert_eq!(s.months, months.len() as i64);
        assert_eq!(s.total, months.iter().map(|m| m.total).sum::<i64>());
        assert_eq!(s.pending, months.iter().map(|m| m.remaining).sum::<i64>());
        assert_eq!(s.staged, months.iter().map(|m| m.staged).sum::<i64>());
        assert_eq!(s.deleted, months.iter().map(|m| m.deleted).sum::<i64>());
    }

    #[test]
    fn month_thumbs_cap_each_month_and_show_only_files_on_disk() {
        let db = db();
        let jan = 1_768_476_000_000i64;
        let mar = jan + 60 * 86_400_000;
        let at = |hour: i64| jan + hour * 3_600_000;
        seed(&db, "/photos/old.png", at(0));
        seed(&db, "/photos/tie-a.png", at(1));
        seed(&db, "/photos/tie-b.png", at(1)); // same instant, higher id
        let gone = seed_sized(&db, "/photos/gone.png", at(2), 1);
        let binned = seed_sized(&db, "/photos/binned.png", at(3), 1);
        let march = seed_sized(&db, "/photos/march.png", mar, 1);
        mark_missing(&db, gone);
        mark_missing(&db, march);
        // Committed but not rescanned yet: still `missing = 0`, file in the bin.
        db.set_status(binned, STATUS_DELETED, Some(1)).unwrap();

        let thumbs = db.month_thumbs(None, 0, 2).unwrap();
        assert_eq!(
            thumbs,
            vec![(
                "2026-01".to_string(),
                vec![
                    "/photos/tie-b.png".to_string(),
                    "/photos/tie-a.png".to_string()
                ]
            )],
            "newest first, ties by id, capped, and no month made only of a missing file"
        );
        let uncapped = db.month_thumbs(None, 0, 12).unwrap();
        assert_eq!(uncapped[0].1.len(), 3);
        assert!(db.month_thumbs(Some(99), 0, 5).unwrap().is_empty());
    }

    #[test]
    fn forget_root_removes_its_rows_and_staged_entries_only() {
        let db = Db::open_in_memory().expect("in-memory db");
        let a = db.upsert_root("/a").unwrap();
        let b = db.upsert_root("/b").unwrap();
        let fill = |root: i64| -> Vec<i64> {
            for i in 0..2 {
                db.upsert_shot(
                    root,
                    &format!("/{root}/{i}.png"),
                    &format!("{i}.png"),
                    "png",
                    1,
                    1_000 + i,
                    None,
                    None,
                    "filename",
                )
                .unwrap();
            }
            let mut ids = db.queue_ids("unreviewed", None, Some(root), 0).unwrap();
            db.set_status(ids[0], STATUS_STAGED, Some(1)).unwrap();
            ids.sort_unstable();
            ids
        };
        let a_ids = fill(a);
        let b_ids = fill(b);

        let mut gone = db.forget_root(a).unwrap();
        gone.sort_unstable();
        assert_eq!(gone, a_ids, "reports exactly the rows that went");

        // /a's rows and its staged entry are gone, with no orphans left...
        assert!(db.items(&a_ids).unwrap().is_empty());
        assert_eq!(db.staged_rows().unwrap().len(), 1);
        assert!(b_ids.contains(&db.staged_rows().unwrap()[0].id));
        let orphans: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM staged
                 WHERE screenshot_id NOT IN (SELECT id FROM screenshots)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphans, 0);
        // ...and /b is untouched.
        let roots = db.list_roots().unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!((roots[0].id, roots[0].total, roots[0].staged), (b, 2, 1));
        assert_eq!(db.items(&b_ids).unwrap().len(), 2);
        assert_eq!(db.summary(None, 0).unwrap().staged_all, 1);

        assert!(db.forget_root(a).is_err(), "an unknown root is an error");
    }

    #[test]
    fn root_filter_limits_queries_to_one_root() {
        let db = db();
        let a = db.upsert_root("/a").unwrap();
        let b = db.upsert_root("/b").unwrap();
        assert_ne!(a, b);
        db.upsert_shot(
            a, "/a/1.png", "a.png", "png", 1, 1_000, None, None, "created",
        )
        .unwrap();
        db.upsert_shot(
            b, "/b/1.png", "b.png", "png", 1, 1_000, None, None, "created",
        )
        .unwrap();
        let b_id = db
            .shot(db.queue_ids("unreviewed", None, Some(b), 0).unwrap()[0])
            .unwrap()
            .unwrap()
            .id;
        assert_eq!(db.summary(None, 0).unwrap().total, 2); // /a + /b
        assert_eq!(db.summary(Some(a), 0).unwrap().total, 1);
        assert_eq!(
            db.queue_ids("unreviewed", None, Some(b), 0).unwrap(),
            vec![b_id]
        );
    }

    #[test]
    fn viewable_flag_follows_the_extension() {
        let db = db();
        db.upsert_shot(
            1,
            "/photos/a.png",
            "a.png",
            "png",
            1,
            1_000,
            None,
            None,
            "created",
        )
        .unwrap();
        db.upsert_shot(
            1,
            "/photos/b.HEIC",
            "b.HEIC",
            "HEIC",
            1,
            1_000,
            None,
            None,
            "created",
        )
        .unwrap();
        assert!(db.shot(1).unwrap().unwrap().viewable);
        assert!(!db.shot(2).unwrap().unwrap().viewable);
    }

    fn scanned(path: &str, taken_ms: i64) -> super::super::scan::ScannedFile {
        super::super::scan::ScannedFile {
            path: path.to_string(),
            name: path.rsplit('/').next().unwrap().to_string(),
            ext: "png".into(),
            size: 10,
            taken_ms,
            created_ms: None,
            modified_ms: None,
            date_source: "filename".into(),
        }
    }

    #[test]
    fn bulk_upsert_counts_added_then_refreshed() {
        let db = db();
        let files = vec![
            scanned("/photos/1.png", 1_000),
            scanned("/photos/2.png", 2_000),
        ];
        assert_eq!(db.upsert_shots_bulk(1, &files).unwrap(), (2, 0));
        assert_eq!(db.upsert_shots_bulk(1, &files).unwrap(), (0, 2));
        assert_eq!(db.count_in_root(1).unwrap(), 2);
        assert_eq!(db.count_missing_in_root(1).unwrap(), 0);
    }

    #[test]
    fn bulk_upsert_preserves_decisions() {
        let db = db();
        let files = vec![scanned("/photos/1.png", 1_000)];
        db.upsert_shots_bulk(1, &files).unwrap();
        db.set_status(1, STATUS_SKIPPED, Some(42)).unwrap();
        db.upsert_shots_bulk(1, &files).unwrap();
        let s = db.shot(1).unwrap().unwrap();
        assert_eq!(s.status, STATUS_SKIPPED);
        assert_eq!(s.decided_ms, Some(42));
    }

    #[test]
    fn bulk_upsert_of_nothing_is_a_no_op() {
        let db = db();
        assert_eq!(db.upsert_shots_bulk(1, &[]).unwrap(), (0, 0));
    }
}
