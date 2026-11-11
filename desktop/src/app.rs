//! App state and the requests that fill it. Every read runs on Rune's
//! `Latest` workers; answers land in `poll` on the UI thread, and a newer
//! request supersedes an older one (switching projects quickly never shows a
//! stale list).

use std::sync::Arc;

use rune::{Latest, TextEdit, Tx, Waker};
use rune_kit::{SortDir, TableState};

use crate::dolt::{Config, Credential, Dolt};
use crate::model::{Failure, IssueDetail, IssueSummary, Project, Source, Unconfigured};
use crate::settings::{self, Backing, Env, FormError, Lookup, SecretStore, StoreError, Stored};

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

/// Refreshes that failed while the answer before them stayed on screen. A
/// failed re-read never replaces data the window already shows (the design
/// standards: "retain useful existing content during refresh and identify
/// stale data"); it is recorded here, and the view says so in a banner.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stale {
    pub projects: Option<Failure>,
    pub issues: Option<Failure>,
    pub detail: Option<Failure>,
}

impl Stale {
    /// Why what is on screen may be out of date, if it may be. One refresh
    /// usually fails every read the same way, so the widest read speaks.
    pub fn failure(&self) -> Option<Failure> {
        self.projects.or(self.issues).or(self.detail)
    }
}

/// The issue table's element key.
pub const TABLE_KEY: &str = "issues";

/// What one tab of the filter above the issue table lets through.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Filter {
    All,
    /// Open with nothing blocking it (`IssueSummary::is_ready`).
    Ready,
    /// A lifecycle status, as stored.
    Status(&'static str),
}

impl Filter {
    pub fn admits(self, issue: &IssueSummary) -> bool {
        match self {
            Filter::All => true,
            Filter::Ready => issue.is_ready(),
            Filter::Status(status) => issue.status == status,
        }
    }
}

/// The filter above the issue table. Ready sits before the statuses because
/// it is the question a list of work is opened to answer: what can be picked
/// up now. It is a subset of Open, not a status of its own.
pub const STATUS_FILTERS: [(&str, Filter); 6] = [
    ("All", Filter::All),
    ("Ready", Filter::Ready),
    ("Open", Filter::Status("open")),
    ("In progress", Filter::Status("in_progress")),
    ("Blocked", Filter::Status("blocked")),
    ("Closed", Filter::Status("closed")),
];

/// The columns `s` steps the sort through: the ones the table shows at every
/// window width, so the header always names the sort the key chose.
pub const SORT_CYCLE: [&str; 6] = ["id", "title", "status", "blockers", "priority", "updated"];

/// The issues walked through by following dependency links, so a reader who
/// follows a blocker to its own blocker can come back the way they came, as
/// in a browser. Only links add to it: choosing an issue in the list starts
/// over (`State::select_issue`), since stepping through rows is not a path
/// anyone wants to retrace.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Trail {
    /// Issues to go back to, the most recent last.
    pub back: Vec<String>,
    /// Issues gone back from, the next one forward last.
    pub forward: Vec<String>,
}

impl Trail {
    pub fn is_empty(&self) -> bool {
        self.back.is_empty() && self.forward.is_empty()
    }

    fn clear(&mut self) {
        self.back.clear();
        self.forward.clear();
    }
}

/// Which pane plain keys drive. Rune can move keyboard focus to a text field
/// but not to an arbitrary element, so "the detail pane has the keyboard" is
/// the app's own state: the view rings the pane, and `keys` reads this to
/// decide whether `j` moves the selection or scrolls the issue.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Pane {
    #[default]
    List,
    Detail,
}

/// A move of the selection through the visible rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Next,
    Previous,
    First,
    Last,
}

/// What "Test connection" last found for the values now in the form.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Check {
    Idle,
    Testing,
    /// Connected; this many projects are visible to the account.
    Ok(usize),
    Failed(Failure),
}

/// The connection form, present while its screen is open.
pub struct Connection {
    pub host: TextEdit,
    pub port: TextEdit,
    pub user: TextEdit,
    /// Typed here and handed to the keychain on Save. It starts empty even
    /// when a password is saved: the form never reads the keychain.
    pub password: TextEdit,
    pub check: Check,
    pub error: Option<FormError>,
    /// The password is on its way to the keychain.
    pub saving: bool,
    /// A connection is already saved, so a blank password keeps its password.
    pub saved: bool,
}

impl Connection {
    /// The form over what is in effect now. A field the environment sets
    /// shows that value; the view disables it and says which variable owns it.
    fn new(env: &Env, stored: Option<&Stored>) -> Connection {
        let current = env.config(stored);
        let host = current.as_ref().map(|c| c.host.clone()).unwrap_or_default();
        let port = current.as_ref().map_or(env.port.unwrap_or(settings::DEFAULT_PORT), |c| c.port);
        let user = current.map(|c| c.user).or_else(|| env.user.clone()).unwrap_or_default();
        Connection {
            host: TextEdit::new(host),
            port: TextEdit::new(port.to_string()),
            user: TextEdit::new(user),
            password: TextEdit::new("").secure(),
            check: Check::Idle,
            error: None,
            saving: false,
            saved: stored.is_some(),
        }
    }
}

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
    pub trail: Trail,
    pub detail: Load<Option<IssueDetail>>,
    pub stale: Stale,
    pub pane: Pane,
    /// The keyboard shortcuts overlay is open.
    pub shortcuts: bool,
    projects_req: Latest<Result<Vec<Project>, Failure>>,
    issues_req: Latest<IssuesAnswer>,
    detail_req: Latest<DetailAnswer>,
    /// The connection screen, when open.
    pub connection: Option<Connection>,
    pub env: Env,
    lookup: Lookup,
    prefs: rune::prefs::Prefs,
    secrets: Arc<dyn SecretStore>,
    /// Where an edit goes if it lands after the form closed.
    closed_edit: TextEdit,
    test_req: Latest<Result<usize, Failure>>,
    save_req: Latest<(Stored, Result<(), StoreError>)>,
}

