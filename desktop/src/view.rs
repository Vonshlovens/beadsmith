//! The window: a title bar, projects on the left, the issue table in the
//! middle, the selected issue on the right. Layout follows the web app's
//! project page (`src/routes/p/[id]/+page.svelte`) and its tokens
//! (`src/app.css`, restated in `theme.rs`), drawn with Rune's components.

use std::borrow::Cow;

use rune::TextEdit;
use rune::{Color, Cx, El, LoopSpec, ScrollSpec, Tx, col, el, row, text};
use rune_kit::{
    Button, ButtonVariant, Cell, Dialog, Field, Keybind, Kit, Markdown, Select, Table, TableColumn, TableStyle,
    TextInput,
};

use crate::app::{Check, Connection, Load, Pane, STATUS_FILTERS, State, TABLE_KEY};
use crate::keys::{self, Command};
use crate::model::{Failure, IssueDetail, IssueRef, Project};
use crate::settings::REFRESH_CHOICES;
use crate::theme::{StatusLook, Theme};

/// The web app's `--rail-w`.
const SIDEBAR_W: f32 = 216.0;
/// The title bar: tall enough to centre the macOS window buttons with room
/// to grab the bar around them.
pub const TITLE_BAR_H: f32 = 44.0;
/// At or above this window width the table shows every column and the detail
/// pane takes its full width. Below it the two columns the detail pane also
/// shows (type, assignee) leave the table, so the title keeps its room: the
/// design standards ask for identifying fields first at narrow widths.
const ROOMY_W: f32 = 1280.0;
/// The table's Blockers column, shared with its skeleton: the narrowest that
/// shows the whole heading, so titles keep what is left at the minimum window.
const BLOCKERS_W: f32 = 84.0;

pub fn view(s: &State, cx: &mut Cx<State>) -> El {
    let th = Theme::new(cx.system_dark());
    // Unknown until the first layout; the window opens wider than `ROOMY_W`.
    let roomy = cx.layout_size("shell").is_none_or(|size| size[0] >= ROOMY_W);
    let panes = row().key("panes").w_full().grow(1.0).min_h(0.0).child(sidebar(s, &th)).child(rule_v(&th));
    // With no project list there is no table or issue to frame, so the
    // reason takes the room of both panes instead of repeating in each.
    let mut layer = Vec::new();
    let panes = match server_state(s, &th) {
        Some(state) => panes.child(state),
        None => panes.child(main_pane(s, &th, roomy, &mut layer)).child(rule_v(&th)).child(detail_pane(s, &th, roomy)),
    };
    let mut body = col().key("shell").w_full().h_full().fill(th.t.bg).child(title_bar(&th, cx.titlebar_inset()));
    if let Some(failure) = s.stale.failure() {
        body = body.child(stale_banner(s, failure, &th));
    }
    let body = body.child(panes);
    if let Some(form) = &s.connection {
        connection_dialog(s, form, &th.k, &mut layer);
    } else if s.shortcuts {
        shortcuts_dialog(&th, &mut layer);
    }
    rune_kit::root(body, layer)
}

// ---------------------------------------------------------------------------------------------
// Title bar

/// The app's own title bar, under macOS's transparent one: the brand, and
/// the one standing fact about this client. `lights` is where the window
/// buttons end (0 when there are none: full screen, other platforms). The
/// whole bar drags the window.
fn title_bar(th: &Theme, lights: f32) -> El {
    let t = &th.t;
    let bar = row()
        .key("title-bar")
        .w_full()
        .h(TITLE_BAR_H)
        .pl(if lights > 0.0 { lights + 14.0 } else { 16.0 })
        .pr(16.0)
        .gap(10.0)
        .center_y()
        .window_drag()
        .child(brand_mark(th))
        .child(text("Beadsmith").font(th.ty.base_strong).color(t.tx_hi))
        .child(el().grow(1.0))
        // Said once, here, so no pane has to explain its missing actions.
        .child(text("Read-only").font(th.ty.xs).color(t.tx_dim));
    col().w_full().child(bar).child(el().w_full().h(2.0).fill(t.rule))
}

/// Three beads on a rod, the middle one lit: the beads of the Beadsmith mark
/// (`src/lib/components/brand-mark.svelte`) at a size where its hammer and
/// anvil would not read.
fn brand_mark(th: &Theme) -> El {
    let bead = |color: Color| el().size(7.0, 7.0).radius(3.5).fill(color);
    row()
        .key("brand-mark")
        .a11y_hidden()
        .gap(2.0)
        .center_y()
        .child(bead(th.t.tx_hi))
        .child(bead(th.t.em_500))
        .child(bead(th.t.tx_hi))
}

/// Shown when a refresh failed over data that is still on screen
/// (`State::stale`): the window keeps what it had and says it may be out of
/// date, with the way to recover. It sits above every pane because all of
/// them may be stale. `.banner-warn` in `src/app.css`.
fn stale_banner(s: &State, failure: Failure, th: &Theme) -> El {
    let (k, t) = (&th.k, &th.t);
    let words = col()
        .grow(1.0)
        .min_w(0.0)
        .child(text("Refresh failed. Showing the last loaded data.").font(th.ty.sm_strong).color(t.tx_hi).truncate())
        .child(text(failure.message()).font(th.ty.xs).color(t.tx_mid).wrap());
    let mut banner = row()
        .key("stale")
        .role("status")
        .label(format!("Refresh failed. Showing the last loaded data. {}", failure.message()))
        .w_full()
        .pl(20.0)
        .pr(16.0)
        .py(8.0)
        .gap(12.0)
        .center_y()
        .fill(t.s2)
        .child(el().size(7.0, 7.0).radius(3.5).fill(t.amber).a11y_hidden())
        .child(words);
    for action in failure_actions(failure, busy(s), k) {
        banner = banner.child(action);
    }
    col().w_full().child(banner).child(rule_h(th))
}

/// A read the user asked for is in flight. The window's own refreshes are
/// not counted: they must not turn buttons into "Refreshing" once a minute
/// (`freshness` marks them instead).
fn busy(s: &State) -> bool {
    s.is_loading() && !s.background
}

/// The buttons that recover from `failure`, the likelier fix first and
/// filled. An unreachable server is usually cured by waiting, so Retry
/// leads; a rejected or missing password by the settings, so they lead.
fn failure_actions(failure: Failure, busy: bool, k: &Kit) -> Vec<El> {
    let settings_first = !matches!(failure, Failure::Unreachable | Failure::Unknown);
    let lead = |first: bool| if first { ButtonVariant::Contrast } else { ButtonVariant::Neutral };
    let settings = Button::new("Connection settings")
        .variant(lead(settings_first))
        .on_press(|s: &mut State| s.open_connection())
        .build(k)
        .key("open-connection");
    if !failure.retryable() {
        return vec![settings];
    }
    let retry = Button::new(if busy { "Retrying" } else { "Retry" })
        .variant(if busy { ButtonVariant::Loading } else { lead(!settings_first) })
        .on_press(|s: &mut State| s.refresh())
        .build(k)
        .key("retry");
    if settings_first { vec![settings, retry] } else { vec![retry, settings] }
}

