//! Beadsmith desktop: a prototype native client on Rune
//! (<https://github.com/anomalyco/rune>). It reads Beads projects straight
//! from the Dolt server, with the web app's read-only contract. See
//! `desktop/README.md` and `specs/decisions/0017-native-desktop-prototype.md`.
//!
//! `cargo run` opens the window. `cargo run -- --sample` uses built-in data.
//! Headless: `cargo run -- --snap out.png --scene sample`.

mod app;
mod dolt;
mod model;
mod sample;
mod settings;
mod theme;
mod view;

use std::sync::Arc;

use rune::{App, AppSpec, Chrome, KeyEvent, Tx};

use app::{Check, Load, State};
use dolt::{Config, Credential, Dolt};
use model::{Failure, Source};
use sample::Sample;
use settings::{Backing, FormError};

/// A window reads the machine's settings and keychain. A headless run (a
/// snapshot, a tree, a listing) reads neither, so what it renders depends on
/// the scene alone, and it starts on the sample data.
fn init() -> State {
    if rune::tooling::is_headless() {
        return State::new(Arc::new(Sample), Backing::detached());
    }
    if rune::tooling::extra_args().iter().any(|a| a == "--sample") {
        return State::new(Arc::new(Sample), Backing::system());
    }
    State::launch(Backing::system())
}

/// Scenes fill state synchronously, so a headless `--snap` shows content on
/// its first frame without a server.
fn sample_scene(s: &mut State) {
    s.projects = Load::Ready(Sample.projects().unwrap_or_default());
    s.project = Some("lighthouse".into());
    s.issues = Load::Ready(Sample.issues("lighthouse").unwrap_or_default());
    s.refilter();
    s.issue = Some("lh-1".into());
    s.table.select("lh-1");
    s.detail = Load::Ready(Sample.issue("lighthouse", "lh-1").ok().flatten());
}

fn filtered_scene(s: &mut State) {
    sample_scene(s);
    s.search.replace_text("gasket");
    s.refilter();
}

/// A server that is never contacted: scenes set the outcome themselves.
fn example_server() -> Arc<dyn Source> {
    let config = Config { host: "dolt.example".into(), port: 3306, user: "reader".into() };
    Arc::new(Dolt::new(config, Credential::Given(String::new())))
}

fn unconfigured_scene(s: &mut State) {
    s.source = Arc::new(model::Unconfigured);
    s.projects = Load::Failed(Failure::NotConfigured);
}

fn unreachable_scene(s: &mut State) {
    s.source = example_server();
    s.projects = Load::Failed(Failure::Unreachable);
}

/// A read that failed before anything was on screen, one scene per class
/// with its own recovery (see `view::failure_actions`).
fn auth_rejected_scene(s: &mut State) {
    s.source = example_server();
    s.projects = Load::Failed(Failure::AuthenticationRejected);
}

fn credential_unavailable_scene(s: &mut State) {
    s.source = example_server();
    s.projects = Load::Failed(Failure::CredentialUnavailable);
}

/// Launch, before the server has answered.
fn loading_scene(s: &mut State) {
    s.source = example_server();
    s.projects = Load::Loading;
}

/// A project just chosen: its issues are on their way.
fn loading_issues_scene(s: &mut State) {
    s.projects = Load::Ready(Sample.projects().unwrap_or_default());
    s.project = Some("pantry".into());
    s.issues = Load::Loading;
}

/// An issue just chosen: the list is there, its body is on its way.
fn loading_issue_scene(s: &mut State) {
    sample_scene(s);
    s.issue = Some("lh-2".into());
    s.table.select("lh-2");
    s.detail = Load::Loading;
}

/// A server with no Beads databases.
fn no_projects_scene(s: &mut State) {
    s.source = example_server();
    s.projects = Load::Ready(Vec::new());
}

/// A project nothing has been filed in yet. The sample data has none, so
/// the scene adds one to the list.
fn empty_project_scene(s: &mut State) {
    let mut projects = Sample.projects().unwrap_or_default();
    projects.push(model::Project {
        name: "orchard".into(),
        counts: Some(model::Counts::default()),
        last_activity: None,
    });
    s.projects = Load::Ready(projects);
    s.project = Some("orchard".into());
    s.issues = Load::Ready(Vec::new());
    s.refilter();
}