impl State {
    /// The state for a launch: the server the environment and the settings
    /// file name, or the connection screen when they name none.
    pub fn launch(backing: Backing) -> State {
        let config = backing.env.config(Stored::load(&backing.prefs).as_ref());
        let first_run = config.is_none();
        let source: Arc<dyn Source> = match config {
            Some(config) => Arc::new(Dolt::new(
                config,
                Credential::Stored { lookup: backing.lookup, store: backing.secrets.clone() },
            )),
            None => Arc::new(Unconfigured),
        };
        let mut state = State::new(source, backing);
        if first_run {
            state.open_connection();
        }
        state
    }

    pub fn new(source: Arc<dyn Source>, backing: Backing) -> State {
        State {
            source,
            projects: Load::Idle,
            project: None,
            issues: Load::Idle,
            visible: Vec::new(),
            search: TextEdit::new(""),
            status_filter: 0,
            // The key the view's table is built under, so the table's own
            // reveal and `keys` scroll the same element.
            table: TableState::new().key(TABLE_KEY),
            issue: None,
            trail: Trail::default(),
            detail: Load::Idle,
            stale: Stale::default(),
            pane: Pane::List,
            shortcuts: false,
            projects_req: Latest::default(),
            issues_req: Latest::default(),
            detail_req: Latest::default(),
            connection: None,
            env: backing.env,
            lookup: backing.lookup,
            prefs: backing.prefs,
            secrets: backing.secrets,
            closed_edit: TextEdit::new(""),
            test_req: Latest::default(),
            save_req: Latest::default(),
        }
    }

