//! Beadsmith desktop: a prototype native client on Rune
//! (<https://github.com/anomalyco/rune>). It reads Beads projects straight
//! from the Dolt server, with the web app's read-only contract. See
//! `desktop/README.md` and `specs/decisions/0017-native-desktop-prototype.md`.
//!
//! `cargo run` opens the window. `cargo run -- --sample` uses built-in data.
//! Headless: `cargo run -- --snap out.png --scene sample`.

mod app;
mod dolt;
mod keys;
mod model;
mod quick;
mod sample;
mod settings;
mod theme;
mod view;

use std::sync::Arc;

use rune::{App, AppSpec, Chrome};

use app::{Check, Load, Pane, State};
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

/// The size to open at: the one the window was last closed at. Rune wants it
/// before it makes the state, so the settings file is read here once more
/// than `init` reads it. A headless run opens at the default, like the rest
/// of what it renders.
fn window_size() -> (f32, f32) {
    if rune::tooling::is_headless() {
        return settings::DEFAULT_WINDOW;
    }
    settings::load_window(&rune::prefs::Prefs::open(settings::APP_ID))
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
    s.updated = Some(0.0);
}

/// The window re-reading by itself: everything stays, and a bead beside the
/// list's age says a read is in flight.
fn refreshing_scene(s: &mut State) {
    sample_scene(s);
    s.background = true;
}

/// The refresh interval being chosen.
fn auto_refresh_scene(s: &mut State) {
    sample_scene(s);
    s.refresh_menu = true;
}

fn filtered_scene(s: &mut State) {
    sample_scene(s);
    s.search.replace_text("gasket");
    s.refilter();
}

/// The same issues as `sample`, by status: the board, with the selection
/// the table had.
fn board_scene(s: &mut State) {
    sample_scene(s);
    s.layout = app::Layout::Board;
}

/// A status tab leaves the one column it names, and a sort is said in words
/// beside the tabs.
fn board_ready_scene(s: &mut State) {
    ready_scene(s);
    s.layout = app::Layout::Board;
}

/// A text filter on the board: columns it empties keep their place.
fn board_filtered_scene(s: &mut State) {
    filtered_scene(s);
    s.layout = app::Layout::Board;
}