/// Filters that hide every issue.
fn no_matches_scene(s: &mut State) {
    sample_scene(s);
    s.status_filter = 4; // Closed
    s.search.replace_text("gasket");
    s.refilter();
}

/// A refresh that failed after a good load: everything stays, under a banner.
fn stale_scene(s: &mut State) {
    sample_scene(s);
    s.source = example_server();
    s.stale.projects = Some(Failure::Unreachable);
}

/// One project's issues failed while the project list loaded.
fn issues_failed_scene(s: &mut State) {
    s.projects = Load::Ready(Sample.projects().unwrap_or_default());
    s.project = Some("pantry".into());
    s.issues = Load::Failed(Failure::Unknown);
}

/// One issue failed to load, and another has left the server.
fn issue_failed_scene(s: &mut State) {
    loading_issue_scene(s);
    s.detail = Load::Failed(Failure::Unreachable);
}

fn issue_gone_scene(s: &mut State) {
    loading_issue_scene(s);
    s.detail = Load::Ready(None);
}

/// The connection screen as a first launch shows it.
fn connection_scene(s: &mut State) {
    unconfigured_scene(s);
    s.open_connection();
}

/// The form filled in, over the unreachable server it is being pointed away from.
fn connection_filled(s: &mut State) {
    unreachable_scene(s);
    s.open_connection();
    let Some(form) = &mut s.connection else { return };
    form.host.replace_text("dolt.example");
    form.user.replace_text("reader");
    form.password.replace_text("not a real password");
}

fn connection_testing_scene(s: &mut State) {
    connection_filled(s);
    s.connection.as_mut().expect("opened").check = Check::Testing;
}

fn connection_failed_scene(s: &mut State) {
    connection_filled(s);
    s.connection.as_mut().expect("opened").check = Check::Failed(Failure::AuthenticationRejected);
}

fn connection_ok_scene(s: &mut State) {
    connection_filled(s);
    s.connection.as_mut().expect("opened").check = Check::Ok(3);
}

fn connection_invalid_scene(s: &mut State) {
    connection_filled(s);
    let form = s.connection.as_mut().expect("opened");
    form.port.replace_text("70000");
    form.error = Some(FormError::Port);
}

fn on_key(s: &mut State, key: &KeyEvent, _: &mut Tx) -> bool {
    if key.is_command('r') {
        s.refresh();
        return true;
    }
    false
}

/// The window frame on macOS: the content runs under a transparent title
/// bar, so the app's own bar (`view::title_bar`) is the title bar. The window
/// buttons are centred in it, and only that bar drags the window, which
/// leaves everything below it clickable.
fn chrome() -> Chrome {
    const INSET: f32 = 16.0;
    Chrome {
        full_size_content: true,
        traffic_lights: Some((INSET, (view::TITLE_BAR_H - Chrome::TRAFFIC_LIGHT) / 2.0)),
        drag_regions: true,
    }
}

fn main() {
    rune::prewarm_gpu();
    rune::tooling::set_app_id("beadsmith-desktop");
    let spec = AppSpec::<State> {
        min_size: Some((1100.0, 560.0)),
        scenes: &[
            ("sample", sample_scene),
            ("filtered", filtered_scene),
            ("unconfigured", unconfigured_scene),
            ("unreachable", unreachable_scene),
            ("auth-rejected", auth_rejected_scene),
            ("credential-unavailable", credential_unavailable_scene),
            ("loading", loading_scene),
            ("loading-issues", loading_issues_scene),
            ("loading-issue", loading_issue_scene),
            ("no-projects", no_projects_scene),
            ("empty-project", empty_project_scene),
            ("no-matches", no_matches_scene),
            ("stale", stale_scene),
            ("issues-failed", issues_failed_scene),
            ("issue-failed", issue_failed_scene),
            ("issue-gone", issue_gone_scene),
            ("connection", connection_scene),
            ("connection-testing", connection_testing_scene),
            ("connection-failed", connection_failed_scene),
            ("connection-ok", connection_ok_scene),
            ("connection-invalid", connection_invalid_scene),
        ],
        setup: Some(|s, waker| s.setup(waker)),
        poll: Some(|s, _, tx| s.poll(tx)),
        on_key: Some(on_key),
        families: theme::FAMILIES,
        ..AppSpec::new("Beadsmith", (1440.0, 880.0), init, view::view)
    };
    App::new(spec).chrome(chrome()).run();
}
