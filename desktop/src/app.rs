//! App state and the requests that fill it. Every read runs on Rune's
//! `Latest` workers; answers land in `poll` on the UI thread, and a newer
//! request supersedes an older one (switching projects quickly never shows a
//! stale list).

use std::sync::Arc;

use rune::{Latest, TextEdit, Tx, Waker};
use rune_kit::{SortDir, TableState};

use crate::model::{Failure, IssueDetail, IssueSummary, Project, Source};

/// A value that arrives from the server.
#[derive(Clone, Debug, PartialEq)]
pub enum Load<T> {
    Idle,
    Loading,
    Ready(T),
    Failed(Failure),
}

impl<T> Load<T> {
    pub fn ready(&self) -> Option<&T> {
        match self {
            Load::Ready(v) => Some(v),
            _ => None,
        }
    }
}

/// The status filter above the issue table.
pub const STATUS_FILTERS: [(&str, Option<&str>); 5] = [
    ("All", None),
    ("Open", Some("open")),
    ("In progress", Some("in_progress")),
    ("Blocked", Some("blocked")),
    ("Closed", Some("closed")),
];

type IssuesAnswer = (String, Result<Vec<IssueSummary>, Failure>);
type DetailAnswer = (String, String, Result<Option<IssueDetail>, Failure>);

pub struct State {
    pub source: Arc<dyn Source>,
    pub projects: Load<Vec<Project>>,
    pub project: Option<String>,
    pub issues: Load<Vec<IssueSummary>>,
    /// Indices into the loaded issues that pass the filters, in table order.
    pub visible: Vec<usize>,
    pub search: TextEdit,
    pub status_filter: usize,
    pub table: TableState,
    pub issue: Option<String>,
    pub detail: Load<Option<IssueDetail>>,
    projects_req: Latest<Result<Vec<Project>, Failure>>,
    issues_req: Latest<IssuesAnswer>,
    detail_req: Latest<DetailAnswer>,
}

impl State {
    pub fn new(source: Arc<dyn Source>) -> State {
        State {
            source,
            projects: Load::Idle,
            project: None,
            issues: Load::Idle,
            visible: Vec::new(),
            search: TextEdit::new(""),
            status_filter: 0,
            table: TableState::new(),
            issue: None,
            detail: Load::Idle,
            projects_req: Latest::default(),
            issues_req: Latest::default(),
            detail_req: Latest::default(),
        }
    }

    /// Attach the waker and start the first read, unless a scene already
    /// filled the state.
    pub fn setup(&mut self, waker: Waker) {
        self.projects_req.set_waker(waker.clone());
        self.issues_req.set_waker(waker.clone());
        self.detail_req.set_waker(waker);
        if self.projects == Load::Idle {
            self.load_projects();
        }
    }

    pub fn load_projects(&mut self) {
        if self.projects.ready().is_none() {
            self.projects = Load::Loading;
        }
        let source = self.source.clone();
        self.projects_req.request((), move |()| source.projects());
    }

    pub fn select_project(&mut self, name: &str) {
        if self.project.as_deref() != Some(name) {
            self.project = Some(name.to_string());
            self.issues = Load::Loading;
            self.visible.clear();
            self.table.clear_selection();
            self.issue = None;
            self.detail = Load::Idle;
            self.detail_req.cancel();
        }
        let source = self.source.clone();
        self.issues_req.request(name.to_string(), move |db| {
            let answer = source.issues(&db);
            (db, answer)
        });
    }

    pub fn select_issue(&mut self, id: &str) {
        let Some(db) = self.project.clone() else { return };
        if self.issue.as_deref() != Some(id) {
            self.issue = Some(id.to_string());
            self.detail = Load::Loading;
        }
        if !self.table.is_selected(id) {
            self.table.select(id.to_string());
        }
        let source = self.source.clone();
        self.detail_req.request((db, id.to_string()), move |(db, id)| {
            let answer = source.issue(&db, &id);
            (db, id, answer)
        });
    }

    /// Re-read everything on screen.
    pub fn refresh(&mut self) {
        self.load_projects();
        if let Some(p) = self.project.clone() {
            self.select_project(&p);
        }
        if let Some(i) = self.issue.clone() {
            self.select_issue(&i);
        }
    }

    pub fn is_loading(&self) -> bool {
        self.projects_req.is_pending() || self.issues_req.is_pending() || self.detail_req.is_pending()
    }

