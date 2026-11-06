//! Beadsmith desktop: a prototype native client on Rune
//! (<https://github.com/anomalyco/rune>). It reads Beads projects straight
//! from the Dolt server, with the web app's read-only contract. See
//! `desktop/README.md` and `specs/decisions/0016-native-desktop-prototype.md`.
//!
//! `cargo run` opens the window. `cargo run -- --sample` uses built-in data.
//! Headless: `cargo run -- --snap out.png --scene sample`.

mod app;
mod dolt;
mod model;
mod sample;
mod view;

use std::sync::Arc;

use rune::{AppSpec, KeyEvent, Tx};

use app::{Load, State};
use model::{Failure, Source, Unconfigured};
use sample::Sample;

/// The data source for this launch: `--sample`, else the Dolt server the
/// environment names, else none.
fn source() -> Arc<dyn Source> {
    if rune::tooling::extra_args().iter().any(|a| a == "--sample") {
        return Arc::new(Sample);
    }
    match dolt::Config::from_env() {
        Some(config) => Arc::new(dolt::Dolt::new(config)),
        None => Arc::new(Unconfigured),
    }
}

fn init() -> State {
    State::new(source())
}

/// Scenes fill state synchronously, so a headless `--snap` shows content on
/// its first frame without a server.
fn sample_scene(s: &mut State) {
    s.source = Arc::new(Sample);
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

fn unconfigured_scene(s: &mut State) {
    s.source = Arc::new(Unconfigured);
    s.projects = Load::Failed(Failure::NotConfigured);
}

fn unreachable_scene(s: &mut State) {
    s.projects = Load::Failed(Failure::Unreachable);
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
        ],
        setup: Some(|s, waker| s.setup(waker)),
        poll: Some(|s, _, tx| s.poll(tx)),
        on_key: Some(on_key),
        ..AppSpec::new("Beadsmith", (1360.0, 820.0), init, view::view)
    });
}