    /// Attach the waker and start the first read, unless a scene already
    /// filled the state.
    pub fn setup(&mut self, waker: Waker) {
        self.projects_req.set_waker(waker.clone());
        self.issues_req.set_waker(waker.clone());
        self.detail_req.set_waker(waker.clone());
        self.test_req.set_waker(waker.clone());
        self.save_req.set_waker(waker);
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
            self.trail.clear();
            self.pane = Pane::List;
            self.detail = Load::Idle;
            self.detail_req.cancel();
            self.stale.issues = None;
            self.stale.detail = None;
        } else if self.issues.ready().is_none() {
            // A retry after a failed first read: show it as pending again.
            self.issues = Load::Loading;
        }
        let source = self.source.clone();
        self.issues_req.request(name.to_string(), move |db| {
            let answer = source.issues(&db);
            (db, answer)
        });
    }

    /// Choose an issue from the list. Choosing another one ends the trail of
    /// followed links; asking again for the one on screen (a refresh, a
    /// retry) keeps it.
    pub fn select_issue(&mut self, id: &str) {
        if self.issue.as_deref() != Some(id) {
            self.trail.clear();
        }
        self.show_issue(id);
    }

    /// Follow a dependency link from the issue on screen, remembering the
    /// way back. Like a link in a browser, it drops whatever was forward.
    pub fn follow_link(&mut self, id: &str) {
        if self.issue.as_deref() == Some(id) {
            return;
        }
        if let Some(from) = self.issue.clone() {
            self.trail.back.push(from);
        }
        self.trail.forward.clear();
        self.show_issue(id);
    }

    /// Back to the issue the last link was followed from. Returns it, for
    /// the caller to scroll the list to; `None` when there is no way back.
    pub fn go_back(&mut self) -> Option<String> {
        let to = self.trail.back.pop()?;
        if let Some(from) = self.issue.clone() {
            self.trail.forward.push(from);
        }
        self.show_issue(&to);
        Some(to)
    }

    /// Forward again along a trail `go_back` walked back.
    pub fn go_forward(&mut self) -> Option<String> {
        let to = self.trail.forward.pop()?;
        if let Some(from) = self.issue.clone() {
            self.trail.back.push(from);
        }
        self.show_issue(&to);
        Some(to)
    }

    /// Put an issue in the detail pane and ask the server for it. The list
    /// selects it too, even when the filters hide its row.
    fn show_issue(&mut self, id: &str) {
        let Some(db) = self.project.clone() else { return };
        if self.issue.as_deref() != Some(id) {
            self.issue = Some(id.to_string());
            self.detail = Load::Loading;
            self.stale.detail = None;
        } else if self.detail.ready().is_none() {
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

    // -- Keyboard ------------------------------------------------------------------------------
    // What the keys in `keys.rs` do to the state. Scrolling and focus are the
    // caller's, since they need Rune's `Tx`.

    /// A dialog owns the keyboard: no window shortcut may act under it.
    pub fn modal_open(&self) -> bool {
        self.connection.is_some() || self.shortcuts
    }

    /// The selected issue's row among the visible ones. `None` when nothing
    /// is selected or the filters hide it.
    pub fn selected_row(&self) -> Option<usize> {
        let id = self.issue.as_deref()?;
        (0..self.visible.len()).find(|&row| self.visible_issue(row).is_some_and(|i| i.id == id))
    }

    /// Move the selection through the rows as filtered and sorted, stopping
    /// at the ends as the table's own arrows do. With no row selected (or the
    /// selected one filtered out) Next starts at the top and Previous at the
    /// bottom. Returns the issue now selected, for the caller to scroll to.
    pub fn move_selection(&mut self, step: Step) -> Option<String> {
        let last = self.visible.len().checked_sub(1)?;
        let row = match (step, self.selected_row()) {
            (Step::First, _) | (Step::Next, None) => 0,
            (Step::Last, _) | (Step::Previous, None) => last,
            (Step::Next, Some(row)) => (row + 1).min(last),
            (Step::Previous, Some(row)) => row.saturating_sub(1),
        };
        let id = self.visible_issue(row)?.id.clone();
        self.pane = Pane::List;
        self.select_issue(&id);
        Some(id)
    }

    /// Give the keyboard to the selected issue's pane. False when no issue is
    /// selected, so there is nothing to read.
    pub fn open_detail(&mut self) -> bool {
        if self.issue.is_some() {
            self.pane = Pane::Detail;
        }
        self.issue.is_some()
    }

    pub fn clear_selection(&mut self) {
        self.table.clear_selection();
        self.issue = None;
        self.trail.clear();
        self.pane = Pane::List;
        self.detail = Load::Idle;
        self.detail_req.cancel();
        self.stale.detail = None;
    }

    pub fn has_filters(&self) -> bool {
        self.status_filter != 0 || !self.search.text.is_empty()
    }

    /// The `n`th project in the sidebar, from 0. False when there is none.
    pub fn select_project_at(&mut self, n: usize) -> bool {
        let Some(name) = self.projects.ready().and_then(|p| p.get(n)).map(|p| p.name.clone()) else { return false };
        self.select_project(&name);
        true
    }

    /// Sort by the column after the current one in `SORT_CYCLE`, ascending:
    /// the keyboard's way to a header click.
    pub fn sort_next(&mut self) {
        let current = self.table.sort().and_then(|(column, _)| SORT_CYCLE.iter().position(|c| *c == column));
        let next = current.map_or(0, |n| (n + 1) % SORT_CYCLE.len());
        self.sort(SORT_CYCLE[next], SortDir::Ascending);
    }

    /// Flip the direction of the current sort. False when nothing is sorted.
    pub fn sort_reverse(&mut self) -> bool {
        let Some((column, dir)) = self.table.sort().map(|(c, d)| (c.to_string(), d)) else { return false };
        self.sort(&column, dir.flip());
        true
    }

    /// Re-read everything on screen. This is also "Retry": a read that
    /// failed with nothing to show goes back to loading, and one that failed
    /// over earlier data keeps that data until the new answer lands.
    pub fn refresh(&mut self) {
        self.load_projects();
        if let Some(p) = self.project.clone() {
            self.select_project(&p);
        }
        if let Some(i) = self.issue.clone() {
            self.select_issue(&i);
        }
    }

    // -- Connection settings -------------------------------------------------------------------

    pub fn open_connection(&mut self) {
        if self.connection.is_none() {
            self.connection = Some(Connection::new(&self.env, Stored::load(&self.prefs).as_ref()));
        }
    }

    pub fn close_connection(&mut self) {
        self.test_req.cancel();
        self.connection = None;
    }

    /// One of the form's fields, for the view's edit bindings.
    pub fn connection_field(&mut self, pick: fn(&mut Connection) -> &mut TextEdit) -> &mut TextEdit {
        match &mut self.connection {
            Some(form) => pick(form),
            None => &mut self.closed_edit,
        }
    }

    /// The form changed, so an earlier test result no longer describes it.
    pub fn connection_edited(&mut self) {
        self.test_req.cancel();
        if let Some(form) = &mut self.connection {
            form.check = Check::Idle;
            form.error = None;
        }
    }

    /// The form's values, checked, with the fields the environment owns
    /// taken from the environment: what a test or a save would connect to.
    fn connection_target(&mut self) -> Option<Stored> {
        let form = self.connection.as_mut()?;
        match Stored::parse(&form.host.text, &form.port.text, &form.user.text) {
            Ok(typed) => {
                let config = self.env.config(Some(&typed))?;
                Some(Stored { host: config.host, port: config.port, user: config.user })
            }
            Err(e) => {
                form.check = Check::Idle;
                form.error = Some(e);
                None
            }
        }
    }

    fn stored_credential(&self) -> Credential {
        Credential::Stored { lookup: self.lookup, store: self.secrets.clone() }
    }

    /// The password to connect with: the one typed, unless the environment
    /// supplies one or the field is blank (then whatever is saved).
    fn connection_credential(&self) -> Credential {
        match &self.connection {
            Some(form) if !form.password.text.is_empty() && !self.env.password => {
                Credential::Given(form.password.text.clone())
            }
            _ => self.stored_credential(),
        }
    }

    pub fn test_connection(&mut self) {
        let Some(target) = self.connection_target() else { return };
        let credential = self.connection_credential();
        if let Some(form) = &mut self.connection {
            form.check = Check::Testing;
            form.error = None;
        }
        self.test_req
            .request((target.config(), credential), |(config, credential)| Dolt::new(config, credential).probe());
    }

    /// Save the form and connect. A typed password goes to the keychain
    /// first, on a worker (the Keychain can stop to ask the user); the
    /// settings file is written only once that succeeded, so a saved
    /// connection always has its password.
    pub fn save_connection(&mut self) {
        let Some(target) = self.connection_target() else { return };
        if self.connection.as_ref().is_some_and(|f| f.saving) {
            return;
        }
        match self.connection_credential() {
            Credential::Given(password) => {
                if let Some(form) = &mut self.connection {
                    form.saving = true;
                    form.error = None;
                }
                let secrets = self.secrets.clone();
                self.save_req.request((target, password), move |(target, password)| {
                    let stored = secrets.set(&settings::account(&target.config()), &password);
                    (target, stored)
                });
            }
            Credential::Stored { .. } => self.finish_save(target),
        }
    }

    fn finish_save(&mut self, target: Stored) {
        if target.save(&mut self.prefs).is_err() {
            if let Some(form) = &mut self.connection {
                form.saving = false;
                form.error = Some(FormError::File);
            }
            return;
        }
        self.close_connection();
        self.connect(target.config());
    }

    /// Point the window at a server and start over: nothing on screen
    /// belongs to the new one.
    fn connect(&mut self, config: Config) {
        self.source = Arc::new(Dolt::new(config, self.stored_credential()));
        self.issues_req.cancel();
        self.detail_req.cancel();
        self.projects = Load::Idle;
        self.project = None;
        self.issues = Load::Idle;
        self.visible.clear();
        self.table.clear_selection();
        self.issue = None;
        self.trail.clear();
        self.pane = Pane::List;
        self.detail = Load::Idle;
        self.stale = Stale::default();
        self.load_projects();
    }

    pub fn is_loading(&self) -> bool {
        self.projects_req.is_pending() || self.issues_req.is_pending() || self.detail_req.is_pending()
    }

    /// Land finished work. True when visible state changed.
    pub fn poll(&mut self, tx: &mut Tx) -> bool {
        let changed = self.land();
        // Answers land without animation, so the first second after launch stays still.
        if changed {
            tx.instant();
        }
        changed
    }

    fn land(&mut self) -> bool {
        let mut changed = false;
        if let Some(answer) = self.projects_req.take() {
            changed = true;
            match answer {
                Ok(projects) => {
                    let first = projects.first().map(|p| p.name.clone());
                    let current_gone = self.project.as_ref().is_some_and(|c| !projects.iter().any(|p| &p.name == c));
                    self.projects = Load::Ready(projects);
                    self.stale.projects = None;
                    if (self.project.is_none() || current_gone)
                        && let Some(first) = first
                    {
                        self.select_project(&first);
                    }
                }
                Err(f) if self.projects.ready().is_some() => self.stale.projects = Some(f),
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
                    self.stale.issues = None;
                    self.resort();
                    self.refilter();
                }
                Err(f) if self.issues.ready().is_some() => self.stale.issues = Some(f),
                Err(f) => self.issues = Load::Failed(f),
            }
        }
        if let Some((db, id, answer)) = self.detail_req.take()
            && self.project.as_deref() == Some(db.as_str())
            && self.issue.as_deref() == Some(id.as_str())
        {
            changed = true;
            match answer {
                Ok(d) => {
                    self.detail = Load::Ready(d);
                    self.stale.detail = None;
                }
                Err(f) if self.detail.ready().is_some() => self.stale.detail = Some(f),
                Err(f) => self.detail = Load::Failed(f),
            }
        }
        if let Some(answer) = self.test_req.take()
            && let Some(form) = &mut self.connection
            && form.check == Check::Testing
        {
            changed = true;
            form.check = match answer {
                Ok(projects) => Check::Ok(projects),
                Err(f) => Check::Failed(f),
            };
        }
        if let Some((target, stored)) = self.save_req.take()
            && self.connection.as_ref().is_some_and(|f| f.saving)
        {
            changed = true;
            match stored {
                Ok(()) => self.finish_save(target),
                Err(StoreError) => {
                    if let Some(form) = &mut self.connection {
                        form.saving = false;
                        form.error = Some(FormError::Keychain);
                    }
                }
            }
        }
        changed
    }

    /// Recompute `visible` from the search text and status filter.
    pub fn refilter(&mut self) {
        let query = self.search.text.trim().to_lowercase();
        let filter = STATUS_FILTERS.get(self.status_filter).map_or(Filter::All, |(_, f)| *f);
        let Some(issues) = self.issues.ready() else {
            self.visible.clear();
            return;
        };
        self.visible = issues
            .iter()
            .enumerate()
            .filter(|(_, i)| filter.admits(i))
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

    pub fn clear_filters(&mut self) {
        self.search.replace_text("");
        self.status_filter = 0;
        self.refilter();
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
                "blockers" => a.blocker_count.cmp(&b.blocker_count),
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
    use crate::settings::MemoryStore;

    fn loaded() -> State {
        let mut s = State::new(Arc::new(Sample), Backing::detached());
        s.projects = Load::Ready(Sample.projects().unwrap());
        s.project = Some("lighthouse".into());
        s.issues = Load::Ready(Sample.issues("lighthouse").unwrap());
        s.refilter();
        s
    }

    fn backing(env: Env, secrets: Arc<dyn SecretStore>) -> Backing {
        Backing { env, secrets, ..Backing::detached() }
    }

    fn type_into(s: &mut State, host: &str, port: &str, user: &str, password: &str) {
        let form = s.connection.as_mut().expect("the form is open");
        form.host.replace_text(host);
        form.port.replace_text(port);
        form.user.replace_text(user);
        form.password.replace_text(password);
        s.connection_edited();
    }

    /// Wait for a worker's answer, as the UI's `poll` would.
    fn settle(s: &mut State) {
        for _ in 0..500 {
            if s.land() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("no answer landed");
    }

    #[test]
    fn a_first_launch_opens_the_connection_form_and_a_configured_one_does_not() {
        let s = State::launch(Backing::detached());
        let form = s.connection.as_ref().expect("nothing is configured");
        assert_eq!((form.host.text.as_str(), form.port.text.as_str(), form.saved), ("", "3306", false));
        assert!(form.password.is_secure());
        assert_eq!(s.source.label(), "Not configured");

        let mut b = Backing::detached();
        Stored { host: "db.example".into(), port: 13306, user: "reader".into() }.save(&mut b.prefs).unwrap();
        let mut s = State::launch(b);
        assert!(s.connection.is_none());
        assert_eq!(s.source.label(), "Dolt db.example:13306");
        s.open_connection();
        let form = s.connection.as_ref().unwrap();
        assert_eq!(
            (form.host.text.as_str(), form.port.text.as_str(), form.user.text.as_str()),
            ("db.example", "13306", "reader")
        );
        assert!(form.saved && form.password.text.is_empty(), "the saved password is never loaded into the form");

        let env = Env { host: Some("from-env".into()), ..Env::default() };
        let s = State::launch(backing(env, Arc::new(MemoryStore::default())));
        assert!(s.connection.is_none(), "the environment alone configures a launch");
    }

    #[test]
    // Tests that end by connecting name a closed loopback port, so the
    // read that follows a save is refused at once and nothing leaves the machine.
    fn saving_puts_the_password_in_the_keychain_and_the_rest_in_the_file() {
        let secrets = Arc::new(MemoryStore::default());
        let mut s = State::launch(backing(Env::default(), secrets.clone()));
        type_into(&mut s, " 127.0.0.1 ", "1", "reader", "s3cret");
        s.save_connection();
        assert!(s.connection.as_ref().unwrap().saving);
        settle(&mut s);
        assert!(s.connection.is_none(), "saved, so the form closed");
        assert_eq!(secrets.get("reader@127.0.0.1:1"), Ok(Some("s3cret".into())));
        let saved = Stored::load(&s.prefs).unwrap();
        assert_eq!((saved.host.as_str(), saved.port, saved.user.as_str()), ("127.0.0.1", 1, "reader"));
        assert_eq!(s.source.label(), "Dolt 127.0.0.1:1");
        assert_eq!((&s.projects, &s.project), (&Load::Loading, &None), "the window starts over on the new server");
    }

    #[test]
    fn a_blank_password_keeps_the_saved_one_and_writes_no_secret() {
        let secrets = Arc::new(MemoryStore::default());
        secrets.set("reader@127.0.0.1:1", "kept").unwrap();
        let mut s = State::launch(backing(Env::default(), secrets.clone()));
        type_into(&mut s, "127.0.0.1", "1", "reader", "");
        s.save_connection();
        assert!(s.connection.is_none(), "nothing for the keychain, so the save is immediate");
        assert_eq!(secrets.get("reader@127.0.0.1:1"), Ok(Some("kept".into())));
        assert_eq!(Stored::load(&s.prefs).unwrap().port, 1);
    }

    #[test]
    fn a_bad_form_or_a_refused_password_saves_nothing() {
        let mut s = State::launch(Backing::detached());
        type_into(&mut s, "db.example", "70000", "reader", "pw");
        s.save_connection();
        assert_eq!(s.connection.as_ref().unwrap().error, Some(FormError::Port));
        s.test_connection();
        assert_eq!(s.connection.as_ref().unwrap().check, Check::Idle, "a bad form is not tested");

        // `Backing::detached` has no keychain, like a platform without one.
        type_into(&mut s, "db.example", "3306", "reader", "pw");
        assert_eq!(s.connection.as_ref().unwrap().error, None, "editing clears the error");
        s.save_connection();
        settle(&mut s);
        let form = s.connection.as_ref().expect("the form stays open");
        assert_eq!((form.error, form.saving), (Some(FormError::Keychain), false));
        assert_eq!(Stored::load(&s.prefs), None, "no connection is saved without its password");
        assert_eq!(s.source.label(), "Not configured");
    }

    #[test]
    fn a_test_reports_a_fixed_class_and_an_edit_discards_it() {
        // No password typed and none saved: the probe fails before any socket opens.
        let mut s = State::launch(backing(Env::default(), Arc::new(MemoryStore::default())));
        type_into(&mut s, "db.example", "3306", "reader", "");
        s.test_connection();
        assert_eq!(s.connection.as_ref().unwrap().check, Check::Testing);
        settle(&mut s);
        assert_eq!(s.connection.as_ref().unwrap().check, Check::Failed(Failure::CredentialUnavailable));
        s.connection.as_mut().unwrap().user.replace_text("other");
        s.connection_edited();
        assert_eq!(s.connection.as_ref().unwrap().check, Check::Idle);
        assert_eq!(Stored::load(&s.prefs), None, "testing saves nothing");
    }

    #[test]
    fn fields_the_environment_owns_win_over_the_form() {
        let env = Env { host: Some("from-env".into()), port: Some(3307), password: true, ..Env::default() };
        let secrets = Arc::new(MemoryStore::default());
        let mut s = State::launch(backing(env, secrets.clone()));
        s.open_connection();
        let form = s.connection.as_ref().unwrap();
        assert_eq!((form.host.text.as_str(), form.port.text.as_str()), ("from-env", "3307"));
        type_into(&mut s, "typed", "1", "reader", "typed-password");
        s.save_connection();
        assert!(s.connection.is_none(), "the environment supplies the password, so none is stored");
        assert_eq!(secrets.get("reader@from-env:3307"), Ok(None));
        assert_eq!(s.source.label(), "Dolt from-env:3307");
    }

    #[test]
    fn filters_combine_status_and_search() {
        let mut s = loaded();
        assert_eq!(s.visible.len(), 9);
        s.status_filter = 2; // Open
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
    fn the_ready_filter_keeps_open_issues_nothing_blocks() {
        let mut s = loaded();
        assert_eq!(STATUS_FILTERS[1], ("Ready", Filter::Ready));
        s.status_filter = 1;
        s.refilter();
        let mut ready = ids(&s);
        ready.sort();
        assert_eq!(ready, ["lh-2", "lh-3", "lh-5", "lh-7"]);
        // A subset of Open: lh-6 is open but waits on lh-2.
        s.status_filter = 2;
        s.refilter();
        assert!(ids(&s).contains(&"lh-6".to_string()) && ids(&s).len() == ready.len() + 1);
        // Ready combines with the text filter like any status.
        s.status_filter = 1;
        s.search.replace_text("gasket");
        s.refilter();
        assert_eq!(ids(&s), ["lh-5"]);
    }

    #[test]
    fn sorting_by_blockers_groups_the_blocked_issues() {
        let mut s = loaded();
        s.sort("blockers", SortDir::Descending);
        let mut blocked: Vec<_> = ids(&s)[..3].to_vec();
        blocked.sort();
        assert_eq!(blocked, ["lh-1", "lh-4", "lh-6"]);
        assert_eq!(s.visible_issue(3).unwrap().blocker_count, 0);
    }

    #[test]
    fn following_links_leaves_a_trail_to_walk_back_and_forward() {
        let mut s = loaded();
        s.select_issue("lh-1");
        s.follow_link("lh-4");
        s.follow_link("lh-5");
        assert_eq!(s.issue.as_deref(), Some("lh-5"));
        assert!(s.table.is_selected("lh-5"), "the list follows the pane");
        assert_eq!((s.trail.back.as_slice(), s.trail.forward.len()), (&["lh-1".to_string(), "lh-4".into()][..], 0));

        assert_eq!(s.go_back().as_deref(), Some("lh-4"));
        assert_eq!(s.go_back().as_deref(), Some("lh-1"));
        assert_eq!(s.go_back(), None, "the start of the trail");
        assert_eq!(s.issue.as_deref(), Some("lh-1"));
        assert_eq!(s.go_forward().as_deref(), Some("lh-4"));
        assert_eq!((s.trail.back.len(), s.trail.forward.len()), (1, 1));

        // A link followed from the middle drops what was forward.
        s.follow_link("lh-1");
        assert_eq!(s.go_forward(), None);
        assert_eq!(s.trail.back, ["lh-1", "lh-4"]);
        s.follow_link("lh-1");
        assert_eq!(s.trail.back.len(), 2, "a link to the issue on screen goes nowhere");

        // A refresh re-reads the same issue and keeps the trail.
        s.refresh();
        assert_eq!(s.trail.back.len(), 2);
        // Choosing in the list, clearing, or leaving the project ends it.
        s.select_issue("lh-2");
        assert!(s.trail.is_empty());
        s.follow_link("lh-6");
        s.move_selection(Step::Next);
        assert!(s.trail.is_empty());
        s.select_issue("lh-6");
        s.follow_link("lh-2");
        s.clear_selection();
        assert!(s.trail.is_empty());
        s.select_issue("lh-6");
        s.follow_link("lh-2");
        s.select_project("pantry");
        assert!(s.trail.is_empty());
    }

    #[test]
    fn a_link_can_be_followed_out_of_the_filtered_rows_and_back() {
        let mut s = loaded();
        s.status_filter = 1; // Ready
        s.refilter();
        s.select_issue("lh-3");
        s.follow_link("lh-9"); // closed, so not among the ready rows
        assert_eq!((s.issue.as_deref(), s.selected_row()), (Some("lh-9"), None));
        assert_eq!(s.detail, Load::Loading);
        assert_eq!(s.go_back().as_deref(), Some("lh-3"));
        assert!(s.selected_row().is_some());
    }

    #[test]
    fn sorting_by_priority_puts_p0_first() {
        let mut s = loaded();
        s.sort("priority", SortDir::Ascending);
        assert_eq!(s.visible_issue(0).unwrap().id, "lh-2");
    }

    /// The sample data behind a switch: while `down` holds a failure, every
    /// read fails with it.
    struct Flaky {
        down: std::sync::Mutex<Option<Failure>>,
    }

    impl Flaky {
        fn new(down: Option<Failure>) -> Arc<Flaky> {
            Arc::new(Flaky { down: std::sync::Mutex::new(down) })
        }
        fn set(&self, down: Option<Failure>) {
            *self.down.lock().unwrap() = down;
        }
        fn check(&self) -> Result<(), Failure> {
            self.down.lock().unwrap().map_or(Ok(()), Err)
        }
    }

    impl Source for Flaky {
        fn projects(&self) -> Result<Vec<Project>, Failure> {
            self.check().and_then(|()| Sample.projects())
        }
        fn issues(&self, database: &str) -> Result<Vec<IssueSummary>, Failure> {
            self.check().and_then(|()| Sample.issues(database))
        }
        fn issue(&self, database: &str, id: &str) -> Result<Option<IssueDetail>, Failure> {
            self.check().and_then(|()| Sample.issue(database, id))
        }
        fn label(&self) -> String {
            "Flaky".into()
        }
    }

    /// Land answers until no request is pending.
    fn drain(s: &mut State) {
        for _ in 0..500 {
            s.land();
            if !s.is_loading() {
                s.land();
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("requests never finished");
    }

    #[test]
    fn a_first_read_that_fails_shows_the_failure_and_a_retry_recovers() {
        let source = Flaky::new(Some(Failure::Unreachable));
        let mut s = State::new(source.clone(), Backing::detached());
        s.load_projects();
        assert_eq!(s.projects, Load::Loading);
        drain(&mut s);
        assert_eq!(s.projects, Load::Failed(Failure::Unreachable));
        assert_eq!(s.stale, Stale::default(), "nothing was on screen, so nothing is stale");

        source.set(None);
        s.refresh();
        assert_eq!(s.projects, Load::Loading, "a retry is shown as pending, not as the old failure");
        drain(&mut s);
        assert!(s.projects.ready().is_some());
        assert!(s.issues.ready().is_some_and(|i| !i.is_empty()), "the first project's issues follow");
    }

    #[test]
    fn a_failed_refresh_keeps_what_was_on_screen_and_marks_it_stale() {
        let source = Flaky::new(None);
        let mut s = State::new(source.clone(), Backing::detached());
        s.load_projects();
        drain(&mut s);
        let first = s.visible_issue(0).unwrap().id.clone();
        s.select_issue(&first);
        drain(&mut s);
        let before = (s.projects.clone(), s.issues.clone(), s.detail.clone(), s.visible.clone());
        assert!(matches!(before.2, Load::Ready(Some(_))));

        source.set(Some(Failure::Unreachable));
        s.refresh();
        assert_eq!((&s.projects, &s.issues, &s.detail), (&before.0, &before.1, &before.2), "no pane blanks");
        drain(&mut s);
        assert_eq!((&s.projects, &s.issues, &s.detail, &s.visible), (&before.0, &before.1, &before.2, &before.3));
        let all = Some(Failure::Unreachable);
        assert_eq!(s.stale, Stale { projects: all, issues: all, detail: all });
        assert_eq!(s.stale.failure(), all);
        assert_eq!(s.issue.as_deref(), Some(first.as_str()), "the selection survives");

        // The next failure replaces the reason; the next success clears it.
        source.set(Some(Failure::AuthenticationRejected));
        s.refresh();
        drain(&mut s);
        assert_eq!(s.stale.failure(), Some(Failure::AuthenticationRejected));
        source.set(None);
        s.refresh();
        drain(&mut s);
        assert_eq!(s.stale, Stale::default());
        assert_eq!((&s.projects, &s.detail), (&before.0, &before.2));
    }

    #[test]
    fn stale_marks_do_not_follow_the_view_to_other_data() {
        let source = Flaky::new(None);
        let mut s = State::new(source.clone(), Backing::detached());
        s.load_projects();
        drain(&mut s);
        s.select_issue("lh-1");
        drain(&mut s);
        source.set(Some(Failure::Unknown));
        s.refresh();
        drain(&mut s);

        // Another issue has no earlier answer to keep: it fails in its pane.
        s.select_issue("lh-2");
        assert_eq!((s.stale.detail, &s.detail), (None, &Load::Loading));
        drain(&mut s);
        assert_eq!(s.detail, Load::Failed(Failure::Unknown));
        // So does another project, and its failure is not a stale mark.
        s.select_project("pantry");
        assert_eq!((s.stale.issues, &s.issues), (None, &Load::Loading));
        drain(&mut s);
        assert_eq!(s.issues, Load::Failed(Failure::Unknown));
        assert_eq!(s.stale.failure(), Some(Failure::Unknown), "the project list is still the old one");

        source.set(None);
        s.refresh();
        assert_eq!(s.issues, Load::Loading, "retrying a failed pane shows it loading");
        drain(&mut s);
        assert!(s.issues.ready().is_some());
        assert_eq!(s.stale, Stale::default());
    }

    #[test]
    fn clearing_filters_restores_every_issue() {
        let mut s = loaded();
        s.status_filter = 5; // Closed
        s.search.replace_text("no such issue");
        s.refilter();
        assert!(s.visible.is_empty());
        s.clear_filters();
        assert_eq!((s.visible.len(), s.status_filter, s.search.text.as_str()), (9, 0, ""));
    }

    fn ids(s: &State) -> Vec<String> {
        (0..s.visible.len()).map(|r| s.visible_issue(r).unwrap().id.clone()).collect()
    }

    #[test]
    fn the_selection_moves_through_the_rows_and_stops_at_the_ends() {
        let mut s = loaded();
        let all = ids(&s);
        assert_eq!(s.move_selection(Step::Next), Some(all[0].clone()), "nothing selected: start at the top");
        assert_eq!(s.move_selection(Step::Next), Some(all[1].clone()));
        assert!(s.table.is_selected(&all[1]), "the table shows the same selection");
        assert_eq!(s.move_selection(Step::Previous), Some(all[0].clone()));
        assert_eq!(s.move_selection(Step::Previous), Some(all[0].clone()), "no wrap at the top");
        assert_eq!(s.move_selection(Step::Last), all.last().cloned());
        assert_eq!(s.move_selection(Step::Next), all.last().cloned(), "no wrap at the bottom");
        assert_eq!(s.move_selection(Step::First), Some(all[0].clone()));

        s.clear_selection();
        assert_eq!((s.issue.as_deref(), s.selected_row(), &s.detail), (None, None, &Load::Idle));
        assert_eq!(
            s.move_selection(Step::Previous),
            all.last().cloned(),
            "nothing selected: Previous starts at the end"
        );
    }

    #[test]
    fn the_selection_moves_over_the_rows_as_filtered_and_sorted() {
        let mut s = loaded();
        s.sort("priority", SortDir::Ascending);
        let sorted = ids(&s);
        s.move_selection(Step::Next);
        s.move_selection(Step::Next);
        assert_eq!(s.issue, Some(sorted[1].clone()), "rows are walked in the sorted order");

        // A re-sort keeps the issue, not the row number.
        s.sort("priority", SortDir::Descending);
        let row = s.selected_row().expect("still visible");
        assert_eq!(ids(&s)[row], sorted[1]);
        let after = ids(&s)[(row + 1).min(sorted.len() - 1)].clone();
        assert_eq!(s.move_selection(Step::Next), Some(after));

        // Filtered: only matching rows are stops.
        s.status_filter = 2; // Open
        s.refilter();
        let open = ids(&s);
        assert!(open.len() > 1 && open.len() < sorted.len());
        s.move_selection(Step::First);
        let mut walked = vec![s.issue.clone().unwrap()];
        for _ in 1..open.len() {
            walked.push(s.move_selection(Step::Next).unwrap());
        }
        assert_eq!(walked, open);

        // The selected issue filtered out: the next move starts from an end.
        s.search.replace_text("gasket");
        s.refilter();
        assert_eq!(ids(&s), ["lh-5"]);
        s.select_issue("lh-1");
        assert_eq!(s.selected_row(), None);
        assert_eq!(s.move_selection(Step::Next).as_deref(), Some("lh-5"));

        s.search.replace_text("no such issue");
        s.refilter();
        assert_eq!(s.move_selection(Step::Next), None, "no rows, no move");
        assert_eq!(s.issue.as_deref(), Some("lh-5"), "and the selection stays");
    }

    #[test]
    fn the_detail_pane_takes_the_keyboard_only_with_an_issue_and_hands_it_back() {
        let mut s = loaded();
        assert!(!s.open_detail(), "nothing to read");
        assert_eq!(s.pane, Pane::List);
        s.move_selection(Step::Next);
        assert!(s.open_detail());
        assert_eq!(s.pane, Pane::Detail);
        s.move_selection(Step::Next);
        assert_eq!(s.pane, Pane::List, "moving the selection is a list action");
        s.open_detail();
        s.select_project("pantry");
        assert_eq!(s.pane, Pane::List, "another project has no issue open");
    }

    #[test]
    fn projects_switch_by_position_and_the_sort_steps_through_the_columns() {
        let mut s = loaded();
        let second = s.projects.ready().unwrap()[1].name.clone();
        assert!(s.select_project_at(1));
        assert_eq!(s.project, Some(second));
        assert!(!s.select_project_at(99));

        let mut s = loaded();
        assert!(!s.sort_reverse(), "nothing is sorted yet");
        for column in SORT_CYCLE {
            s.sort_next();
            assert_eq!(s.table.sort(), Some((column, SortDir::Ascending)));
        }
        s.sort_next();
        assert_eq!(s.table.sort(), Some((SORT_CYCLE[0], SortDir::Ascending)), "the cycle wraps");
        assert!(s.sort_reverse());
        assert_eq!(s.table.sort(), Some((SORT_CYCLE[0], SortDir::Descending)));
        assert!(!s.has_filters());
        s.status_filter = 2;
        assert!(s.has_filters());
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

/// Against a real server and a scratch settings file, with the environment's
/// password typed into the form and an in-memory keychain:
/// `BEADS_DOLT_SERVER_HOST=… BEADS_DOLT_PASSWORD=… cargo test -- --ignored relaunch`.
#[cfg(test)]
mod live {
    use super::*;
    use crate::settings::MemoryStore;

    fn settle(s: &mut State, done: impl Fn(&State) -> bool) {
        for _ in 0..1500 {
            s.land();
            if done(s) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("the server did not answer");
    }

    #[test]
    #[ignore = "needs a Dolt server"]
    fn a_saved_connection_is_tested_saved_and_used_on_relaunch() {
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k}"));
        let (host, password) = (var("BEADS_DOLT_SERVER_HOST"), var("BEADS_DOLT_PASSWORD"));
        let port = std::env::var("BEADS_DOLT_SERVER_PORT").unwrap_or_default();
        let user = std::env::var("BEADS_DOLT_SERVER_USER").unwrap_or_default();
        let file =
            std::env::temp_dir().join(format!("beadsmith-desktop-live-{}", std::process::id())).join("prefs.json");
        let secrets = Arc::new(MemoryStore::default());
        // No environment reaches the app: only the file and the keychain.
        let backing =
            || Backing { prefs: rune::prefs::Prefs::at(&file), secrets: secrets.clone(), ..Backing::detached() };

        let mut first = State::launch(backing());
        let type_in = |s: &mut State, password: &str| {
            let form = s.connection.as_mut().expect("first launch opens the form");
            form.host.replace_text(host.as_str());
            form.port.replace_text(port.as_str());
            form.user.replace_text(user.as_str());
            form.password.replace_text(password);
            s.connection_edited();
        };
        type_in(&mut first, "not the password");
        first.test_connection();
        settle(&mut first, |s| s.connection.as_ref().is_some_and(|f| f.check != Check::Testing));
        assert_eq!(first.connection.as_ref().unwrap().check, Check::Failed(Failure::AuthenticationRejected));

        type_in(&mut first, &password);
        first.test_connection();
        settle(&mut first, |s| s.connection.as_ref().is_some_and(|f| f.check != Check::Testing));
        assert!(matches!(first.connection.as_ref().unwrap().check, Check::Ok(n) if n > 0));
        first.save_connection();
        settle(&mut first, |s| s.projects.ready().is_some());
        assert!(first.connection.is_none());

        let text = std::fs::read_to_string(&file).unwrap();
        assert!(!text.contains(&password), "the settings file holds no password");

        let mut second = State::launch(backing());
        assert!(second.connection.is_none(), "the next launch is configured");
        second.load_projects();
        settle(&mut second, |s| s.projects != Load::Loading);
        assert!(second.projects.ready().is_some_and(|p| !p.is_empty()), "{:?}", second.projects);
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }
}
