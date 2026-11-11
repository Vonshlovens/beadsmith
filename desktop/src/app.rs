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

/// The status filter above the issue table.
pub const STATUS_FILTERS: [(&str, Option<&str>); 5] = [
    ("All", None),
    ("Open", Some("open")),
    ("In progress", Some("in_progress")),
    ("Blocked", Some("blocked")),
    ("Closed", Some("closed")),
];

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
    pub detail: Load<Option<IssueDetail>>,
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
            table: TableState::new(),
            issue: None,
            detail: Load::Idle,
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
        self.detail = Load::Idle;
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
