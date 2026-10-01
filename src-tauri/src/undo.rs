//! Session-only undo stack, with redo.
//!
//! Undoing an entry moves it to the redo side; redoing it moves it back. A new
//! action clears the redo side, as in any editor. Redo follows the mirror rule:
//! an entry only reapplies while its row still shows `prev`, and never to a
//! committed row.
//!
//! Decisions themselves are persisted; only the ability to walk them back is
//! per-session, which is all Ctrl+Z promises.
//!
//! Every entry records both sides of the change: the status it replaced
//! (`prev`) and the status it set (`next`). An entry only applies while its row
//! still shows `next`. Anything else means something later moved the row on,
//! most importantly a commit that sent the file to the Recycle Bin, and
//! restoring `prev` then would bring back a row whose file is gone.

use std::collections::HashSet;

use crate::db::STATUS_DELETED;

/// One reversible status change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UndoEntry {
    pub id: i64,
    /// The status before the action, which undo restores.
    pub prev: String,
    pub prev_decided_ms: Option<i64>,
    /// The status the action set.
    pub next: String,
    /// The decision time the action set, which redo restores. Filled in when
    /// the entry is undone.
    pub next_decided_ms: Option<i64>,
}

impl UndoEntry {
    /// Whether walking this entry back is still safe, given the row's current
    /// status (`None` once the row is gone).
    fn applies_to(&self, current: Option<&str>) -> bool {
        match current {
            // A committed file is in the Recycle Bin; nothing walks it back,
            // whatever the entry says.
            None | Some(STATUS_DELETED) => false,
            Some(status) => status == self.next,
        }
    }

    /// The mirror of `applies_to`, for redo: the row must still show `prev`.
    fn reapplies_to(&self, current: Option<&str>) -> bool {
        match current {
            None | Some(STATUS_DELETED) => false,
            Some(status) => status == self.prev,
        }
    }
}

#[derive(Debug)]
pub struct UndoStack {
    entries: Vec<UndoEntry>,
    redo: Vec<UndoEntry>,
    limit: usize,
}

impl UndoStack {
    pub fn new(limit: usize) -> Self {
        Self {
            entries: Vec::new(),
            redo: Vec::new(),
            limit,
        }
    }

    /// Records an action, dropping the oldest entries once past the limit.
    /// A new action clears the redo side.
    pub fn push(&mut self, entry: UndoEntry) {
        self.redo.clear();
        self.entries.push(entry);
        if self.entries.len() > self.limit {
            let excess = self.entries.len() - self.limit;
            self.entries.drain(..excess);
        }
    }

    /// Pops the most recent entry that still applies, discarding stale ones on
    /// the way down. `status_of` reports a row's current status, or `None` once
    /// the row is gone.
    ///
    /// The lookup runs before the pop, so an error leaves the stack as it was
    /// and the user can simply try again.
    pub fn pop_valid<E>(
        &mut self,
        mut status_of: impl FnMut(i64) -> Result<Option<String>, E>,
    ) -> Result<Option<UndoEntry>, E> {
        while let Some(id) = self.entries.last().map(|e| e.id) {
            let current = status_of(id)?;
            let Some(entry) = self.entries.pop() else {
                break;
            };
            if entry.applies_to(current.as_deref()) {
                return Ok(Some(entry));
            }
            crate::log::debug(
                "undo",
                &format!(
                    "dropped stale entry {id}: {} -> {}, now {}",
                    entry.prev,
                    entry.next,
                    current.as_deref().unwrap_or("gone")
                ),
            );
        }
        Ok(None)
    }

    /// Keeps an undone entry so redo can apply it again. `next_decided_ms` is
    /// the decision time the row had before the undo.
    pub fn push_redo(&mut self, mut entry: UndoEntry, next_decided_ms: Option<i64>) {
        entry.next_decided_ms = next_decided_ms;
        self.redo.push(entry);
    }

    /// Pops the most recent undone entry that can still be redone, dropping
    /// stale ones on the way, with the same lookup rules as `pop_valid`.
    pub fn pop_redo<E>(
        &mut self,
        mut status_of: impl FnMut(i64) -> Result<Option<String>, E>,
    ) -> Result<Option<UndoEntry>, E> {
        while let Some(id) = self.redo.last().map(|e| e.id) {
            let current = status_of(id)?;
            let Some(entry) = self.redo.pop() else {
                break;
            };
            if entry.reapplies_to(current.as_deref()) {
                return Ok(Some(entry));
            }
            crate::log::debug("redo", &format!("dropped stale entry {id}"));
        }
        Ok(None)
    }

    /// Puts a redone entry back on the undo side without clearing redo.
    pub fn push_redone(&mut self, entry: UndoEntry) {
        self.entries.push(entry);
        if self.entries.len() > self.limit {
            let excess = self.entries.len() - self.limit;
            self.entries.drain(..excess);
        }
    }