/// What fills the window beside the sidebar when the server gave no
/// projects to show: why it failed, or that it has none.
fn server_state(s: &State, th: &Theme) -> Option<El> {
    let state = match &s.projects {
        Load::Failed(f) => failure_state(*f, busy(s), th),
        Load::Ready(projects) if projects.is_empty() => {
            let refresh = Button::new(if busy(s) { "Refreshing" } else { "Refresh" })
                .variant(if busy(s) { ButtonVariant::Loading } else { ButtonVariant::Neutral })
                .on_press(|s: &mut State| s.refresh())
                .build(&th.k)
                .key("refresh");
            state(
                th,
                false,
                "No projects on this server",
                "Each Beads project is a database on the Dolt server. Create one with bd init, then refresh.",
                vec![refresh],
            )
        }
        _ => return None,
    };
    Some(col().key("main").grow(1.0).min_w(0.0).h_full().child(state))
}

// ---------------------------------------------------------------------------------------------
// Sidebar

fn sidebar(s: &State, th: &Theme) -> El {
    let (k, t) = (&th.k, &th.t);
    let count = s.projects.ready().map(|p| p.len().to_string()).unwrap_or_default();
    let header = row()
        .key("projects-heading")
        .px(20.0)
        .pt(16.0)
        .pb(8.0)
        .gap(8.0)
        .center_y()
        .child(text("PROJECTS").font(th.ty.caps).color(t.tx_hi))
        .child(text(count).font(th.ty.xs).color(t.tx_dim));

    let list = match &s.projects {
        Load::Ready(projects) if projects.is_empty() => note(th, "No projects."),
        Load::Ready(projects) => {
            let mut list = col().key("projects").px(12.0).gap(1.0);
            for p in projects {
                list = list.child(project_row(p, s.project.as_deref() == Some(p.name.as_str()), th));
            }
            list.scroll(ScrollSpec { stick_bottom: false }).grow(1.0).min_h(0.0)
        }
        // The pane beside this one says why and what to do.
        Load::Failed(_) => note(th, "Projects appear here once the server answers."),
        Load::Idle | Load::Loading => projects_skeleton(th),
    };

    // The server's name is the way into its settings: the one place the
    // window says what it is connected to.
    let server = row()
        .key("connection")
        .role("button")
        .label(format!("Connection settings: {}", s.source.label()))
        .focusable(true)
        .focus_ring(2.0, 1.0, t.em_400)
        .grow(1.0)
        .min_w(0.0)
        .px(8.0)
        .h(28.0)
        .gap(8.0)
        .center_y()
        .radius(k.radius.sm)
        .hover(k.c.hover)
        .on_press(|s: &mut State| s.open_connection())
        .child(el().size(7.0, 7.0).radius(3.5).fill(connection_color(s, th)))
        .child(text(s.source.label()).font(th.ty.xs).color(t.tx_mid).truncate().grow(1.0).min_w(0.0));
    // The one pointer route to the list of keys; `?` is the keyboard's.
    let shortcuts = row()
        .key("shortcuts")
        .role("button")
        .label("Keyboard shortcuts")
        .help("Keyboard shortcuts")
        .focusable(true)
        .focus_ring(2.0, 1.0, t.em_400)
        .size(28.0, 28.0)
        .center()
        .radius(k.radius.sm)
        .hover(k.c.hover)
        .on_press_tx(|s: &mut State, tx: &mut Tx| keys::perform(s, Command::Shortcuts, tx))
        .child(text("?").font(th.ty.sm).color(t.tx_mid).a11y_hidden());
    let footer = row().key("footer").px(12.0).py(8.0).gap(4.0).center_y().child(server).child(shortcuts);

    col()
        .key("sidebar")
        .w(SIDEBAR_W)
        .h_full()
        .child(header)
        .child(col().w_full().grow(1.0).min_h(0.0).child(list))
        .child(rule_h(th))
        .child(footer)
}

/// A project as the web app's nav shows one: a bead that lights when it is
/// the current project, the name, and how much work is active.
fn project_row(p: &Project, selected: bool, th: &Theme) -> El {
    let t = &th.t;
    let name = p.name.clone();
    let counts = p.counts.as_ref();
    // Unknown, not zero: the summary query for this project failed.
    let active = counts.map_or(String::from("—"), |c| c.active().to_string());
    let sub = match (counts, &p.last_activity) {
        (Some(c), Some(at)) => format!("{} blocked · {}", c.blocked, short_date(at.get(..10).unwrap_or(at))),
        (Some(c), None) => format!("{} blocked", c.blocked),
        _ => "Summary unavailable".into(),
    };
    let label = match counts {
        Some(c) => format!("{}, {} active, {} blocked", p.name, c.active(), c.blocked),
        None => p.name.clone(),
    };
    let (ink, face) = if selected { (t.tx_hi, th.ty.base_strong) } else { (t.tx_mid, th.ty.base) };
    row()
        .key(format!("project-{}", p.name))
        .role("button")
        .label(label)
        .focusable(true)
        .focus_ring(2.0, 1.0, t.em_400)
        .w_full()
        .px(8.0)
        .py(6.0)
        .gap(12.0)
        .radius(th.k.radius.sm)
        .fill(if selected { t.s3 } else { Color::TRANSPARENT })
        .hover(th.k.c.hover)
        .on_press(move |s: &mut State| s.select_project(&name))
        // The bead sits on the name's line, not the row's centre.
        .child(el().ml(4.0).mt(7.0).size(7.0, 7.0).radius(3.5).fill(if selected { t.em_500 } else { t.line_2 }))
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .center_y()
                        .child(text(p.name.clone()).font(face).color(ink).truncate().grow(1.0).min_w(0.0))
                        .child(text(active).font(th.ty.xs).color(t.tx_dim)),
                )
                .child(text(sub).font(th.ty.xs).color(t.tx_dim).truncate()),
        )
}

fn connection_color(s: &State, th: &Theme) -> Color {
    match s.projects {
        // Connected once, but the last refresh did not get through.
        Load::Ready(_) if s.stale.failure().is_some() => th.t.amber,
        Load::Ready(_) => th.t.mint,
        Load::Failed(_) => th.t.em_500,
        _ => th.t.tx_dim,
    }
}