    /// Land finished reads. True when visible state changed.
    pub fn poll(&mut self, tx: &mut Tx) -> bool {
        let mut changed = false;
        if let Some(answer) = self.projects_req.take() {
            changed = true;
            match answer {
                Ok(projects) => {
                    let first = projects.first().map(|p| p.name.clone());
                    let current_gone = self.project.as_ref().is_some_and(|c| !projects.iter().any(|p| &p.name == c));
                    self.projects = Load::Ready(projects);
                    if (self.project.is_none() || current_gone)
                        && let Some(first) = first
                    {
                        self.select_project(&first);
                    }
                }
                Err(f) => self.projects = Load::Failed(f),
            }
        }
        if let Some((db, answer)) = self.issues_req.take()
            && self.project.as_deref() == Some(db.as_str())
        {
            changed = true;
            match answer {
                Ok(issues) => {
                    self.issues = Load::Ready(issues);
                    self.resort();
                    self.refilter();
                }
                Err(f) => self.issues = Load::Failed(f),
            }
        }
        if let Some((db, id, answer)) = self.detail_req.take()
            && self.project.as_deref() == Some(db.as_str())
            && self.issue.as_deref() == Some(id.as_str())
        {
            changed = true;
            self.detail = match answer {
                Ok(d) => Load::Ready(d),
                Err(f) => Load::Failed(f),
            };
        }
        // Answers land without animation, so the first second after launch stays still.
        if changed {
            tx.instant();
        }
        changed
    }

    /// Recompute `visible` from the search text and status filter.
    pub fn refilter(&mut self) {
        let query = self.search.text.trim().to_lowercase();
        let status = STATUS_FILTERS.get(self.status_filter).and_then(|(_, s)| *s);
        let Some(issues) = self.issues.ready() else {
            self.visible.clear();
            return;
        };
        self.visible = issues
            .iter()
            .enumerate()
            .filter(|(_, i)| status.is_none_or(|s| i.status == s))
            .filter(|(_, i)| {
                query.is_empty()
                    || i.title.to_lowercase().contains(&query)
                    || i.id.to_lowercase().contains(&query)
                    || i.labels.iter().any(|l| l.to_lowercase().contains(&query))
                    || i.assignee.as_ref().is_some_and(|a| a.to_lowercase().contains(&query))
            })
            .map(|(n, _)| n)
            .collect();
    }

    pub fn sort(&mut self, column: &str, dir: SortDir) {
        self.table.set_sort(column, dir);
        self.resort();
        self.refilter();
    }

    fn resort(&mut self) {
        let Some((column, dir)) = self.table.sort().map(|(c, d)| (c.to_string(), d)) else { return };
        let Load::Ready(issues) = &mut self.issues else { return };
        issues.sort_by(|a, b| {
            let o = match column.as_str() {
                "id" => rune_kit::natural_cmp(&a.id, &b.id),
                "title" => a.title.to_lowercase().cmp(&b.title.to_lowercase()),
                "status" => status_rank(&a.status).cmp(&status_rank(&b.status)),
                "priority" => a.priority.cmp(&b.priority),
                "type" => a.issue_type.cmp(&b.issue_type),
                "assignee" => a.assignee.cmp(&b.assignee),
                _ => a.updated_at.cmp(&b.updated_at),
            };
            dir.apply(o)
        });
    }

    pub fn visible_issue(&self, row: usize) -> Option<&IssueSummary> {
        self.issues.ready()?.get(*self.visible.get(row)?)
    }

    pub fn current_project(&self) -> Option<&Project> {
        let name = self.project.as_deref()?;
        self.projects.ready()?.iter().find(|p| p.name == name)
    }
}

/// Lifecycle order for sorting by status.
fn status_rank(status: &str) -> u8 {
    match status {
        "in_progress" => 0,
        "open" => 1,
        "blocked" => 2,
        "closed" => 4,
        _ => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sample::Sample;

    fn loaded() -> State {
        let mut s = State::new(Arc::new(Sample));
        s.projects = Load::Ready(Sample.projects().unwrap());
        s.project = Some("lighthouse".into());
        s.issues = Load::Ready(Sample.issues("lighthouse").unwrap());
        s.refilter();
        s
    }

    #[test]
    fn filters_combine_status_and_search() {
        let mut s = loaded();
        assert_eq!(s.visible.len(), 9);
        s.status_filter = 1; // Open
        s.refilter();
        assert!(s.visible.iter().all(|&i| s.issues.ready().unwrap()[i].status == "open"));
        s.search.replace_text("gasket");
        s.refilter();
        let ids: Vec<_> = (0..s.visible.len()).map(|r| s.visible_issue(r).unwrap().id.clone()).collect();
        assert_eq!(ids, ["lh-5"]);
        s.search.replace_text("MAINTENANCE");
        s.status_filter = 0;
        s.refilter();
        assert_eq!(s.visible.len(), 2, "labels match, case-insensitively");
    }

    #[test]
    fn sorting_by_priority_puts_p0_first() {
        let mut s = loaded();
        s.sort("priority", SortDir::Ascending);
        assert_eq!(s.visible_issue(0).unwrap().id, "lh-2");
    }

    #[test]
    fn switching_projects_clears_the_selected_issue() {
        let mut s = loaded();
        s.select_issue("lh-1");
        assert_eq!(s.issue.as_deref(), Some("lh-1"));
        s.select_project("pantry");
        assert_eq!((s.issue.as_deref(), &s.issues), (None, &Load::Loading));
    }
}
