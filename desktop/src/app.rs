//! App state and the requests that fill it. Every read runs on Rune's
//! `Latest` workers; answers land in `poll` on the UI thread, and a newer
//! request supersedes an older one (switching projects quickly never shows a
//! stale list).
//!
//! The window also re-reads by itself (`State::tick`): on an interval and
//! when it regains focus. Those reads go through the same requests and the
//! same landing code as a refresh asked for by hand, so there is one way for
//! new data to reach the screen, and it keeps the selection, the sort and the
//! filters because they are held by issue id and column, not by row.

use std::sync::Arc;

use rune::{Latest, TextEdit, Tx, Waker};
use rune_kit::{SortDir, TableState};

use crate::dolt::{Config, Credential, Dolt};
use crate::model::{Failure, IssueDetail, IssueSummary, Project, Source, Unconfigured};
use crate::settings::{self, Backing, Env, FormError, Lookup, SecretStore, Session, StoreError, Stored};
use crate::theme::Appearance;

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

/// A window that comes back to the front re-reads if its data is at least
/// this old (seconds), whatever the interval: the moment someone returns to
/// the app is when they look at it, and macOS may have held its timers back
/// while it was hidden. Short enough to feel immediate, long enough that
/// flicking between windows does not send a read per switch.
const FOCUS_REFRESH_AFTER: f64 = 5.0;

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
/// The sortable columns the table shows only in a wide window. With the
/// cycle, every column a remembered sort may name.
const WIDE_SORT: [&str; 2] = ["type", "assignee"];

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
    /// The theme preference; the view resolves it against the system's.
    pub appearance: Appearance,
    /// The window's content size in points, as the view's layout last
    /// reported it, for `remember_window`. `None` in full screen, whose size
    /// is the display's and not one to reopen a window at.
    pub window: Option<(f32, f32)>,
    /// The project the last session ended on, until the first project list
    /// lands and it is chosen (or found gone).
    last_project: Option<String>,
    pub table: TableState,
    pub issue: Option<String>,
    pub trail: Trail,
    pub detail: Load<Option<IssueDetail>>,
    pub stale: Stale,
    pub pane: Pane,
    /// The keyboard shortcuts overlay is open.
    pub shortcuts: bool,
    /// Seconds between the window's own refreshes, one of
    /// `settings::REFRESH_CHOICES`; 0 is never.
    pub auto_refresh: u32,
    /// The toolbar's list of those choices is open.
    pub refresh_menu: bool,
    /// The reads in flight were started by the window, not asked for: the
    /// view marks them with a quiet bead instead of a busy Refresh button.
    pub background: bool,
    /// When the list on screen arrived, on the app clock (`now`).
    pub updated: Option<f64>,
    /// The app clock at the latest `tick`: seconds since the first frame.
    now: f64,
    /// When a refresh was last started, by hand or not. The interval counts
    /// from here, so a refresh asked for by hand postpones the next one.
    asked: f64,
    /// The window came to the front since the last `tick`.
    focus_gained: bool,
    /// The age the view last drew in "Updated … ago", so a `tick` redraws
    /// only when the words change.
    age_drawn: Option<u64>,
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
        // The view the last session ended on. A name this version does not
        // have (a tab or column since renamed, a hand-edited file) is
        // dropped, and that one choice starts from its default.
        let session = Session::load(&backing.prefs);
        let status_filter =
            session.status.and_then(|name| STATUS_FILTERS.iter().position(|(label, _)| *label == name)).unwrap_or(0);
        // The key the view's table is built under, so the table's own
        // reveal and `keys` scroll the same element.
        let mut table = TableState::new().key(TABLE_KEY);
        if let Some((column, descending)) = session.sort
            && (SORT_CYCLE.contains(&column.as_str()) || WIDE_SORT.contains(&column.as_str()))
        {
            table.set_sort(&column, if descending { SortDir::Descending } else { SortDir::Ascending });
        }
        State {
            source,
            projects: Load::Idle,
            project: None,
            issues: Load::Idle,
            visible: Vec::new(),
            search: TextEdit::new(""),
            status_filter,
            appearance: Appearance::from_name(session.theme.as_deref()),
            window: None,
            last_project: session.project,
            table,
            issue: None,
            trail: Trail::default(),
            detail: Load::Idle,
            stale: Stale::default(),
            pane: Pane::List,
            shortcuts: false,
            auto_refresh: settings::load_refresh(&backing.prefs),
            refresh_menu: false,
            background: false,
            updated: None,
            now: 0.0,
            asked: 0.0,
            focus_gained: false,
            age_drawn: None,
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
        self.request_projects();
    }

    // The requests alone, with no change to what is on screen: what a
    // refresh by hand and the window's own refresh share.

    fn request_projects(&mut self) {
        let source = self.source.clone();
        self.projects_req.request((), move |()| source.projects());
    }

    fn request_issues(&mut self, db: &str) {
        let source = self.source.clone();
        self.issues_req.request(db.to_string(), move |db| {
            let answer = source.issues(&db);
            (db, answer)
        });
    }

    fn request_detail(&mut self, db: String, id: &str) {
        let source = self.source.clone();
        self.detail_req.request((db, id.to_string()), move |(db, id)| {
            let answer = source.issue(&db, &id);
            (db, id, answer)
        });
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
            self.updated = None;
            self.background = false;
            self.remember();
        } else if self.issues.ready().is_none() {
            // A retry after a failed first read: show it as pending again.
            self.issues = Load::Loading;
        }
        self.request_issues(name);
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
            self.background = false;
        } else if self.detail.ready().is_none() {
            self.detail = Load::Loading;
        }
        if !self.table.is_selected(id) {
            self.table.select(id.to_string());
        }
        self.request_detail(db, id);
    }

    // -- Keyboard ------------------------------------------------------------------------------
    // What the keys in `keys.rs` do to the state. Scrolling and focus are the
    // caller's, since they need Rune's `Tx`.

    /// A dialog owns the keyboard: no window shortcut may act under it.
    pub fn modal_open(&self) -> bool {
        self.connection.is_some() || self.shortcuts || self.refresh_menu
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
        self.asked = self.now;
        self.background = false;
        self.load_projects();
        if let Some(p) = self.project.clone() {
            self.select_project(&p);
        }
        if let Some(i) = self.issue.clone() {
            self.select_issue(&i);
        }
    }

    // -- The window's own refresh --------------------------------------------------------------

    /// Re-read everything on screen without being asked. Unlike `refresh`
    /// it changes nothing until answers land: no pane goes back to loading,
    /// not even one showing a failure, so a server that stays down does not
    /// make the window flash once a minute.
    fn refresh_quietly(&mut self) {
        self.asked = self.now;
        self.background = true;
        self.request_projects();
        let Some(db) = self.project.clone() else { return };
        self.request_issues(&db);
        if let Some(id) = self.issue.clone() {
            self.request_detail(db, &id);
        }
    }

    /// Whether the window may read by itself now. Not under a dialog, which
    /// should not have the window change behind it. Not while a read is in
    /// flight: `Latest` drops a superseded request, so on a server slower
    /// than the interval every read would be replaced before it answered.
    /// And not after a failure only the user can cure: retrying a rejected
    /// password every minute can lock the account, and a missing one would
    /// have the Keychain ask again and again.
    fn may_refresh(&self) -> bool {
        let transient = |f: Failure| matches!(f, Failure::Unreachable | Failure::Unknown);
        let worth_asking = match &self.projects {
            Load::Ready(_) => self.stale.failure().is_none_or(transient),
            Load::Failed(f) => transient(*f),
            Load::Idle | Load::Loading => false,
        };
        self.auto_refresh > 0 && worth_asking && !self.modal_open() && !self.is_loading()
    }

    /// One turn of the UI loop at `clock` (seconds since the first frame):
    /// land finished reads, start the window's own refresh when one is due,
    /// and notice when "Updated … ago" needs new words. True when the view
    /// must be rebuilt.
    pub fn tick(&mut self, clock: f64) -> bool {
        self.now = clock;
        let mut changed = self.land();
        let wait = match std::mem::take(&mut self.focus_gained) {
            true => FOCUS_REFRESH_AFTER.min(f64::from(self.auto_refresh)),
            false => f64::from(self.auto_refresh),
        };
        if self.may_refresh() && self.now - self.asked >= wait {
            self.refresh_quietly();
            changed = true;
        }
        let age = self.age().map(|(n, _)| n);
        if age != self.age_drawn {
            self.age_drawn = age;
            changed = true;
        }
        changed
    }

    /// Seconds until `tick` has something to do with no answer landing: the
    /// next refresh, or the next change of "Updated … ago".
    fn next_tick(&self) -> Option<f64> {
        let refresh = self.may_refresh().then(|| self.asked + f64::from(self.auto_refresh) - self.now);
        let words = self.updated.map(|at| {
            let (age, unit) = (self.now - at, if self.now - at < 3600.0 { 60.0 } else { 3600.0 });
            unit - age % unit
        });
        // Never sooner than a moment, so rounding at a boundary cannot spin the loop.
        [refresh, words].into_iter().flatten().reduce(f64::min).map(|wait| wait.max(0.05))
    }

    /// The window gained or lost focus (`App::on_focus`). Coming back is
    /// handled by the next `tick`, which has the clock.
    pub fn window_focus(&mut self, focused: bool, tx: &mut Tx) {
        if focused {
            self.focus_gained = true;
            tx.wake_after(std::time::Duration::ZERO);
        }
    }

    /// How old the list on screen is: a number and whether it counts hours
    /// (else minutes). `None` before a list has arrived.
    fn age(&self) -> Option<(u64, bool)> {
        let age = (self.now - self.updated?).max(0.0);
        Some(if age < 3600.0 { ((age / 60.0) as u64, false) } else { ((age / 3600.0) as u64, true) })
    }

    /// "Updated 3 min ago": when the list on screen arrived. An age, not a
    /// time of day, because it answers the question the reader has (can I
    /// trust this list?) without arithmetic, and needs no time zone.
    pub fn updated_label(&self) -> Option<String> {
        Some(match self.age()? {
            (0, false) => "Updated just now".to_string(),
            (n, false) => format!("Updated {n} min ago"),
            (n, true) => format!("Updated {n} h ago"),
        })
    }

    /// The label of the refresh interval in effect.
    pub fn auto_refresh_label(&self) -> Option<&'static str> {
        settings::REFRESH_CHOICES.iter().find(|(_, secs)| *secs == self.auto_refresh).map(|(label, _)| *label)
    }

    /// Choose a refresh interval by its label in `settings::REFRESH_CHOICES`
    /// and remember it. `asked` is left alone: turning refresh on over an
    /// old list reads at once.
    pub fn choose_auto_refresh(&mut self, label: &str) {
        self.refresh_menu = false;
        let Some((_, secs)) = settings::REFRESH_CHOICES.iter().find(|(l, _)| *l == label) else { return };
        self.auto_refresh = *secs;
        // A settings file that cannot be written costs only the memory of
        // this choice; it holds for the run, and there is nothing to retry.
        let _ = settings::save_refresh(&mut self.prefs, *secs);
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
        self.updated = None;
        self.background = false;
        self.asked = self.now;
        self.load_projects();
    }

    pub fn is_loading(&self) -> bool {
        self.projects_req.is_pending() || self.issues_req.is_pending() || self.detail_req.is_pending()
    }

    /// `AppSpec::poll`: one `tick`, then ask to be woken for the next one.
    /// Rune keeps no timer thread for this; the wake only schedules a frame.
    pub fn poll(&mut self, clock: f64, tx: &mut Tx) -> bool {
        let changed = self.tick(clock);
        // Answers land without animation, so the first second after launch stays still.
        if changed {
            tx.instant();
        }
        if let Some(wait) = self.next_tick() {
            tx.wake_after(std::time::Duration::from_secs_f64(wait));
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
                    // The project the last session ended on, when this
                    // server still has it; else the first.
                    let last = self.last_project.take().filter(|l| projects.iter().any(|p| &p.name == l));
                    let current_gone = self.project.as_ref().is_some_and(|c| !projects.iter().any(|p| &p.name == c));
                    // A server with no projects has no list to date but this one.
                    if projects.is_empty() {
                        self.updated = Some(self.now);
                    }
                    self.projects = Load::Ready(projects);
                    self.stale.projects = None;
                    if (self.project.is_none() || current_gone)
                        && let Some(open) = last.or(first)
                    {
                        self.select_project(&open);
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
                    // The selection, sort and filters are kept by issue id
                    // and column, so the new rows fall under them as they are.
                    self.issues = Load::Ready(issues);
                    self.updated = Some(self.now);
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
        if changed && !self.is_loading() {
            self.background = false;
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
        self.set_status_filter(0);
    }

    /// Choose a status tab by its place in `STATUS_FILTERS`.
    pub fn set_status_filter(&mut self, index: usize) {
        self.status_filter = index;
        self.refilter();
        self.remember();
    }

    pub fn sort(&mut self, column: &str, dir: SortDir) {
        self.table.set_sort(column, dir);
        self.resort();
        self.refilter();
        self.remember();
    }

    /// Step the theme preference: system, light, dark, and round again.
    pub fn cycle_appearance(&mut self) {
        self.appearance = self.appearance.next();
        self.remember();
    }

    /// Save the view for the next launch (`settings::Session`), at each
    /// change rather than at quit, so a crash or a forced quit loses nothing.
    /// A settings file that cannot be written costs only this memory; the
    /// choice holds for the run, and there is nothing to retry.
    fn remember(&mut self) {
        let session = Session {
            // Before the first project list lands, the project to keep is
            // still the one the last session ended on.
            project: self.project.clone().or_else(|| self.last_project.clone()),
            status: STATUS_FILTERS
                .get(self.status_filter)
                .filter(|_| self.status_filter != 0)
                .map(|(label, _)| (*label).to_string()),
            sort: self.table.sort().map(|(column, dir)| (column.to_string(), dir == SortDir::Descending)),
            theme: (self.appearance != Appearance::System).then(|| self.appearance.name().to_string()),
        };
        let _ = session.save(&mut self.prefs);
    }

    /// `App::on_close`: keep the size the window closes at. Its position is
    /// not kept: Rune can place a window but not say where one is.
    pub fn remember_window(&mut self) {
        if let Some(size) = self.window {
            let _ = settings::save_window(&mut self.prefs, size);
        }
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

    /// Land answers until no request is pending and none is left to take.
    /// Pending is read before landing: once nothing is pending every answer
    /// is there to take, and a landing that takes one may have started
    /// another read (the first project's issues), so it goes round again.
    fn drain(s: &mut State) {
        for _ in 0..500 {
            if !s.is_loading() && !s.land() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("requests never finished");
    }

    /// A settings file of this test's own, and a launch that reads it.
    fn session_file(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("beadsmith-desktop-app-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("prefs.json")
    }

    fn launch_from(file: &std::path::Path) -> State {
        let mut s =
            State::new(Arc::new(Sample), Backing { prefs: rune::prefs::Prefs::at(file), ..Backing::detached() });
        s.load_projects();
        drain(&mut s);
        s
    }

    #[test]
    fn a_relaunch_opens_on_the_view_the_last_one_ended_on() {
        let file = session_file("relaunch");
        let mut s = launch_from(&file);
        assert_eq!(s.project.as_deref(), Some("lighthouse"), "nothing remembered: the first project");
        assert_eq!((s.status_filter, s.table.sort(), s.appearance), (0, None, Appearance::System));

        s.select_project("pantry");
        drain(&mut s);
        s.set_status_filter(2); // Open
        s.sort("priority", SortDir::Descending);
        s.cycle_appearance();
        s.search.replace_text("jar");
        s.refilter();
        s.window = Some((1280.0, 800.0));
        s.remember_window();
        drop(s);

        let s = launch_from(&file);
        assert_eq!(s.project.as_deref(), Some("pantry"));
        assert_eq!(s.status_filter, 2);
        assert_eq!(s.table.sort(), Some(("priority", SortDir::Descending)));
        assert_eq!(s.appearance, Appearance::Light);
        assert_eq!(s.search.text, "", "the filter text is not kept");
        assert_eq!(settings::load_window(&s.prefs), (1280.0, 800.0));
        let shown: Vec<i64> = (0..s.visible.len()).map(|row| s.visible_issue(row).unwrap().priority).collect();
        assert!(!shown.is_empty() && shown.is_sorted_by(|a, b| a >= b), "the rows land under the remembered sort");
        assert!((0..s.visible.len()).all(|row| s.visible_issue(row).unwrap().status == "open"));
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn choices_put_back_to_their_defaults_are_forgotten() {
        let file = session_file("defaults");
        let mut s = launch_from(&file);
        s.set_status_filter(4);
        s.cycle_appearance();
        s.clear_filters();
        s.cycle_appearance();
        s.cycle_appearance();
        drop(s);
        let s = launch_from(&file);
        assert_eq!((s.status_filter, s.appearance), (0, Appearance::System));
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn a_corrupt_or_outdated_session_opens_on_the_defaults() {
        let file = session_file("fallback");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        for saved in [
            "{ not json",
            r#"{"view.project":"gone","view.status":"Triaged","view.sort":"colour","ui.theme":"sepia","window.size":"big"}"#,
            r#"{"view.project":3,"view.status":["Open"],"view.sort":true,"view.sort_descending":"yes","ui.theme":1}"#,
        ] {
            std::fs::write(&file, saved).unwrap();
            let s = launch_from(&file);
            assert_eq!(s.project.as_deref(), Some("lighthouse"), "{saved}");
            assert_eq!((s.status_filter, s.table.sort(), s.appearance), (0, None, Appearance::System), "{saved}");
            assert_eq!(settings::load_window(&s.prefs), settings::DEFAULT_WINDOW, "{saved}");
            assert_eq!(s.visible.len(), Sample.issues("lighthouse").unwrap().len(), "{saved}");
        }
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn a_choice_made_before_the_projects_land_keeps_the_remembered_project() {
        let mut b = Backing::detached();
        Session { project: Some("pantry".into()), ..Session::default() }.save(&mut b.prefs).unwrap();
        let mut s = State::new(Arc::new(Sample), b);
        s.set_status_filter(1);
        assert_eq!(Session::load(&s.prefs).project.as_deref(), Some("pantry"));
        s.load_projects();
        drain(&mut s);
        assert_eq!(s.project.as_deref(), Some("pantry"));
        // Full screen reports no size, so the last windowed one is kept.
        s.window = Some((1300.0, 700.0));
        s.remember_window();
        s.window = None;
        s.remember_window();
        assert_eq!(settings::load_window(&s.prefs), (1300.0, 700.0));
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

    /// The sample server with a lighthouse project whose issues change
    /// between reads, as other people's work changes a real one.
    struct Shifting {
        lighthouse: std::sync::Mutex<Vec<IssueSummary>>,
    }

    impl Source for Shifting {
        fn projects(&self) -> Result<Vec<Project>, Failure> {
            Sample.projects()
        }
        fn issues(&self, database: &str) -> Result<Vec<IssueSummary>, Failure> {
            if database == "lighthouse" { Ok(self.lighthouse.lock().unwrap().clone()) } else { Sample.issues(database) }
        }
        fn issue(&self, database: &str, id: &str) -> Result<Option<IssueDetail>, Failure> {
            Sample.issue(database, id)
        }
        fn label(&self) -> String {
            "Shifting".into()
        }
    }

    #[test]
    fn the_windows_own_refresh_merges_new_rows_under_the_same_view() {
        let source = Arc::new(Shifting { lighthouse: std::sync::Mutex::new(Sample.issues("lighthouse").unwrap()) });
        let mut s = State::new(source.clone(), Backing::detached());
        s.load_projects();
        drain(&mut s);
        s.sort("priority", SortDir::Descending);
        s.status_filter = 2; // Open
        s.search.replace_text("lh-");
        s.refilter();
        let (gone, kept) = (ids(&s)[0].clone(), ids(&s)[1].clone());
        s.select_issue(&kept);
        drain(&mut s);
        assert!(s.open_detail());
        s.trail.back.push("lh-1".into());
        let before = (s.issues.clone(), s.detail.clone(), s.visible.clone(), s.trail.clone());

        // Meanwhile, on the server: the selected issue is renamed, the row
        // above it is deleted, a new one is filed, and the order changes.
        {
            let mut issues = source.lighthouse.lock().unwrap();
            issues.retain(|i| i.id != gone);
            let mut filed = issues.iter().find(|i| i.id == kept).unwrap().clone();
            filed.id = "lh-99".into();
            filed.priority = 0;
            issues.push(filed);
            issues.iter_mut().find(|i| i.id == kept).unwrap().title = "Renamed".into();
            issues.reverse();
        }

        s.tick(0.0);
        assert!(!s.tick(59.0) && s.asked == 0.0, "not before the interval");
        assert!(s.tick(60.0) && s.asked == 60.0 && s.background);
        assert_eq!((&s.issues, &s.detail, &s.visible), (&before.0, &before.1, &before.2), "nothing blanks meanwhile");
        drain(&mut s);

        assert_eq!(s.issue.as_deref(), Some(kept.as_str()), "the selection is the same issue");
        assert!(s.table.is_selected(&kept));
        let row = s.selected_row().expect("still among the rows");
        assert_eq!(s.visible_issue(row).unwrap().title, "Renamed", "with its new content");
        assert!(matches!(s.detail, Load::Ready(Some(_))));
        assert_eq!((s.pane, &s.trail), (Pane::Detail, &before.3), "reading it, the way back intact");
        assert_eq!((s.status_filter, s.search.text.as_str()), (2, "lh-"), "the filters hold");
        assert_eq!(s.table.sort(), Some(("priority", SortDir::Descending)), "and the sort");
        let rows = ids(&s);
        assert!(rows.contains(&"lh-99".to_string()) && !rows.contains(&gone), "{rows:?}");
        let priorities: Vec<_> = (0..rows.len()).map(|r| s.visible_issue(r).unwrap().priority).collect();
        assert!(priorities.windows(2).all(|p| p[0] >= p[1]), "new rows are sorted in: {priorities:?}");
        assert!((0..rows.len()).all(|r| s.visible_issue(r).unwrap().status == "open"));
        assert_eq!((s.updated, s.background, s.stale), (Some(60.0), false, Stale::default()));
    }

    #[test]
    fn the_window_refreshes_on_its_interval_and_when_it_comes_back() {
        let mut s = State::new(Arc::new(Sample), Backing::detached());
        assert_eq!(s.auto_refresh, settings::DEFAULT_REFRESH);
        s.load_projects();
        drain(&mut s);
        s.tick(0.0);
        s.tick(59.9);
        assert_eq!(s.asked, 0.0);
        s.tick(60.0);
        assert!(s.asked == 60.0 && s.background);
        drain(&mut s);
        assert!(!s.background);

        // A refresh by hand is not a background one, and postpones the next.
        s.tick(100.0);
        s.refresh();
        assert!(s.asked == 100.0 && !s.background);
        drain(&mut s);
        s.tick(159.0);
        assert_eq!(s.asked, 100.0);
        s.tick(160.0);
        assert_eq!(s.asked, 160.0);
        drain(&mut s);

        // Never behind a dialog; as soon as it closes.
        s.shortcuts = true;
        s.tick(300.0);
        assert_eq!(s.asked, 160.0);
        s.shortcuts = false;
        s.tick(300.0);
        assert_eq!(s.asked, 300.0);
        drain(&mut s);

        // Off is off, for the interval and for coming back to the window.
        s.refresh_menu = true;
        s.choose_auto_refresh("Auto off");
        assert_eq!((s.auto_refresh, s.refresh_menu, s.auto_refresh_label()), (0, false, Some("Auto off")));
        s.focus_gained = true;
        s.tick(10_000.0);
        assert!(
            s.asked == 300.0 && s.next_tick().is_some_and(|wait| wait > 60.0),
            "only the age label asks for a wake"
        );

        // Turned on over an old list, it reads at once.
        s.choose_auto_refresh("Auto 5 min");
        s.tick(10_000.0);
        assert_eq!(s.asked, 10_000.0);
        drain(&mut s);
        // Coming back to the window re-reads sooner than the interval, but
        // not on every flick between windows.
        s.focus_gained = true;
        s.tick(10_004.0);
        assert!(s.asked == 10_000.0 && !s.focus_gained);
        s.tick(10_005.0);
        assert_eq!(s.asked, 10_000.0, "focus is an event, not a state");
        s.focus_gained = true;
        s.tick(10_005.0);
        assert!(s.asked == 10_005.0 && s.background);
        drain(&mut s);

        assert_eq!(settings::load_refresh(&s.prefs), 300, "the choice is in the settings file");
        s.choose_auto_refresh("no such choice");
        assert_eq!(s.auto_refresh, 300);
    }

    #[test]
    fn the_windows_own_refresh_retries_quietly_and_leaves_the_users_failures_alone() {
        let source = Flaky::new(Some(Failure::Unreachable));
        let mut s = State::new(source.clone(), Backing::detached());
        s.load_projects();
        drain(&mut s);
        s.tick(60.0);
        assert_eq!(s.asked, 60.0, "an unreachable server is asked again");
        assert_eq!(s.projects, Load::Failed(Failure::Unreachable), "without the pane going back to loading");
        drain(&mut s);
        assert_eq!(s.projects, Load::Failed(Failure::Unreachable));

        source.set(None);
        s.tick(120.0);
        drain(&mut s);
        assert!(s.projects.ready().is_some() && s.issues.ready().is_some(), "and the window fills when it answers");
        assert_eq!(s.updated, Some(120.0));

        // Over loaded data a failed read is the stale banner, and the age
        // keeps counting from the last good list.
        source.set(Some(Failure::Unreachable));
        s.tick(180.0);
        drain(&mut s);
        assert_eq!((s.stale.failure(), s.updated), (Some(Failure::Unreachable), Some(120.0)));
        assert_eq!(s.updated_label().as_deref(), Some("Updated 1 min ago"));
        source.set(Some(Failure::AuthenticationRejected));
        s.tick(240.0);
        assert_eq!(s.asked, 240.0);
        drain(&mut s);
        assert_eq!(s.stale.failure(), Some(Failure::AuthenticationRejected));

        // A rejected password is not sent again until the user asks.
        s.tick(300.0);
        s.focus_gained = true;
        s.tick(360.0);
        assert!(s.asked == 240.0 && !s.may_refresh());
        source.set(None);
        s.refresh();
        drain(&mut s);
        assert_eq!(s.stale, Stale::default());
        assert!(s.may_refresh());

        for (first, retried) in [(Failure::CredentialUnavailable, false), (Failure::Unknown, true)] {
            let mut s = State::new(Flaky::new(Some(first)), Backing::detached());
            s.load_projects();
            drain(&mut s);
            s.tick(60.0);
            assert_eq!(s.asked == 60.0, retried, "{first:?}");
            drain(&mut s);
        }
    }

    #[test]
    fn the_age_of_the_list_is_said_in_minutes_then_hours() {
        let mut s = loaded();
        s.auto_refresh = 0;
        assert_eq!((s.updated_label(), s.next_tick()), (None, None), "no list has arrived, and nothing to wake for");
        s.updated = Some(10.0);
        assert!(s.tick(10.0));
        assert_eq!(s.updated_label().as_deref(), Some("Updated just now"));
        assert!(!s.tick(40.0), "the same words: no redraw");
        assert!(s.next_tick().is_some_and(|wait| (wait - 30.0).abs() < 1e-6), "woken when the words change");
        assert!(s.tick(70.0));
        assert_eq!(s.updated_label().as_deref(), Some("Updated 1 min ago"));
        s.tick(10.0 + 3599.0);
        assert_eq!(s.updated_label().as_deref(), Some("Updated 59 min ago"));
        assert!(s.tick(10.0 + 3600.0));
        assert_eq!(s.updated_label().as_deref(), Some("Updated 1 h ago"));
        assert!(!s.tick(10.0 + 5000.0));
        assert!(s.tick(10.0 + 7200.0));
        assert_eq!(s.updated_label().as_deref(), Some("Updated 2 h ago"));

        // Another project's list has its own age.
        s.select_project("pantry");
        assert_eq!(s.updated_label(), None);
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