// ---------------------------------------------------------------------------------------------
// Connection settings

/// The connection screen: a modal over the window, so a first launch sees it
/// before anything else and Escape returns to whatever was there.
fn connection_dialog(s: &State, form: &Connection, k: &Kit, layer: &mut Vec<El>) {
    let busy = form.saving;
    let input = |edit: &TextEdit, name: &str, pick: fn(&mut Connection) -> &mut TextEdit, owned: bool| {
        TextInput::new(edit)
            .label(name)
            .width(None)
            .disabled(owned || busy)
            .on_edit(move |s: &mut State| s.connection_field(pick))
            .on_change(|s: &mut State, _: &mut Tx| s.connection_edited())
            .on_submit(|s: &mut State, _: &mut Tx| s.save_connection())
    };
    let owned_by = |variable: &str, owned: bool| owned.then(|| format!("Set by {variable}."));
    let field = |label: &str, control: El, hint: Option<String>| {
        let f = Field::new().label(label).control(control);
        match hint {
            Some(hint) => f.suffix(hint).build(k),
            None => f.build(k),
        }
    };

    let host = input(&form.host, "Host", |f| &mut f.host, s.env.host.is_some())
        .placeholder("dolt.example or 127.0.0.1")
        .invalid(form.error == Some(crate::settings::FormError::Host))
        .build(k)
        .key("host");
    let port = input(&form.port, "Port", |f| &mut f.port, s.env.port.is_some())
        .placeholder("3306")
        .invalid(form.error == Some(crate::settings::FormError::Port))
        .build(k)
        .key("port");
    let user =
        input(&form.user, "User", |f| &mut f.user, s.env.user.is_some()).placeholder("root").build(k).key("user");
    let password = input(&form.password, "Password", |f| &mut f.password, s.env.password)
        .secure()
        .placeholder(if s.env.password {
            "Supplied by the environment"
        } else if form.saved {
            "Leave blank to keep the saved password"
        } else {
            ""
        })
        .build(k)
        .key("password");
    let password_hint = if s.env.password {
        "Set by BEADS_DOLT_PASSWORD_FILE or BEADS_DOLT_PASSWORD."
    } else if cfg!(target_os = "macos") {
        "Kept in the macOS Keychain, never in the settings file."
    } else {
        "This build cannot store a password. Set BEADS_DOLT_PASSWORD_FILE instead."
    };

    let fields = col()
        .key("fields")
        .w_full()
        .px(16.0)
        .gap(16.0)
        .child(
            row()
                .w_full()
                .gap(12.0)
                .items_start()
                .child(el().grow(1.0).min_w(0.0).child(field(
                    "Host",
                    host,
                    owned_by("BEADS_DOLT_SERVER_HOST", s.env.host.is_some()),
                )))
                .child(el().w(96.0).child(field(
                    "Port",
                    port,
                    owned_by("BEADS_DOLT_SERVER_PORT", s.env.port.is_some()),
                ))),
        )
        .child(field("User", user, owned_by("BEADS_DOLT_SERVER_USER", s.env.user.is_some())))
        .child(field("Password", password, Some(password_hint.into())));

    // In the body, not the dialog's description: the kit's header does not wrap.
    let about = text("Beadsmith reads one Dolt SQL server and never writes to it. Use a SELECT-only account.")
        .key("about")
        .font(k.ty.text_small)
        .color(k.c.text_muted)
        .wrap()
        .w_full()
        .px(16.0)
        .pb(16.0);

    let testing = form.check == Check::Testing;
    let test = Button::new(if testing { "Testing" } else { "Test connection" })
        .variant(if testing { ButtonVariant::Loading } else { ButtonVariant::Neutral })
        .disabled(busy)
        .on_press(|s: &mut State| s.test_connection())
        .build(k)
        .key("test");
    let cancel = Button::new("Cancel")
        .variant(ButtonVariant::Ghost)
        .on_press(|s: &mut State| s.close_connection())
        .build(k)
        .key("cancel");
    let save = Button::new(if busy { "Saving" } else { "Save" })
        .variant(if busy { ButtonVariant::Loading } else { ButtonVariant::Contrast })
        .on_press(|s: &mut State| s.save_connection())
        .build(k)
        .key("save");
    let actions = row()
        .key("actions")
        .w_full()
        .padding(16.0)
        .gap(8.0)
        .center_y()
        .child(test)
        .child(el().grow(1.0))
        .child(cancel)
        .child(save);

    Dialog::new("connection", "Connection")
        .width(460.0)
        .fit()
        .click_outside(false)
        .open(true)
        .on_close(|s: &mut State| s.close_connection())
        .child(about)
        .child(fields)
        .child(connection_status(form, k))
        .child(actions)
        .build(k, layer);
}

/// The keyboard shortcuts, as `?` shows them: `keys::SHORTCUTS` in two
/// columns so the list fits the smallest window without scrolling.
fn shortcuts_dialog(th: &Theme, layer: &mut Vec<El>) {
    let (k, t) = (&th.k, &th.t);
    let group = |(title, rows): &(&str, &[keys::Shortcut])| {
        let mut list =
            col().w_full().gap(6.0).child(text(title.to_uppercase()).font(th.ty.caps).color(t.tx_hi).mb(2.0));
        for (n, (caps, does)) in rows.iter().enumerate() {
            let caps: Vec<String> = caps.iter().map(|c| keys::key_label(c)).collect();
            list = list.child(
                row()
                    .key(format!("shortcut-{n}"))
                    .w_full()
                    .gap(12.0)
                    .items_start()
                    .child(row().w(104.0).min_h(18.0).center_y().child(Keybind::new(&caps).build(k)))
                    .child(text(*does).font(th.ty.sm).color(t.tx).wrap().grow(1.0).min_w(0.0)),
            );
        }
        list
    };
    let [issues, reading, everywhere] = keys::SHORTCUTS else { return };
    let half = |groups: Vec<El>| {
        let mut half = col().grow(1.0).min_w(0.0).gap(20.0);
        for g in groups {
            half = half.child(g);
        }
        half
    };
    let body = row()
        .key("shortcut-list")
        .w_full()
        .px(16.0)
        .pb(20.0)
        .gap(28.0)
        .items_start()
        .child(half(vec![group(issues), group(reading)]))
        .child(half(vec![group(everywhere)]));
    Dialog::new("shortcuts", "Keyboard shortcuts")
        .width(680.0)
        .fit()
        .open(true)
        .on_close(|s: &mut State| s.shortcuts = false)
        .child(body)
        .build(k, layer);
}