/// A project just chosen while the board is the layout.
fn board_loading_scene(s: &mut State) {
    loading_issues_scene(s);
    s.layout = app::Layout::Board;
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
    s.status_filter = 5; // Closed
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
    form.web.replace_text("https://beads.example");
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

/// The Ready tab: open issues nothing blocks, ordered as the web app's Ready
/// deck is (`listReadyIssues`: priority, then the most recently updated).
fn ready_scene(s: &mut State) {
    sample_scene(s);
    s.status_filter = 1; // Ready
    s.sort("updated", rune_kit::SortDir::Descending);
    s.sort("priority", rune_kit::SortDir::Ascending);
    s.issue = Some("lh-2".into());
    s.table.select("lh-2");
    s.detail = Load::Ready(Sample.issue("lighthouse", "lh-2").ok().flatten());
}

/// Sorted by the widest fixed heading: the column grows by the arrow's room,
/// so the whole heading still shows at the minimum window.
fn sorted_scene(s: &mut State) {
    sample_scene(s);
    s.sort("blockers", rune_kit::SortDir::Descending);
}

/// Two dependency links followed from `lh-1` and one step back: the trail
/// bar offers both directions.
fn trail_scene(s: &mut State) {
    sample_scene(s);
    s.trail.back = vec!["lh-1".into()];
    s.trail.forward = vec!["lh-5".into()];
    s.issue = Some("lh-4".into());
    s.table.select("lh-4");
    s.detail = Load::Ready(Sample.issue("lighthouse", "lh-4").ok().flatten());
    s.pane = Pane::Detail;
}

/// Every way the pane groups links: `lh-6` is blocked by one issue, was
/// discovered from another and is related to a third.
fn dependencies_scene(s: &mut State) {
    sample_scene(s);
    s.issue = Some("lh-6".into());
    s.table.select("lh-6");
    s.detail = Load::Ready(Sample.issue("lighthouse", "lh-6").ok().flatten());
}

/// A link to an issue that is not in the project: its pane says so, and the
/// trail is the way back.
fn trail_gone_scene(s: &mut State) {
    s.projects = Load::Ready(Sample.projects().unwrap_or_default());
    s.project = Some("pantry".into());
    s.issues = Load::Ready(Sample.issues("pantry").unwrap_or_default());
    s.refilter();
    s.trail.back = vec!["pa-3".into()];
    s.issue = Some("pa-7".into());
    s.table.select("pa-7");
    s.detail = Load::Ready(None);
}

/// Enter on an issue: plain keys now scroll it, and the pane wears the ring.
fn reading_scene(s: &mut State) {
    sample_scene(s);
    s.pane = Pane::Detail;
}

/// The web app's address is saved, so the issue offers its link beside its
/// id, and a Markdown link has just been copied (`y`, `⇧Y`, `⇧O`).
fn issue_link_scene(s: &mut State) {
    sample_scene(s);
    s.web = Some("https://beads.example".into());
    let link = s.issue_markdown().unwrap_or_default();
    s.notify(true, "Copied a Markdown link", Some(link));
}

/// `⇧Y` with no web address saved: the notice says where to add one.
fn issue_no_link_scene(s: &mut State) {
    sample_scene(s);
    s.notify(false, "No link to the web app", Some(app::NoLink::NoWebAddress.message().into()));
}

/// The theme chosen in the window, whatever the system's: the title bar's
/// word names the choice. One scene per choice, so each is drawn under both
/// system themes.
fn theme_light_scene(s: &mut State) {
    sample_scene(s);
    s.appearance = theme::Appearance::Light;
}

fn theme_dark_scene(s: &mut State) {
    sample_scene(s);
    s.appearance = theme::Appearance::Dark;
}

/// The list of keys, as `?` opens it.
fn shortcuts_scene(s: &mut State) {
    sample_scene(s);
    s.shortcuts = true;
}

/// Quick open as Cmd-K shows it: nothing typed, so it lists the projects.
fn quick_open_scene(s: &mut State) {
    sample_scene(s);
    s.open_quick();
}

/// Quick open with `query` typed and the sample server's answer landed.
fn quick_typed(s: &mut State, query: &str) {
    quick_open_scene(s);
    s.quick_field().replace_text(query);
    let databases: Vec<String> = Sample.projects().unwrap_or_default().into_iter().map(|p| p.name).collect();
    s.quick_found(Sample.search(&databases, &quick::needle(query)));
}

/// An id from another project than the one on screen: it leads the list.
fn quick_open_id_scene(s: &mut State) {
    quick_typed(s, "pa-2");
}

/// A loose query: a project and issues from both projects, more than the
/// list shows at once, with the highlight moved off the first row.
fn quick_open_results_scene(s: &mut State) {
    quick_typed(s, "a");
    s.quick_move(2);
}

fn quick_open_none_scene(s: &mut State) {
    quick_typed(s, "zeppelin");
}

/// The server stopped answering: the projects still match, and the footer
/// says the issues are missing.
fn quick_open_failed_scene(s: &mut State) {
    quick_open_scene(s);
    s.quick_field().replace_text("pan");
    s.quick_found(Err(Failure::Unreachable));
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
        min_size: Some(settings::MIN_WINDOW),
        scenes: &[
            ("sample", sample_scene),
            ("filtered", filtered_scene),
            ("sorted", sorted_scene),
            ("board", board_scene),
            ("board-ready", board_ready_scene),
            ("board-filtered", board_filtered_scene),
            ("board-loading", board_loading_scene),
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
            ("refreshing", refreshing_scene),
            ("auto-refresh", auto_refresh_scene),
            ("issues-failed", issues_failed_scene),
            ("issue-failed", issue_failed_scene),
            ("issue-gone", issue_gone_scene),
            ("connection", connection_scene),
            ("connection-testing", connection_testing_scene),
            ("connection-failed", connection_failed_scene),
            ("connection-ok", connection_ok_scene),
            ("connection-invalid", connection_invalid_scene),
            ("ready", ready_scene),
            ("trail", trail_scene),
            ("dependencies", dependencies_scene),
            ("trail-gone", trail_gone_scene),
            ("reading", reading_scene),
            ("issue-link", issue_link_scene),
            ("issue-no-link", issue_no_link_scene),
            ("theme-light", theme_light_scene),
            ("theme-dark", theme_dark_scene),
            ("shortcuts", shortcuts_scene),
            ("quick-open", quick_open_scene),
            ("quick-open-id", quick_open_id_scene),
            ("quick-open-results", quick_open_results_scene),
            ("quick-open-none", quick_open_none_scene),
            ("quick-open-failed", quick_open_failed_scene),
        ],
        setup: Some(|s, waker| s.setup(waker)),
        poll: Some(|s, clock, tx| s.poll(clock, tx)),
        on_key: Some(keys::on_key),
        families: theme::FAMILIES,
        ..AppSpec::new("Beadsmith", window_size(), init, view::view)
    };
    let mut app = App::new(spec)
        .chrome(chrome())
        .on_focus(|s, focused, tx| s.window_focus(focused, tx))
        .on_close(|s, _| s.remember_window());
    // Rune has native menus on macOS only; elsewhere the keys alone answer.
    if cfg!(target_os = "macos") || rune::tooling::is_headless() {
        // Edit and Window menus, so Cmd-W, Cmd-M and the editing keys are the system's.
        app = app.standard_menus();
        for item in keys::menu() {
            app = app.menu_item(item);
        }
    }
    app.run();
}
