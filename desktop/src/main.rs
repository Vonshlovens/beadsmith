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
mod view;

use std::sync::Arc;

use rune::{AppSpec, KeyEvent, Tx};

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

fn main() {
    rune::prewarm_gpu();
    rune::tooling::set_app_id("beadsmith-desktop");
    rune::run(AppSpec::<State> {
        min_size: Some((1100.0, 560.0)),
        scenes: &[
            ("sample", sample_scene),
            ("filtered", filtered_scene),
            ("unconfigured", unconfigured_scene),
            ("unreachable", unreachable_scene),
            ("connection", connection_scene),
            ("connection-testing", connection_testing_scene),
            ("connection-failed", connection_failed_scene),
            ("connection-ok", connection_ok_scene),
            ("connection-invalid", connection_invalid_scene),
        ],
        setup: Some(|s, waker| s.setup(waker)),
        poll: Some(|s, _, tx| s.poll(tx)),
        on_key: Some(on_key),
        ..AppSpec::new("Beadsmith", (1360.0, 820.0), init, view::view)
    });
}