/// What the last test or save attempt found, in plain words. The line keeps
/// its height when empty so the buttons do not move as results arrive.
fn connection_status(form: &Connection, k: &Kit) -> El {
    let line = row().key("status").w_full().min_h(20.0).px(16.0).mt(12.0).gap(8.0).center_y();
    let dot = |color: Color| el().size(7.0, 7.0).radius(3.5).fill(color);
    let words =
        |message: String, color: Color| text(message).font(k.ty.text_small).color(color).wrap().grow(1.0).min_w(0.0);
    if let Some(error) = form.error {
        return line.child(dot(k.c.danger.icon)).child(words(error.message().into(), k.c.text_base));
    }
    match form.check {
        Check::Idle => line,
        Check::Testing => line.child(words("Connecting to the server".into(), k.c.text_muted)),
        Check::Ok(projects) => {
            let found = match projects {
                0 => "Connected. This account sees no projects.".to_string(),
                1 => "Connected. 1 project is visible.".to_string(),
                n => format!("Connected. {n} projects are visible."),
            };
            line.child(dot(k.c.success.icon)).child(words(found, k.c.text_base))
        }
        Check::Failed(failure) => {
            line.child(dot(k.c.danger.icon)).child(words(failure.message().into(), k.c.text_base))
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Issue table

/// How fresh the list is, and how it stays so: its age, with a bead that
/// pulses while the window re-reads by itself, and the interval it does that
/// on. Beside Refresh because all three answer "is this current?". The bead
/// keeps its room when idle so the words do not shift as reads come and go,
/// and it is not announced: a status spoken every minute would be noise.
///
/// Below `ROOMY_W` the age drops its "Updated": the project's name is what
/// identifies the list, and it must not be the thing that truncates.
fn freshness(s: &State, th: &Theme, roomy: bool, layer: &mut Vec<El>) -> El {
    let t = &th.t;
    let mut bead = el().key("refreshing").size(7.0, 7.0).radius(3.5).a11y_hidden();
    if s.background {
        bead = bead.fill(t.mint).looping(LoopSpec::opacity(1.4, 0.0, 0.35, 1.0));
    }
    let mut age = row().key("freshness").gap(6.0).center_y().child(bead);
    if let Some(words) = s.updated_label() {
        let shown = if roomy { words.clone() } else { words.trim_start_matches("Updated ").to_string() };
        age = age.child(text(shown).key("updated").label(words).font(th.ty.xs).color(t.tx_dim));
    }
    let choices = REFRESH_CHOICES.map(|(label, _)| label);
    let interval = Select::new("auto-refresh", &choices)
        .label("Automatic refresh")
        .current(s.auto_refresh_label())
        .open(s.refresh_menu)
        .on_toggle(|s: &mut State| s.refresh_menu = !s.refresh_menu)
        .on_close(|s: &mut State| s.refresh_menu = false)
        .on_choose(|s: &mut State, label, _| s.choose_auto_refresh(label))
        .build(&th.k, layer);
    row().gap(4.0).center_y().child(age).child(interval)
}

fn main_pane(s: &State, th: &Theme, roomy: bool, layer: &mut Vec<El>) -> El {
    let (k, t) = (&th.k, &th.t);
    let title = match s.current_project() {
        Some(p) => p.name.clone(),
        None => s.project.clone().unwrap_or_else(|| "Issues".into()),
    };
    let count = match &s.issues {
        Load::Ready(all) if s.visible.len() == all.len() => match all.len() {
            1 => "1 issue".to_string(),
            n => format!("{n} issues"),
        },
        Load::Ready(all) => format!("{} of {}", s.visible.len(), all.len()),
        _ => String::new(),
    };
    let search = TextInput::new(&s.search)
        .placeholder("Filter by title, id, label or assignee")
        .leading_icon(k.glyph.search)
        .clear_button()
        .width(None)
        .on_edit(|s: &mut State| &mut s.search)
        .on_change(|s: &mut State, _: &mut Tx| s.refilter())
        .on_submit(keys::submit_filter)
        .on_key(keys::filter_key)
        .build(k)
        .key("search");

    let refresh = Button::new(if busy(s) { "Refreshing" } else { "Refresh" })
        .variant(if busy(s) { ButtonVariant::Loading } else { ButtonVariant::GhostMuted })
        .on_press(|s: &mut State| s.refresh())
        .build(k)
        .key("refresh");
    let toolbar = col()
        .key("toolbar")
        .w_full()
        .px(20.0)
        .pt(16.0)
        .pb(8.0)
        .gap(12.0)
        .child(
            row()
                .w_full()
                .center_y()
                .gap(10.0)
                .child(text(title.clone()).font(th.ty.md_strong).color(t.tx_hi).truncate().min_w(0.0))
                .child(text(count).font(th.ty.xs).color(t.tx_dim))
                .child(el().grow(1.0))
                .child(freshness(s, th, roomy, layer))
                .child(refresh),
        )
        .child(search.w_full());

    let content = match &s.issues {
        Load::Ready(all) if all.is_empty() => {
            state(th, false, "No issues yet", &format!("Issues filed in {title} with bd appear here."), Vec::new())
        }
        Load::Ready(_) if s.visible.is_empty() => no_matches(s, th),
        Load::Ready(_) => issue_table(s, th, roomy),
        Load::Failed(f) => failure_state(*f, busy(s), th),
        Load::Loading => table_skeleton(th, roomy),
        // The project list is still on its way: the table it will fill.
        Load::Idle if s.projects.ready().is_none() => table_skeleton(th, roomy),
        Load::Idle => note(th, "Choose a project."),
    };

    col()
        .key("main")
        .grow(1.0)
        .min_w(0.0)
        .h_full()
        .child(toolbar)
        .child(status_tabs(s, th))
        .child(rule_h(th))
        // The table's cells pad themselves by 10, so this lines its text up
        // with the toolbar's 20.
        .child(col().key("table-frame").w_full().grow(1.0).min_h(0.0).px(10.0).child(content))
}

/// The status filter as a row of tabs, each with how many of the project's
/// issues it holds, so the filter also answers "how much is blocked?". The
/// selected tab takes the mark as an underline that sits on the rule below.
fn status_tabs(s: &State, th: &Theme) -> El {
    let t = &th.t;
    let issues = s.issues.ready();
    let mut tabs = row().key("status-filter").role("radiogroup").label("Status").focus_group().w_full().px(10.0);
    for (i, (label, filter)) in STATUS_FILTERS.iter().enumerate() {
        let on = s.status_filter == i;
        let count = issues.map(|all| all.iter().filter(|issue| filter.admits(issue)).count());
        let name = match count {
            Some(n) => format!("{label}, {n}"),
            None => (*label).to_string(),
        };
        let mut words = row().h(30.0).px(10.0).gap(6.0).center_y().child(
            text(*label).font(if on { th.ty.sm_strong } else { th.ty.sm }).color(if on { t.tx_hi } else { t.tx_mid }),
        );
        if let Some(n) = count {
            words = words.child(text(n.to_string()).font(th.ty.xs).color(t.tx_dim));
        }
        tabs = tabs.child(
            col()
                .key(format!("status-{i}"))
                .role("radio")
                .label(name)
                .focusable(true)
                .focus_selected(on)
                .focus_ring(2.0, -2.0, t.em_400)
                .position_in_set(i + 1, STATUS_FILTERS.len())
                .hover(th.k.c.hover)
                .on_press(move |s: &mut State| {
                    s.status_filter = i;
                    s.refilter();
                })
                .child(words)
                .child(el().w_full().h(2.0).fill(if on { t.em_500 } else { Color::TRANSPARENT })),
        );
    }
    tabs
}

/// Filters that hide every issue: say which ones, and offer the way out.
fn no_matches(s: &State, th: &Theme) -> El {
    let query = s.search.text.trim();
    let status = STATUS_FILTERS.get(s.status_filter).filter(|_| s.status_filter != 0).map(|(l, _)| l.to_lowercase());
    let what = match (query.is_empty(), status) {
        (false, Some(status)) => format!("Nothing {status} matches “{query}”."),
        (false, None) => format!("Nothing matches “{query}”."),
        (true, Some(status)) => format!("No issues are {status}."),
        (true, None) => String::new(),
    };
    let clear = Button::new("Clear filters")
        .variant(ButtonVariant::Neutral)
        .on_press(|s: &mut State| s.clear_filters())
        .build(&th.k)
        .key("clear-filters");
    state(th, false, "No matching issues", &what, vec![clear])
}

fn issue_table(s: &State, th: &Theme, roomy: bool) -> El {
    let (k, t) = (&th.k, th.t);
    let style = TableStyle {
        row_height: 32.0,
        header_height: 30.0,
        font: th.ty.sm,
        mono: th.ty.xs,
        header_font: th.ty.xs,
        text: t.tx_hi,
        muted: t.tx_mid,
        header_text: t.tx_dim,
        rule: t.line,
        // `.tbl tr.is-selected`: the mark as a wash.
        selected: t.em_wash_2,
        stripe: t.tx_hi.alpha(0.025),
        ..TableStyle::from_kit(k)
    };
    let look = StatusLooks::new(th);
    let priority = [0, 1, 2, 3].map(|p| th.priority(p));
    let xs = th.ty.xs;
    let mut table = Table::new(
        |s: &State| &s.table,
        |s: &mut State| &mut s.table,
        |s: &State| s.visible.len(),
        |s: &State, i| Cow::Borrowed(s.visible_issue(i).map_or("", |x| x.id.as_str())),
    )
    .name("Issues")
    .style(style)
    // Ids, priorities and dates are labels, not quantities: left-aligned.
    .column(TableColumn::new("id", "ID").width(80.0).min(56.0).sortable())
    .column(TableColumn::new("title", "Title").flex(3.0).min(160.0).sortable())
    .column(TableColumn::new("status", "Status").width(108.0).min(96.0).sortable())
    // Beside the status it qualifies: an open issue with a number here is
    // open but not ready.
    .column(TableColumn::new("blockers", "Blockers").width(BLOCKERS_W).min(64.0).sortable())
    .column(TableColumn::new("priority", "Pri").width(46.0).min(44.0).sortable());
    if roomy {
        table = table
            .column(TableColumn::new("type", "Type").width(72.0).min(56.0).sortable())
            .column(TableColumn::new("assignee", "Assignee").width(84.0).min(64.0).sortable());
    }
    table
        .column(TableColumn::new("updated", "Updated").width(76.0).min(68.0).sortable())
        .cell(move |s: &State, i, column| {
            let Some(issue) = s.visible_issue(i) else { return Cell::text("") };
            match column {
                "id" => Cell::text(&issue.id).mono().color(t.tx_dim),
                // Closed work recedes but stays readable and openable.
                "title" if issue.status == "closed" => Cell::text(&issue.title).color(t.tx_dim),
                "title" => Cell::text(&issue.title),
                "status" => Cell::el(status_word(&issue.status, look.get(&issue.status), xs)),
                // Most issues wait on nothing, and a column of zeros would
                // bury the ones that do: only a count that blocks is drawn.
                "blockers" if issue.blocker_count == 0 => Cell::text(""),
                // Closed work is not held up by what it once waited on.
                "blockers" if issue.status == "closed" => {
                    Cell::text(issue.blocker_count.to_string()).mono().color(t.tx_dim)
                }
                "blockers" => Cell::text(issue.blocker_count.to_string()).mono().color(t.amber_tx),
                "priority" => Cell::text(format!("P{}", issue.priority))
                    .mono()
                    .color(priority[issue.priority.clamp(0, 3) as usize]),
                "type" if issue.issue_type == "epic" => Cell::text(&issue.issue_type).mono().color(t.violet_tx),
                "type" => Cell::text(&issue.issue_type).mono().color(t.tx_dim),
                // No assignee is a fact about the issue, shown as a dash.
                "assignee" => Cell::text(issue.assignee.as_deref().unwrap_or("—")).mono().color(t.tx_mid),
                // The day is enough to scan by; the detail pane has the time.
                _ => Cell::text(short_date(issue.updated_at.get(..10).unwrap_or(&issue.updated_at)))
                    .mono()
                    .color(t.tx_dim),
            }
        })
        .on_sort(|s: &mut State, column, dir, _| s.sort(column, dir))
        .on_select(|s: &mut State, id, _| {
            s.pane = Pane::List;
            s.select_issue(id);
        })
        // Return or a double click: the same "read it" as `o`.
        .on_open(|s: &mut State, id, tx| {
            s.select_issue(id);
            keys::run(s, Command::Open, tx);
        })
        .zebra(true)
        .build(s, k)
        .key(TABLE_KEY)
        .grow(1.0)
        .min_h(0.0)
}

/// The status looks a table cell can need, resolved once per view rather
/// than once per cell.
#[derive(Clone, Copy)]
struct StatusLooks {
    known: [(&'static str, StatusLook); 6],
    other: StatusLook,
}

impl StatusLooks {
    fn new(th: &Theme) -> StatusLooks {
        let known = ["open", "in_progress", "blocked", "closed", "pinned", "hooked"].map(|s| (s, th.status(s)));
        StatusLooks { known, other: th.status("") }
    }

    fn get(&self, status: &str) -> StatusLook {
        self.known.iter().find(|(name, _)| *name == status).map_or(self.other, |(_, look)| *look)
    }
}

// ---------------------------------------------------------------------------------------------
// Detail

fn detail_pane(s: &State, th: &Theme, roomy: bool) -> El {
    let inner = match (&s.issue, &s.detail) {
        (None, _) => note(th, "Select an issue to read it."),
        (Some(_), Load::Ready(Some(d))) => detail(d, th),
        (Some(id), Load::Ready(None)) => state(
            th,
            false,
            &format!("{id} is gone"),
            "It is no longer on the server. It may have been deleted or renamed since the list loaded.",
            Vec::new(),
        ),
        (Some(_), Load::Failed(f)) => failure_state(*f, busy(s), th),
        (Some(_), _) => detail_skeleton(th),
    };
    let mut pane = col().key("detail").w(if roomy { 380.0 } else { 320.0 }).h_full();
    // Above every state of the pane, so an issue that failed to load or has
    // left the server still shows the way back to the one that linked to it.
    if let Some(bar) = trail_bar(s, th) {
        pane = pane.child(bar);
    }
    let pane = pane.child(col().w_full().grow(1.0).min_h(0.0).child(inner));
    // Enter hands plain keys to this pane (`Pane::Detail`); nothing in it
    // holds Rune's focus then, so the pane draws the ring itself.
    if s.pane == Pane::Detail && s.issue.is_some() {
        pane.child(el().key("reading").absolute(0.0, 0.0).w_full().h_full().border(2.0, th.t.em_400).a11y_hidden())
    } else {
        pane
    }
}

/// Back and forward along the dependency links followed to get here
/// (`app::Trail`), each named by the issue it leads to. Drawn only once a
/// link has been followed: an issue chosen from the list has no trail.
fn trail_bar(s: &State, th: &Theme) -> Option<El> {
    if s.trail.is_empty() {
        return None;
    }
    let t = &th.t;
    let step = |to: &str, back: bool| {
        let (key, words, command, chord) = if back {
            ("trail-back", format!("Back to {to}"), Command::TrailBack, "⌘[")
        } else {
            ("trail-forward", format!("Forward to {to}"), Command::TrailForward, "⌘]")
        };
        let arrow = text(if back { "←" } else { "→" }).font(th.ty.sm).color(t.tx_mid).a11y_hidden();
        let id = text(to.to_string()).font(th.ty.xs).color(t.tx_mid).a11y_hidden();
        let button = row()
            .key(key)
            .role("button")
            .help(format!("{words} ({})", keys::key_label(chord)))
            .label(words)
            .focusable(true)
            .focus_ring(2.0, 1.0, t.em_400)
            .h(24.0)
            .px(8.0)
            .gap(6.0)
            .center_y()
            .radius(th.k.radius.sm)
            .hover(th.k.c.hover)
            .on_press_tx(move |s: &mut State, tx: &mut Tx| keys::perform(s, command, tx));
        if back { button.child(arrow).child(id) } else { button.child(id).child(arrow) }
    };
    let mut bar = row().key("trail").role("navigation").label("Followed links").w_full().h(36.0).px(12.0).center_y();
    if let Some(to) = s.trail.back.last() {
        bar = bar.child(step(to, true));
    }
    bar = bar.child(el().grow(1.0));
    if let Some(to) = s.trail.forward.last() {
        bar = bar.child(step(to, false));
    }
    Some(col().w_full().child(bar).child(rule_h(th)))
}

fn detail(d: &IssueDetail, th: &Theme) -> El {
    let t = &th.t;
    let i = &d.summary;
    let mut chips = row().gap(10.0).center_y().wrap();
    chips = chips
        .child(status_badge(&i.status, th))
        .child(text(format!("P{}", i.priority)).font(th.ty.xs_strong).color(th.priority(i.priority)))
        .child(text(i.issue_type.clone()).font(th.ty.xs).color(if i.issue_type == "epic" {
            t.violet_tx
        } else {
            t.tx_dim
        }));
    for l in &i.labels {
        chips = chips.child(tag(l, th));
    }

    let mut facts = col().gap(6.0);
    for (label, value) in [
        ("Assignee", i.assignee.clone()),
        ("Created", join_opt(&d.created_at, &d.created_by)),
        ("Updated", Some(short_date(&i.updated_at)).filter(|u| !u.is_empty())),
    ] {
        facts = facts.child(fact(label, value.as_deref().unwrap_or("—"), th));
    }

    let heading = col()
        .key(keys::DETAIL_ANCHOR)
        .gap(4.0)
        .child(text(i.id.clone()).font(th.ty.xs).color(t.tx_dim).selectable(true).selection_color(th.k.selection()))
        .child(
            text(i.title.clone())
                .font(th.ty.md_strong)
                .color(t.tx_hi)
                .wrap()
                .selectable(true)
                .selection_color(th.k.selection()),
        );

    let mut body = col()
        .key(format!("issue-{}", i.id))
        .w_full()
        .px(20.0)
        .pt(16.0)
        .pb(24.0)
        .gap(14.0)
        .child(heading)
        .child(chips)
        .child(facts);

    for (title, src) in [
        ("Description", &d.description),
        ("Design", &d.design),
        ("Acceptance criteria", &d.acceptance_criteria),
        ("Notes", &d.notes),
    ] {
        if let Some(src) = src {
            body = body
                .child(section(title, None, th))
                .child(Markdown::new(src.clone()).selectable(true).build(&th.prose));
        }
    }
    if !d.dependencies.is_empty() {
        body =
            body.child(section("Depends on", Some(d.dependencies.len()), th)).child(refs(&d.dependencies, "dep", th));
    }
    if !d.dependents.is_empty() {
        body = body.child(section("Blocks", Some(d.dependents.len()), th)).child(refs(&d.dependents, "blocks", th));
    }
    if !d.comments.is_empty() {
        body = body.child(section("Comments", Some(d.comments.len()), th));
        for (n, c) in d.comments.iter().enumerate() {
            let when = c.created_at.as_deref().map(short_date).unwrap_or_default();
            // `.chat-msg`: a role line in the interface face, the body in prose.
            body = body.child(
                col()
                    .key(format!("comment-{n}"))
                    .w_full()
                    .gap(4.0)
                    .child(
                        row()
                            .w_full()
                            .gap(8.0)
                            .center_y()
                            .child(
                                text(c.author.clone())
                                    .font(th.ty.xs_strong)
                                    .color(t.tx_hi)
                                    .truncate()
                                    .grow(1.0)
                                    .min_w(0.0),
                            )
                            .child(text(when).font(th.ty.xs).color(t.tx_dim)),
                    )
                    .child(Markdown::new(c.text.clone()).selectable(true).build(&th.prose)),
            );
        }
    }
    col().w_full().h_full().child(body.scroll(ScrollSpec { stick_bottom: false }).grow(1.0).min_h(0.0))
}

fn refs(items: &[IssueRef], prefix: &str, th: &Theme) -> El {
    let t = &th.t;
    // Pulled out by the rows' own padding so their text lines up with the pane's.
    let mut list = col().w_full().gap(1.0).mx(-8.0);
    for r in items {
        let id = r.id.clone();
        let look = th.status(r.status.as_deref().unwrap_or(""));
        let title = r.title.clone().unwrap_or_else(|| "(not found)".into());
        let status = r.status.as_deref().unwrap_or("missing").replace('_', " ");
        // Only a `blocks` link holds work back, and most links are that
        // type, so the others say what they are instead.
        let kind = r.dep_type.as_deref().filter(|kind| *kind != "blocks");
        let label = match kind {
            Some(kind) => format!("{}, {status}, {kind}: {title}", r.id),
            None => format!("{}, {status}: {title}", r.id),
        };
        let mut link = row()
            .key(format!("{prefix}-{}", r.id))
            .role("link")
            .label(label)
            .focusable(true)
            .focus_ring(2.0, 1.0, t.em_400)
            .w_full()
            .px(8.0)
            .h(30.0)
            .gap(8.0)
            .center_y()
            .radius(th.k.radius.sm)
            .hover(th.k.c.hover)
            // Through the trail, so the reader can come back.
            .on_press_tx(move |s: &mut State, tx: &mut Tx| keys::follow_link(s, &id, tx))
            .child(bead(look))
            .child(text(r.id.clone()).font(th.ty.xs).color(t.tx_dim))
            .child(text(title).font(th.ty.sm).color(t.tx).truncate().grow(1.0).min_w(0.0));
        if let Some(kind) = kind {
            link = link.child(text(kind.to_string()).font(th.ty.xs).color(t.tx_dim).a11y_hidden());
        }
        list = list.child(link);
    }
    list
}

// ---------------------------------------------------------------------------------------------
// Pieces

fn rule_h(th: &Theme) -> El {
    el().role("separator").w_full().h(1.0).fill(th.t.line)
}

fn rule_v(th: &Theme) -> El {
    el().role("separator").w(1.0).h_full().fill(th.t.line)
}

/// A section heading (`.caps`) over a hairline, with a quiet count when the
/// section is a list.
fn section(title: &str, count: Option<usize>, th: &Theme) -> El {
    let mut heading = row().gap(8.0).center_y().child(text(title.to_uppercase()).font(th.ty.caps).color(th.t.tx_hi));
    if let Some(n) = count {
        heading = heading.child(text(n.to_string()).font(th.ty.xs).color(th.t.tx_dim));
    }
    col().w_full().pt(8.0).gap(6.0).child(heading).child(rule_h(th))
}

/// One row of `.kv`: a quiet label and its value.
fn fact(label: &str, value: &str, th: &Theme) -> El {
    row()
        .gap(16.0)
        .center_y()
        .child(text(label.to_string()).font(th.ty.xs).color(th.t.tx_dim).w(72.0))
        .child(text(value.to_string()).font(th.ty.sm).color(th.t.tx).truncate().grow(1.0).min_w(0.0))
}

/// The status bead (`.dot`): the same atom in the table, the badge and the
/// dependency lists. Closed work wears a hollow ring, so the state does not
/// rest on colour alone.
fn bead(look: StatusLook) -> El {
    let dot = el().size(7.0, 7.0).radius(3.5);
    match look.bead {
        Some(color) => dot.fill(color),
        None => dot.border(1.5, look.ink),
    }
}

/// A status in a table row: bead and word, no box, so a column of them reads
/// as text.
fn status_word(status: &str, look: StatusLook, face: rune::TextStyle) -> El {
    row().gap(7.0).center_y().child(bead(look)).child(text(status.replace('_', " ")).font(face).color(look.ink))
}

/// A status where it is the subject (`.badge`): the detail pane's header.
fn status_badge(status: &str, th: &Theme) -> El {
    let look = th.status(status);
    row()
        .role("status")
        .label(status.replace('_', " "))
        .h(22.0)
        .pl(7.0)
        .pr(8.0)
        .gap(6.0)
        .center_y()
        .radius(th.k.radius.sm)
        .fill(look.wash)
        .child(el().absolute(0.0, 0.0).w_full().h_full().radius(th.k.radius.sm).border(1.0, look.line).a11y_hidden())
        .child(bead(look))
        .child(text(status.replace('_', " ")).font(th.ty.xs).color(look.ink).a11y_hidden())
}

/// A label (`.tag`).
fn tag(label: &str, th: &Theme) -> El {
    row()
        .h(20.0)
        .px(6.0)
        .center_y()
        .radius(th.k.radius.sm)
        .fill(th.t.s3)
        .child(text(format!("#{label}")).font(th.ty.xs).color(th.t.tx_mid))
}

fn note(th: &Theme, message: &str) -> El {
    col()
        .key("note")
        .w_full()
        .h_full()
        .center()
        .padding(24.0)
        .child(text(message.to_string()).font(th.ty.sm).color(th.t.tx_mid).wrap().align(rune::Align::Center))
}

/// A pane with nothing to list (`src/lib/components/empty-state.svelte`):
/// the mark, what is missing, why, and what to do about it. `lit` is for a
/// failure, which wears the red bead; an empty pane wears the web app's
/// thread with the bead missing from it.
fn state(th: &Theme, lit: bool, title: &str, description: &str, actions: Vec<El>) -> El {
    let t = &th.t;
    let bead = if lit {
        el().absolute(17.5, 17.5).size(9.0, 9.0).radius(4.5).fill(t.em_500)
    } else {
        el().absolute(15.5, 15.5).size(13.0, 13.0).radius(6.5).fill(t.bg).border(1.0, t.tx_dim).border_dash(2.5, 2.5)
    };
    let mark =
        el().size(44.0, 44.0).a11y_hidden().child(el().absolute(21.5, 4.0).w(1.0).h(36.0).fill(t.line_2)).child(bead);
    let mut body = col().key("state").w_full().h_full().center().padding(24.0).child(mark).child(
        text(title.to_string()).font(th.ty.base_strong).color(t.tx_hi).wrap().align(rune::Align::Center).mt(12.0),
    );
    if lit {
        // A failure is announced; an empty list is only read.
        body = body.role("alert").label(format!("{title}. {description}"));
    }
    if !description.is_empty() {
        body = body.child(
            text(description.to_string())
                .font(th.ty.sm)
                .color(t.tx_mid)
                .wrap()
                .align(rune::Align::Center)
                .max_w(460.0)
                .mt(6.0),
        );
    }
    if !actions.is_empty() {
        let mut buttons = row().key("actions").gap(8.0).center().flex_wrap().mt(16.0);
        for action in actions {
            buttons = buttons.child(action);
        }
        body = body.child(buttons);
    }
    body
}

/// A read that failed with nothing to show in its place: one of the fixed
/// failure classes in words, never driver text, and its recovery actions.
fn failure_state(failure: Failure, busy: bool, th: &Theme) -> El {
    state(th, true, failure.title(), failure.message(), failure_actions(failure, busy, &th.k))
}

// ---------------------------------------------------------------------------------------------
// Skeletons: a pending pane keeps the geometry of what will fill it, as the
// web app's do (`src/lib/components/skeleton-rows.svelte`), so content lands
// in place instead of replacing a spinner.

/// One placeholder bar (`.skel`). The pulse is Rune's shared loop, which
/// holds still under reduced motion.
fn bar(th: &Theme, w: f32, h: f32) -> El {
    el().w(w).h(h).radius(th.k.radius.xs).fill(th.t.line).a11y_hidden().looping(LoopSpec::opacity(1.4, 0.0, 0.45, 1.0))
}

/// A bar that takes `frac` of the room its column leaves it.
fn flex_bar(th: &Theme, frac: f32, h: f32) -> El {
    el().grow(1.0).min_w(0.0).a11y_hidden().child(
        el().w_frac(frac).h(h).radius(th.k.radius.xs).fill(th.t.line).looping(LoopSpec::opacity(1.4, 0.0, 0.45, 1.0)),
    )
}

/// Titles are ragged; so are their placeholders.
const RAGGED: [f32; 8] = [0.68, 0.54, 0.74, 0.46, 0.62, 0.58, 0.7, 0.5];

/// The pending pane as assistive technology hears it: one status, no bars.
fn pending(key: &'static str, label: &'static str) -> El {
    col().key(key).role("status").label(label).w_full().h_full()
}

fn projects_skeleton(th: &Theme) -> El {
    let mut list = pending("projects-loading", "Finding projects").px(12.0).gap(1.0);
    for (n, w) in [96.0, 64.0, 112.0, 80.0].into_iter().enumerate() {
        list = list.child(
            row()
                .key(format!("row-{n}"))
                .w_full()
                .px(8.0)
                .py(6.0)
                .gap(12.0)
                .child(el().ml(4.0).mt(7.0).size(7.0, 7.0).radius(3.5).fill(th.t.line).a11y_hidden())
                .child(col().grow(1.0).gap(8.0).py(5.0).child(bar(th, w, 10.0)).child(bar(th, w * 0.7, 8.0))),
        );
    }
    list
}

/// The issue table's header and rows, in its column widths.
fn table_skeleton(th: &Theme, roomy: bool) -> El {
    let cell = |w: f32, bar: El| row().w(w).px(10.0).center_y().child(bar);
    let line = |n: usize, h: f32, bars: [f32; 6], title: f32, thick: f32| {
        let mut r = row()
            .key(format!("row-{n}"))
            .w_full()
            .h(h)
            .center_y()
            .child(cell(80.0, bar(th, bars[0], thick)))
            .child(row().grow(1.0).min_w(0.0).px(10.0).center_y().child(flex_bar(th, title, thick)))
            .child(cell(108.0, bar(th, bars[1], thick)))
            .child(cell(BLOCKERS_W, bar(th, bars[2], thick)))
            .child(cell(46.0, bar(th, bars[3], thick)));
        if roomy {
            r = r.child(cell(72.0, bar(th, bars[4], thick))).child(cell(84.0, bar(th, bars[4], thick)));
        }
        col().w_full().child(r.child(cell(76.0, bar(th, bars[5], thick)))).child(rule_h(th).a11y_hidden())
    };
    let mut table = pending("issues-loading", "Loading issues").child(line(
        0,
        30.0,
        [18.0, 44.0, 52.0, 22.0, 34.0, 52.0],
        0.12,
        8.0,
    ));
    for (n, title) in RAGGED.into_iter().enumerate() {
        // Few issues are blocked, so the rows leave that column empty.
        table = table.child(line(n + 1, 32.0, [40.0, 64.0, 0.0, 18.0, 40.0, 44.0], title, 10.0));
    }
    table
}

/// The detail pane: id, title, chips, facts, then a section of prose.
fn detail_skeleton(th: &Theme) -> El {
    let fact = |w: f32| row().gap(16.0).center_y().h(20.0).child(bar(th, 72.0, 8.0)).child(bar(th, w, 10.0));
    let mut body = pending("issue-loading", "Loading issue")
        .px(20.0)
        .pt(20.0)
        .gap(14.0)
        .child(col().w_full().gap(10.0).child(bar(th, 44.0, 8.0)).child(row().w_full().child(flex_bar(th, 0.8, 14.0))))
        .child(
            row().gap(10.0).center_y().child(bar(th, 72.0, 22.0)).child(bar(th, 20.0, 10.0)).child(bar(th, 40.0, 10.0)),
        )
        .child(col().gap(6.0).child(fact(64.0)).child(fact(148.0)).child(fact(96.0)))
        .child(col().w_full().pt(8.0).gap(8.0).child(bar(th, 88.0, 8.0)).child(rule_h(th).a11y_hidden()));
    for (n, frac) in [1.0, 0.92, 0.97, 0.6].into_iter().enumerate() {
        body = body.child(row().key(format!("line-{n}")).w_full().child(flex_bar(th, frac, 10.0)));
    }
    body
}

/// `2026-11-06 13:05` → `Nov 6 13:05`.
pub fn short_date(at: &str) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let month = at.get(5..7).and_then(|m| m.parse::<usize>().ok()).filter(|m| (1..=12).contains(m));
    let day = at.get(8..10).and_then(|d| d.parse::<u32>().ok());
    match (month, day, at.get(11..16)) {
        (Some(m), Some(d), Some(time)) => format!("{} {d} {time}", MONTHS[m - 1]),
        (Some(m), Some(d), None) => format!("{} {d}", MONTHS[m - 1]),
        _ => at.to_string(),
    }
}

fn join_opt(at: &Option<String>, by: &Option<String>) -> Option<String> {
    match (at, by) {
        (Some(at), Some(by)) => Some(format!("{} by {by}", short_date(at))),
        (Some(at), None) => Some(short_date(at)),
        (None, Some(by)) => Some(format!("by {by}")),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::short_date;

    #[test]
    fn dates_shorten_for_the_table() {
        assert_eq!(short_date("2026-11-06 13:05"), "Nov 6 13:05");
        assert_eq!(short_date("2026-01-09"), "Jan 9");
        assert_eq!(short_date("soon"), "soon");
    }
}