    /// Drops every entry for these ids. Used when rows are committed or
    /// forgotten: there is nothing left to walk back, and a forgotten row's id
    /// can be handed to a new row by a later scan.
    pub fn purge(&mut self, ids: &[i64]) {
        if ids.is_empty() {
            return;
        }
        let ids: HashSet<i64> = ids.iter().copied().collect();
        self.entries.retain(|e| !ids.contains(&e.id));
        self.redo.retain(|e| !ids.contains(&e.id));
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::convert::Infallible;

    use super::*;

    fn entry(id: i64, prev: &str, next: &str) -> UndoEntry {
        UndoEntry {
            id,
            prev: prev.to_string(),
            prev_decided_ms: None,
            next: next.to_string(),
            next_decided_ms: None,
        }
    }

    /// A stand-in for the database: id -> current status.
    fn rows(pairs: &[(i64, &str)]) -> HashMap<i64, String> {
        pairs.iter().map(|&(id, s)| (id, s.to_string())).collect()
    }

    fn pop(stack: &mut UndoStack, rows: &HashMap<i64, String>) -> Option<UndoEntry> {
        stack
            .pop_valid(|id| Ok::<_, Infallible>(rows.get(&id).cloned()))
            .unwrap()
    }

    #[test]
    fn push_trims_the_oldest_entries_past_the_limit() {
        let mut stack = UndoStack::new(3);
        for id in 1..=5 {
            stack.push(entry(id, "pending", "kept"));
        }
        assert_eq!(stack.len(), 3);
        let ids: Vec<i64> = stack.entries.iter().map(|e| e.id).collect();
        assert_eq!(ids, vec![3, 4, 5], "the newest entries survive");
    }

    #[test]
    fn pop_returns_the_latest_entry_that_still_applies() {
        let mut stack = UndoStack::new(10);
        stack.push(entry(1, "pending", "kept"));
        stack.push(entry(2, "pending", "skipped"));
        let db = rows(&[(1, "kept"), (2, "skipped")]);
        assert_eq!(pop(&mut stack, &db).unwrap().id, 2);
        assert_eq!(pop(&mut stack, &db).unwrap().id, 1);
        assert!(pop(&mut stack, &db).is_none());
    }

    #[test]
    fn stale_entries_are_skipped_and_discarded() {
        let mut stack = UndoStack::new(10);
        stack.push(entry(1, "pending", "kept")); // still valid
        stack.push(entry(2, "pending", "staged")); // committed since
        stack.push(entry(3, "pending", "skipped")); // re-decided elsewhere
        stack.push(entry(4, "pending", "kept")); // row forgotten
        let db = rows(&[(1, "kept"), (2, "deleted"), (3, "kept")]);

        assert_eq!(pop(&mut stack, &db).unwrap().id, 1);
        assert!(stack.is_empty(), "the stale entries went with it");
    }

    #[test]
    fn a_deleted_row_is_never_walked_back() {
        // Even an entry that claims to have set `deleted` does not apply:
        // the file is in the Recycle Bin.
        let mut stack = UndoStack::new(10);
        stack.push(entry(1, "staged", "deleted"));
        assert!(pop(&mut stack, &rows(&[(1, "deleted")])).is_none());
        assert!(stack.is_empty());
    }

    #[test]
    fn purge_drops_every_entry_for_the_ids() {
        let mut stack = UndoStack::new(10);
        stack.push(entry(1, "pending", "staged"));
        stack.push(entry(2, "pending", "kept"));
        stack.push(entry(1, "staged", "pending"));
        stack.push(entry(3, "pending", "staged"));
        stack.purge(&[1, 3, 99]);
        let ids: Vec<i64> = stack.entries.iter().map(|e| e.id).collect();
        assert_eq!(ids, vec![2]);
        stack.purge(&[]);
        assert_eq!(stack.len(), 1);
    }

    #[test]
    fn redo_reapplies_undone_entries_until_a_new_action() {
        let mut stack = UndoStack::new(10);
        stack.push(entry(1, "pending", "kept"));
        let e = pop(&mut stack, &rows(&[(1, "kept")])).unwrap();
        stack.push_redo(e, Some(7));
        let back = stack
            .pop_redo(|_| Ok::<_, Infallible>(Some("pending".to_string())))
            .unwrap()
            .unwrap();
        assert_eq!((back.id, back.next_decided_ms), (1, Some(7)));
        stack.push_redone(back.clone());
        assert_eq!(stack.len(), 1);

        stack.push_redo(back, None);
        stack.push(entry(2, "pending", "kept"));
        let none = stack
            .pop_redo(|_| Ok::<_, Infallible>(Some("pending".to_string())))
            .unwrap();
        assert!(none.is_none(), "a new action clears redo");
    }

    #[test]
    fn redo_skips_rows_that_moved_on_or_were_committed() {
        let mut stack = UndoStack::new(10);
        stack.push_redo(entry(1, "pending", "staged"), None);
        stack.push_redo(entry(2, "pending", "kept"), None);
        let db = rows(&[(1, "pending"), (2, "deleted")]);
        let got = stack
            .pop_redo(|id| Ok::<_, Infallible>(db.get(&id).cloned()))
            .unwrap();
        assert_eq!(got.unwrap().id, 1);
        assert!(stack.redo.is_empty());
    }

    #[test]
    fn a_failed_lookup_leaves_the_stack_as_it_was() {
        let mut stack = UndoStack::new(10);
        stack.push(entry(1, "pending", "kept"));
        let got = stack.pop_valid(|_| Err::<Option<String>, _>("db is locked"));
        assert_eq!(got, Err("db is locked"));
        assert_eq!(stack.len(), 1);
    }
}
