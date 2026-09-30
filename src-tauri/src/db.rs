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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Summary {
    pub total: i64,
    pub pending: i64,
    pub staged: i64,
    pub kept: i64,
    pub deleted: i64,
    pub skipped: i64,
    pub missing: i64,
    pub bytes_pending: i64,
    pub bytes_total: i64,
    pub months: i64,
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
                "bu veritabanı daha yeni bir sürüm ({current}) ile açıldı; uygulamayı güncelleyin"
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

    // ---- scan ----

    pub fn flag_root_missing(&self, root_id: i64) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE screenshots SET missing = 1 WHERE root_id = ?1 AND missing = 0",
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
        let sql = format!(
            "SELECT COUNT(*),
                    COALESCE(SUM(status = 'pending'), 0),
                    COALESCE(SUM(status = 'staged'), 0),
                    COALESCE(SUM(status = 'kept'), 0),
                    COALESCE(SUM(status = 'deleted'), 0),
                    COALESCE(SUM(status = 'skipped'), 0),
                    COALESCE(SUM(missing = 1), 0),
                    COALESCE(SUM(CASE WHEN status = 'pending' THEN size ELSE 0 END), 0),
                    COALESCE(SUM(size), 0)
             FROM screenshots
             WHERE 1 = 1{filter}",
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let refs = to_sql_refs(&args);
        let s = stmt
            .query_row(refs.as_slice(), |row| {
                Ok(Summary {
                    total: row.get(0)?,
                    pending: row.get(1)?,
                    staged: row.get(2)?,
                    kept: row.get(3)?,
                    deleted: row.get(4)?,
                    skipped: row.get(5)?,
                    missing: row.get(6)?,
                    bytes_pending: row.get(7)?,
                    bytes_total: row.get(8)?,
                    months: 0,
                })
            })
            .map_err(|e| e.to_string())?;
        let months = self.months(root_id, tz_offset_min)?.len() as i64;
        Ok(Summary { months, ..s })
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
             WHERE 1 = 1{filter}{month_clause}{status_clause}
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
            return Err(format!("geçersiz durum: {status}"));
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

    /// Staged rows joined with their screenshot paths, oldest first.
    pub fn staged_rows(&self) -> Result<Vec<(i64, String, String)>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT s.id, s.path, s.name FROM staged g
                 JOIN screenshots s ON s.id = g.screenshot_id
                 ORDER BY g.staged_ms ASC, s.taken_ms ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
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
