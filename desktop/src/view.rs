//! The window: a title bar, projects on the left, the issues in the middle
//! (as a table or as a board), the selected issue on the right. Layout follows the web app's
//! project page (`src/routes/p/[id]/+page.svelte`) and its tokens
//! (`src/app.css`, restated in `theme.rs`), drawn with Rune's components.

use std::borrow::Cow;
use std::rc::Rc;

use rune::TextEdit;
use rune::{Color, Cx, El, GrowthSpec, LoopSpec, ScrollSpec, Tx, col, el, row, text};
use rune_kit::{
    Button, ButtonVariant, Cell, Dialog, Field, Keybind, Kit, Markdown, SegmentedControl, Select, Table, TableColumn,
    TableStyle, TextInput, Toast, ToastRegion,
};

use crate::app::{BOARD_KEY, Check, Connection, Layout, Load, Notice, Pane, Quick, STATUS_FILTERS, State, TABLE_KEY};
use crate::keys::{self, Command};
use crate::model::{DepGroup, Failure, IssueDetail, IssueSummary, Project, dep_groups};
use crate::quick::{self, Target};
use crate::settings::{DEFAULT_WINDOW, REFRESH_CHOICES};
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
/// What a sorted heading adds after its title: rune-kit's `header_row` puts
/// a 14 pt chevron 2 pt after it. The fixed columns are sized to their
/// unsorted headings, so the sorted one grows by this much rather than every
/// column carrying room for an arrow it rarely shows; without it a sorted Pri
/// heading read as an ellipsis. The title column gives the room up, down to
/// a floor this much lower than usual: at the minimum window the title is
/// already at its floor, and the table must not run past its edge.
const SORT_ARROW_W: f32 = 16.0;
/// The title column's floor: about twenty characters of a title.
const TITLE_MIN_W: f32 = 160.0;
/// The detail pane, in a roomy window and below `ROOMY_W`.
const DETAIL_W: (f32, f32) = (380.0, 320.0);
/// The narrowest a board column gets before the board scrolls sideways
/// instead: four of them fit the default window, and a card's title still
/// has about twenty characters a line.
const LANE_MIN_W: f32 = 190.0;
/// The widest: a status tab leaves one column, which should stay a column
/// and not stretch into a second table.
const LANE_MAX_W: f32 = 380.0;
const LANE_GAP: f32 = 8.0;
/// The room the board keeps from the pane's edges.
const BOARD_PAD: f32 = 12.0;

pub fn view(s: &State, cx: &mut Cx<State>) -> El {
    let th = Theme::new(s.appearance.dark(cx.system_dark()));
    // Unknown until the first layout; the window opens wider than `ROOMY_W`.
    let shell_w = cx.layout_size("shell").map_or(DEFAULT_WINDOW.0, |size| size[0]);
    let roomy = shell_w >= ROOMY_W;
    // What the sidebar, the detail pane and the two rules between them leave.
    let main_w = shell_w - SIDEBAR_W - if roomy { DETAIL_W.0 } else { DETAIL_W.1 } - 2.0;
    let panes = row().key("panes").w_full().grow(1.0).min_h(0.0).child(sidebar(s, &th)).child(rule_v(&th));
    // With no project list there is no table or issue to frame, so the
    // reason takes the room of both panes instead of repeating in each.
    let mut layer = Vec::new();
    let panes = match server_state(s, &th) {
        Some(state) => panes.child(state),
        None => panes
            .child(main_pane(s, &th, roomy, main_w, &mut layer))
            .child(rule_v(&th))
            .child(detail_pane(s, &th, roomy)),
    };
    // On macOS a window without its buttons is in full screen: the display's
    // size, which is not one to reopen a window at.
    let full_screen = cfg!(target_os = "macos") && cx.titlebar_inset() == 0.0;
    let mut body = col()
        .key("shell")
        .w_full()
        .h_full()
        .fill(th.t.bg)
        // The shell fills the window, so its size is the window's: kept for
        // `State::remember_window`. Nothing drawn reads it from the state.
        .on_layout_tx(move |s: &mut State, [_, _, w, h], tx: &mut Tx| {
            s.window = (!full_screen).then_some((w, h));
            tx.live_only();
        })
        .child(title_bar(s, &th, cx.titlebar_inset()));
    if let Some(failure) = s.stale.failure() {
        body = body.child(stale_banner(s, failure, &th));
    }
    let body = body.child(panes);
    if let Some(form) = &s.connection {
        connection_dialog(s, form, &th.k, &mut layer);
    } else if s.shortcuts {
        // Unknown until the first layout, like `shell_w`.
        let shell_h = cx.layout_size("shell").map_or(DEFAULT_WINDOW.1, |size| size[1]);
        shortcuts_dialog(&th, shell_h, &mut layer);
    } else if let Some(quick) = &s.quick {
        quick_dialog(s, quick, &th, &mut layer);
    }
    if let Some(notice) = &s.notice {
        layer.push(notice_toast(notice, &th.k));
    }
    rune_kit::root(body, layer)
}

/// What an issue action did (`app::Notice`), in the kit's toast at the
/// window's lower right, over the issue pane rather than the list. It goes by
/// itself; nothing in it needs an answer.
fn notice_toast(notice: &Notice, k: &Kit) -> El {
    let mut toast = Toast::new("notice", notice.title.clone());
    if notice.done {
        toast = toast.icon(k, k.glyph.check);
    }
    if let Some(detail) = &notice.detail {
        toast = toast.description(detail.clone());
    }
    ToastRegion::new().toast(toast.build(k)).build(k)
}

// ---------------------------------------------------------------------------------------------
// Title bar

/// The app's own title bar, under macOS's transparent one: the brand, and
/// the one standing fact about this client. `lights` is where the window
/// buttons end (0 when there are none: full screen, other platforms). The
/// whole bar drags the window.
fn title_bar(s: &State, th: &Theme, lights: f32) -> El {
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
        .child(text("Read-only").font(th.ty.xs).color(t.tx_dim))
        .child(theme_toggle(s, th));
    col().w_full().child(bar).child(el().w_full().h(2.0).fill(t.rule))
}

/// The web app's three-state theme control (`theme-toggle.svelte`): the
/// bracketed word names the preference, and a press steps to the next one.
fn theme_toggle(s: &State, th: &Theme) -> El {
    let t = &th.t;
    let (now, next) = (s.appearance, s.appearance.next());
    let words = format!("Theme: {}. Switch to {}.", now.name(), next.name());
    row()
        .key("theme-toggle")
        .role("button")
        .help(format!("{words} ({})", keys::key_label("t")))
        .label(words)
        .focusable(true)
        .focus_ring(2.0, 1.0, t.em_400)
        .h(24.0)
        .px(6.0)
        .center_y()
        .radius(th.k.radius.sm)
        .hover(th.k.c.hover)
        .on_press_tx(|s: &mut State, tx: &mut Tx| keys::perform(s, Command::Theme, tx))
        .child(text(format!("[{}]", now.word())).font(th.ty.xs).color(t.tx_mid).a11y_hidden())
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
    let web = input(&form.web, "Web address", |f| &mut f.web, false)
        .placeholder("https://beads.example")
        .invalid(form.error == Some(crate::settings::FormError::Web))
        .build(k)
        .key("web");
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
        .child(field("Password", password, Some(password_hint.into())))
        .child(field(
            "Web address",
            web,
            Some("Optional. Where the Beadsmith web app is, for links to issues.".into()),
        ));

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

/// What the shortcuts dialog keeps around its list: the layer's 16 point
/// margin above and below the panel, and the panel's header (16 points of
/// padding either side of a 16 point title line).
const SHORTCUTS_CHROME_H: f32 = 2.0 * 16.0 + 48.0;

/// The keyboard shortcuts, as `?` shows them: `keys::SHORTCUTS` in two
/// columns. The list is about 815 points tall and the smallest window 560,
/// so it scrolls inside the window's height (`window_h`) rather than run off
/// its top and bottom; the page keys, Space and j/k page it
/// (`keys::on_key`), as they page an issue being read.
fn shortcuts_dialog(th: &Theme, window_h: f32, layer: &mut Vec<El>) {
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
    let list = col()
        .key(keys::SHORTCUTS_SCROLL)
        .w_full()
        .max_h((window_h - SHORTCUTS_CHROME_H).max(0.0))
        .scroll(ScrollSpec { stick_bottom: false })
        .child(body);
    Dialog::new("shortcuts", "Keyboard shortcuts")
        .width(680.0)
        .fit()
        .open(true)
        .on_close(|s: &mut State| s.shortcuts = false)
        .child(list)
        .build(k, layer);
}

/// A row of quick open's list, and how many of them show before it scrolls.
const QUICK_ROW_H: f32 = 32.0;
const QUICK_ROWS: f32 = 10.0;

/// Quick open (Cmd-K): a field over the projects and issues that match it.
/// It sits toward the top of the window, where a command palette is looked
/// for, and stays put as the list under it grows and shrinks. The caret
/// never leaves the field: the arrows move a highlight through the list
/// (`keys::quick_key`), which assistive technology follows as the field's
/// active descendant.
fn quick_dialog(s: &State, quick: &Quick, th: &Theme, layer: &mut Vec<El>) {
    let (k, t) = (&th.k, &th.t);
    let field = TextInput::new(&quick.query)
        .plain()
        .leading_icon(k.glyph.search)
        .height(44.0)
        .width(None)
        .placeholder("Jump to a project, or to an issue by id or title")
        .label("Quick open")
        .active_descendant(quick.active_target().map(|_| keys::quick_row_key(quick.active)))
        .on_edit(|s: &mut State| s.quick_field())
        .on_change(|s: &mut State, tx: &mut Tx| {
            s.quick_edited();
            // An edit starts again from the best match, at the top.
            tx.scroll_into_view(keys::quick_row_key(0));
        })
        .on_key(keys::quick_key)
        .build(k)
        .key("quick-field");

    let total = quick.results.len();
    let mut rows = col().key("quick-rows").w_full().padding(4.0);
    for (n, target) in quick.results.iter().enumerate() {
        rows = rows.child(quick_row(s, n, total, target, n == quick.active, th));
    }
    let list = col()
        .key("quick-list")
        .role("listbox")
        .label("Projects and issues")
        .w_full()
        .h((total as f32).min(QUICK_ROWS) * QUICK_ROW_H + if total > 0 { 8.0 } else { 0.0 })
        .scroll(ScrollSpec { stick_bottom: false })
        // A press on a row must not take the caret out of the field.
        .preserve_focus_on_press(true)
        .child(rows);

    // What the list is not showing, and why: still searching, a search that
    // failed (the projects above still match), or nothing to show.
    let typed = !quick::needle(&quick.query.text).is_empty();
    let status = match (quick.failed, quick.searching, total) {
        (Some(failure), ..) => format!("Issues could not be searched. {}", failure.message()),
        (None, true, _) => "Searching issues".to_string(),
        (None, false, 0) if typed => format!("No project or issue matches “{}”.", quick.query.text.trim()),
        (None, false, 0) => "No projects.".to_string(),
        (None, false, 1) => "1 result".to_string(),
        (None, false, n) if n >= quick::MAX_RESULTS => format!("First {n} results. Type more to narrow them."),
        (None, false, n) if typed => format!("{n} results"),
        (None, false, n) => format!("{n} projects. Type to find an issue."),
    };
    let hint = |caps: &[&str], does: &str| {
        let caps: Vec<String> = caps.iter().map(|c| keys::key_label(c)).collect();
        row()
            .gap(6.0)
            .center_y()
            .child(Keybind::new(&caps).build(k))
            .child(text(does.to_string()).font(th.ty.xs).color(t.tx_dim))
    };
    let footer = row()
        .key("quick-footer")
        .w_full()
        .min_h(36.0)
        .px(14.0)
        .py(8.0)
        .gap(14.0)
        .center_y()
        .child(
            text(status)
                .key("quick-status")
                .role("status")
                .font(th.ty.xs)
                .color(if quick.failed.is_some() { t.tx } else { t.tx_dim })
                .wrap()
                .grow(1.0)
                .min_w(0.0),
        )
        .child(hint(&["↑", "↓"], "Move").a11y_hidden())
        .child(hint(&["Enter"], "Open").a11y_hidden())
        .child(hint(&["Esc"], "Close").a11y_hidden());

    let panel = col()
        .key("quick-open")
        .role("dialog")
        .label("Quick open")
        .w_full()
        .max_w(600.0)
        .child(row().key("quick-header").w_full().px(6.0).child(field))
        .child(rule_h(th))
        .child(list)
        .child(rule_h(th).opacity(if total > 0 { 1.0 } else { 0.0 }))
        .child(footer);
    let panel = rune_kit::popover::raised(k, panel, k.radius.md)
        .modal(true, |s: &mut State| s.close_quick())
        .token_motion(k.motion.overlay);
    layer.push(el().key("quick-scrim").absolute(0.0, 0.0).w_full().h_full().fill(k.c.scrim).a11y_hidden());
    layer.push(
        col()
            .key("quick-layer")
            .absolute(0.0, 0.0)
            .w_full()
            .h_full()
            .px(16.0)
            .pt(TITLE_BAR_H + 44.0)
            .pb(16.0)
            .items_center()
            .child(panel),
    );
}

/// One result: an issue as the table shows one (status bead, id, title) with
/// the project it lives in, or a project as the sidebar does (its name and
/// how much is active). A square marks a project, so the two kinds are told
/// apart by shape as well as by the word at the row's end.
fn quick_row(s: &State, n: usize, total: usize, target: &Target, active: bool, th: &Theme) -> El {
    let t = &th.t;
    let base = row()
        .key(keys::quick_row_key(n))
        .role("option")
        .position_in_set(n + 1, total)
        .focus_selected(active)
        .w_full()
        .h(QUICK_ROW_H)
        .px(10.0)
        .gap(10.0)
        .center_y()
        .radius(th.k.radius.sm)
        .fill(if active { t.em_wash_2 } else { Color::TRANSPARENT })
        .on_hover(move |s: &mut State| s.quick_hover(n))
        .on_press_tx(move |s: &mut State, tx: &mut Tx| keys::quick_choose(s, n, tx));
    let aside = |words: String| text(words).font(th.ty.xs).color(t.tx_dim).a11y_hidden();
    match target {
        Target::Project(name) => {
            let project = s.projects.ready().and_then(|all| all.iter().find(|p| &p.name == name));
            let active_count = project.and_then(|p| p.counts.as_ref()).map(|c| c.active());
            let current = s.project.as_deref() == Some(name.as_str());
            let label = match active_count {
                Some(n) => format!("Project {name}, {n} active"),
                None => format!("Project {name}"),
            };
            let words = match (active_count, current) {
                (Some(n), true) => format!("{n} active · current project"),
                (Some(n), false) => format!("{n} active · project"),
                (None, true) => "current project".to_string(),
                (None, false) => "project".to_string(),
            };
            base.label(label)
                .child(el().size(7.0, 7.0).radius(1.5).fill(if current { t.em_500 } else { t.tx_mid }).a11y_hidden())
                .child(
                    text(name.clone())
                        .font(th.ty.sm_strong)
                        .color(t.tx_hi)
                        .truncate()
                        .grow(1.0)
                        .min_w(0.0)
                        .a11y_hidden(),
                )
                .child(aside(words))
        }
        Target::Issue(hit) => {
            let look = th.status(&hit.status);
            let status = hit.status.replace('_', " ");
            base.label(format!("{}, {status}: {}, in {}", hit.id, hit.title, hit.project))
                .child(bead(look).a11y_hidden())
                .child(text(hit.id.clone()).font(th.ty.xs).color(t.tx_dim).a11y_hidden())
                .child(
                    text(hit.title.clone())
                        .font(th.ty.sm)
                        .color(if hit.status == "closed" { t.tx_dim } else { t.tx_hi })
                        .truncate()
                        .grow(1.0)
                        .min_w(0.0)
                        .a11y_hidden(),
                )
                .child(aside(hit.project.clone()))
        }
    }
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

fn main_pane(s: &State, th: &Theme, roomy: bool, main_w: f32, layer: &mut Vec<El>) -> El {
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
        // The layout is chosen beside the filter: both say how the same
        // issues are shown, and this row has room at every window width.
        .child(row().w_full().gap(10.0).center_y().child(search.grow(1.0).min_w(0.0)).child(layout_toggle(s, th)));

    let board = s.layout == Layout::Board;
    let skeleton = || if board { board_skeleton(th, main_w) } else { table_skeleton(th, roomy) };
    let content = match &s.issues {
        Load::Ready(all) if all.is_empty() => {
            state(th, false, "No issues yet", &format!("Issues filed in {title} with bd appear here."), Vec::new())
        }
        Load::Ready(_) if s.visible.is_empty() => no_matches(s, th),
        Load::Ready(_) if board => issue_board(s, th, main_w),
        Load::Ready(_) => issue_table(s, th, roomy),
        Load::Failed(f) => failure_state(*f, busy(s), th),
        Load::Loading => skeleton(),
        // The project list is still on its way: the layout it will fill.
        Load::Idle if s.projects.ready().is_none() => skeleton(),
        Load::Idle => note(th, "Choose a project."),
    };

    col()
        .key("main")
        .grow(1.0)
        .min_w(0.0)
        .h_full()
        .child(toolbar)
        .child(status_tabs(s, th, roomy))
        .child(rule_h(th))
        // The table's cells pad themselves by 10, so this lines its text up
        // with the toolbar's 20. The board pads itself (`BOARD_PAD`), inside
        // its viewport, so its columns scroll to the pane's edge.
        .child(col().key("table-frame").w_full().grow(1.0).min_h(0.0).px(if board { 0.0 } else { 10.0 }).child(content))
}

/// Table or Board, as a two-segment control (the web project page's view
/// tabs). `v` is its key.
fn layout_toggle(s: &State, th: &Theme) -> El {
    let labels = Layout::ALL.map(Layout::label);
    SegmentedControl::new(&labels, Layout::ALL.iter().position(|l| *l == s.layout))
        .label("Show issues as")
        .fit()
        .on_pick(|s: &mut State, n, tx: &mut Tx| {
            if let Some(layout) = Layout::ALL.get(n) {
                keys::set_layout(s, *layout, tx);
            }
        })
        .build(&th.k)
        .key("layout")
        .help(format!("Switch between the table and the board ({})", keys::key_label("v")))
}

/// The status filter as a row of tabs, each with how many of the project's
/// issues it holds, so the filter also answers "how much is blocked?". The
/// selected tab takes the mark as an underline that sits on the rule below.
///
/// On the board the row also says the sort, when it has the room: cards
/// follow the same sort as the table's rows, and a board has no header to
/// show it in.
fn status_tabs(s: &State, th: &Theme, roomy: bool) -> El {
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
                .on_press(move |s: &mut State| s.set_status_filter(i))
                .child(words)
                .child(el().w_full().h(2.0).fill(if on { t.em_500 } else { Color::TRANSPARENT })),
        );
    }
    if let Some(sorted) = s.sort_label().filter(|_| roomy && s.layout == Layout::Board) {
        tabs = tabs.child(el().grow(1.0)).child(
            row().key("board-sort").h(30.0).px(10.0).center_y().child(text(sorted).font(th.ty.xs).color(t.tx_dim)),
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
    let sorted = s.table.sort().map(|(column, _)| column);
    let title_min = if sorted.is_some_and(|c| c != "title") { TITLE_MIN_W - SORT_ARROW_W } else { TITLE_MIN_W };
    let fixed = |id: &'static str, title: &'static str, w: f32, min: f32| {
        let w = if sorted == Some(id) { w + SORT_ARROW_W } else { w };
        TableColumn::new(id, title).width(w).min(min).sortable()
    };
    let mut table = Table::new(
        |s: &State| &s.table,
        |s: &mut State| &mut s.table,
        |s: &State| s.visible.len(),
        |s: &State, i| Cow::Borrowed(s.visible_issue(i).map_or("", |x| x.id.as_str())),
    )
    .name("Issues")
    .style(style)
    // Ids, priorities and dates are labels, not quantities: left-aligned.
    .column(fixed("id", "ID", 80.0, 56.0))
    .column(TableColumn::new("title", "Title").flex(3.0).min(title_min).sortable())
    .column(fixed("status", "Status", 108.0, 96.0))
    // Beside the status it qualifies: an open issue with a number here is
    // open but not ready.
    .column(fixed("blockers", "Blockers", BLOCKERS_W, 64.0))
    .column(fixed("priority", "Pri", 46.0, 44.0));
    if roomy {
        table = table.column(fixed("type", "Type", 72.0, 56.0)).column(fixed("assignee", "Assignee", 84.0, 64.0));
    }
    table
        .column(fixed("updated", "Updated", 76.0, 68.0))
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

// ---------------------------------------------------------------------------------------------
// Board

/// How wide each of `lanes` columns is in a pane `main_w` wide: an equal
/// share of it, within the bounds that keep a column a column. Narrower
/// than `LANE_MIN_W` each and the board scrolls sideways instead.
fn lane_width(main_w: f32, lanes: usize) -> f32 {
    let lanes = lanes.max(1) as f32;
    ((main_w - 2.0 * BOARD_PAD - LANE_GAP * (lanes - 1.0)) / lanes).clamp(LANE_MIN_W, LANE_MAX_W)
}

/// The issues by status: one column each for open, in progress, blocked and
/// closed (`State::lanes`), read left to right as work moves. It draws the
/// rows the table would, under the same filters and in the same order, and
/// shares the table's selection. Each column scrolls by itself and builds
/// only the cards in view (`El::virtual_rows`), so a project with thousands
/// of closed issues costs what its visible cards do.
///
/// Like the table it is one stop for the keyboard: the window's keys move
/// the selection (`keys::command`), and assistive technology follows the
/// selected card as the board's active descendant.
fn issue_board(s: &State, th: &Theme, main_w: f32) -> El {
    let width = lane_width(main_w, s.lanes.len());
    let th = Rc::new(th.clone());
    let mut lanes = row().key("lanes").h_full().px(BOARD_PAD).pt(10.0).pb(BOARD_PAD).gap(LANE_GAP);
    for n in 0..s.lanes.len() {
        lanes = lanes.child(lane(s, n, width, &th));
    }
    let mut board = row()
        .key(BOARD_KEY)
        .role("group")
        .label("Board")
        .focusable(true)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .scroll_x()
        .child(lanes);
    if let Some(id) = s.issue.as_deref().filter(|_| s.selected_card().is_some()) {
        board = board.active_descendant(id.to_string());
    }
    board
}

/// A column's heading: the status as the table writes it (bead and word)
/// and how many cards it holds.
fn lane_heading(label: &str, status: &str, count: Option<usize>, th: &Theme) -> El {
    let mut heading = row().w_full().h(32.0).px(10.0).gap(8.0).center_y().a11y_hidden();
    // The column for every other status has no one bead to wear.
    if !status.is_empty() {
        heading = heading.child(bead(th.status(status)));
    }
    heading = heading.child(text(label.to_string()).font(th.ty.sm_strong).color(th.t.tx_hi).truncate().min_w(0.0));
    match count {
        Some(n) => heading.child(text(n.to_string()).font(th.ty.xs).color(th.t.tx_dim)),
        None => heading,
    }
}

fn lane_frame(key: String, width: f32, th: &Theme) -> El {
    col().key(key).w(width).h_full().radius(th.k.radius.sm).fill(th.t.s2)
}

fn lane(s: &State, n: usize, width: f32, th: &Rc<Theme>) -> El {
    let lane = &s.lanes[n];
    let count = lane.rows.len();
    let name = match count {
        1 => format!("{}, 1 issue", lane.label),
        count => format!("{}, {count} issues", lane.label),
    };
    let frame = lane_frame(format!("lane-{}", lane.label), width, th).role("list").label(name).child(lane_heading(
        lane.label,
        lane.status,
        Some(count),
        th,
    ));
    if count == 0 {
        // The column stays, so the board keeps its shape as work moves.
        return frame.child(text("None").font(th.ty.xs).color(th.t.tx_dim).px(10.0).pt(2.0));
    }
    let look = th.clone();
    let cards = col().key("cards").w_full().px(6.0).growth(GrowthSpec::default()).virtual_rows(
        count,
        CARD_H,
        move |s: &State, i| Cow::Borrowed(s.lane_issue(n, i).map_or("", |issue| issue.id.as_str())),
        move |s: &State, i| match s.lane_issue(n, i) {
            Some(issue) => card(issue, s.issue.as_deref() == Some(issue.id.as_str()), &look),
            None => el(),
        },
    );
    frame.child(col().w_full().grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(cards))
}

/// A card's height before it is measured: two lines of title.
const CARD_H: f32 = 96.0;

/// One issue on the board, after the web app's `board-card.svelte`: the id
/// and when it last changed, the title, then what sorts it (priority, type,
/// labels) and what holds it up. It says nothing about its status: the
/// column does. A press selects it, as a click on a table row does, and a
/// double press reads it.
fn card(issue: &IssueSummary, selected: bool, th: &Theme) -> El {
    let t = &th.t;
    let closed = issue.status == "closed";
    let (id, open_id) = (issue.id.clone(), issue.id.clone());
    let top = row()
        .w_full()
        .gap(8.0)
        .center_y()
        .child(text(issue.id.clone()).font(th.ty.xs).color(t.tx_dim).truncate().grow(1.0).min_w(0.0))
        .child(
            text(short_date(issue.updated_at.get(..10).unwrap_or(&issue.updated_at))).font(th.ty.xs).color(t.tx_dim),
        );
    let mut chips = row()
        .w_full()
        .gap(6.0)
        .center_y()
        .flex_wrap()
        .child(text(format!("P{}", issue.priority)).font(th.ty.xs_strong).color(th.priority(issue.priority)))
        .child(text(issue.issue_type.clone()).font(th.ty.xs).color(if issue.issue_type == "epic" {
            t.violet_tx
        } else {
            t.tx_dim
        }));
    // Two labels, then how many more: a card is for scanning, and the
    // issue's pane lists them all.
    for label in issue.labels.iter().take(2) {
        chips = chips.child(tag(label, th));
    }
    if issue.labels.len() > 2 {
        chips = chips.child(text(format!("+{}", issue.labels.len() - 2)).font(th.ty.xs).color(t.tx_dim));
    }
    let mut body = col()
        .w_full()
        .padding(10.0)
        .gap(6.0)
        .a11y_hidden()
        .child(top)
        .child(
            text(issue.title.clone())
                .font(th.ty.sm)
                // Closed work recedes but stays readable and openable.
                .color(if closed { t.tx_dim } else { t.tx_hi })
                .max_lines(3),
        )
        .child(chips);
    // The last line appears only when there is something to say on it.
    let blocked = (issue.blocker_count > 0 && !closed).then(|| match issue.blocker_count {
        1 => "1 blocker".to_string(),
        n => format!("{n} blockers"),
    });
    if blocked.is_some() || issue.assignee.is_some() {
        let mut meta = row().w_full().gap(8.0).center_y();
        if let Some(blocked) = &blocked {
            meta = meta.child(text(blocked.clone()).font(th.ty.xs).color(t.amber_tx));
        }
        meta = meta.child(el().grow(1.0));
        if let Some(assignee) = &issue.assignee {
            meta = meta.child(text(assignee.clone()).font(th.ty.xs).color(t.tx_mid).truncate().min_w(0.0));
        }
        body = body.child(meta);
    }
    let mut label = format!("{}, P{}, {}: {}", issue.id, issue.priority, issue.issue_type, issue.title);
    if let Some(blocked) = blocked {
        label.push_str(&format!(", {blocked}"));
    }
    // The gap between cards is the row's own padding: virtual rows are
    // measured one by one, so a gap on their parent would not be counted.
    col().w_full().pb(6.0).child(
        col()
            .key(format!("card-{}", issue.id))
            .role("listitem")
            .label(label)
            .w_full()
            .radius(th.k.radius.sm)
            .fill(t.bg)
            .hover(th.k.c.hover)
            .on_press(move |s: &mut State| {
                s.pane = Pane::List;
                s.select_issue(&id);
            })
            .on_double_press_tx(move |s: &mut State, tx: &mut Tx| {
                s.select_issue(&open_id);
                keys::run(s, Command::Open, tx);
            })
            // `.tbl tr.is-selected`: the mark as a wash, and here as the
            // card's edge too, since cards are told apart by their edges.
            .child(
                el().absolute(0.0, 0.0)
                    .w_full()
                    .h_full()
                    .radius(th.k.radius.sm)
                    .fill(if selected { t.em_wash_2 } else { Color::TRANSPARENT })
                    .border(1.0, if selected { t.em_500 } else { t.line_2 })
                    .a11y_hidden(),
            )
            .child(body),
    )
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
        (Some(_), Load::Ready(Some(d))) => detail(d, s.web.is_some(), th),
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
    let mut pane = col().key("detail").w(if roomy { DETAIL_W.0 } else { DETAIL_W.1 }).h_full();
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

/// A small text button in the issue pane's header that runs `command`,
/// named for what it does with its key in the tooltip, as the trail's are.
fn issue_action(key: &'static str, words: &'static str, chord: &str, command: Command, th: &Theme) -> El {
    row()
        .key(key)
        .role("button")
        .label(words)
        .help(format!("{words} ({})", keys::key_label(chord)))
        .focusable(true)
        .focus_ring(2.0, 1.0, th.t.em_400)
        .h(22.0)
        .px(6.0)
        .center_y()
        .radius(th.k.radius.sm)
        .hover(th.k.c.hover)
        .on_press_tx(move |s: &mut State, tx: &mut Tx| keys::perform(s, command, tx))
        .child(text(words).font(th.ty.xs).color(th.t.tx_mid).a11y_hidden())
}

/// The issue's id and what can be done with it: copied, and, when the web
/// app's address is saved (`linked`), linked to and opened there. Secondary,
/// so quiet: words in the muted ink, a fill only under the pointer.
fn issue_actions(id: &str, linked: bool, th: &Theme) -> El {
    let mut actions = row().key("issue-actions").gap(2.0).center_y().child(issue_action(
        "copy-id",
        "Copy ID",
        "y",
        Command::CopyId,
        th,
    ));
    if linked {
        actions = actions
            .child(issue_action("copy-link", "Copy link", "⇧Y", Command::CopyLink, th))
            .child(issue_action("open-web", "Open in web", "⇧O", Command::OpenWeb, th));
    }
    row()
        .w_full()
        .gap(8.0)
        .center_y()
        .child(
            text(id.to_string())
                .font(th.ty.xs)
                .color(th.t.tx_dim)
                .selectable(true)
                .selection_color(th.k.selection())
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        )
        .child(actions)
}

fn detail(d: &IssueDetail, linked: bool, th: &Theme) -> El {
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

    let heading = col().key(keys::DETAIL_ANCHOR).gap(4.0).child(issue_actions(&i.id, linked, th)).child(
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
    for group in dep_groups(d) {
        body = body.child(section(group.heading, Some(group.refs.len()), th)).child(refs(&group, th));
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

fn refs(group: &DepGroup, th: &Theme) -> El {
    let t = &th.t;
    // Pulled out by the rows' own padding so their text lines up with the pane's.
    let mut list = col().w_full().gap(1.0).mx(-8.0);
    for r in &group.refs {
        let id = r.id.clone();
        let look = th.status(r.status.as_deref().unwrap_or(""));
        let title = r.title.clone().unwrap_or_else(|| "(not found)".into());
        let status = r.status.as_deref().unwrap_or("missing").replace('_', " ");
        // The heading names the link, except in the catch-all groups, where
        // each row says what it is.
        let kind = r.dep_type.as_deref().filter(|_| group.labelled);
        let label = match kind {
            Some(kind) => format!("{}, {status}, {kind}: {title}", r.id),
            None => format!("{}, {status}: {title}", r.id),
        };
        let mut link = row()
            .key(format!("{}-{}", group.key, r.id))
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

/// The board's four columns with a few cards outlined in each.
fn board_skeleton(th: &Theme, main_w: f32) -> El {
    let width = lane_width(main_w, crate::app::LANES.len());
    let card = |n: usize, title: f32| {
        col()
            .key(format!("card-{n}"))
            .w_full()
            .padding(10.0)
            .gap(10.0)
            .radius(th.k.radius.sm)
            .fill(th.t.bg)
            .child(bar(th, 40.0, 8.0))
            .child(row().w_full().child(flex_bar(th, title, 10.0)))
            .child(row().gap(6.0).child(bar(th, 18.0, 8.0)).child(bar(th, 40.0, 8.0)))
    };
    let mut lanes = row().w_full().h_full().px(BOARD_PAD).pt(10.0).pb(BOARD_PAD).gap(LANE_GAP);
    // Open work is usually the longest column and work in hand the shortest.
    for (n, cards) in [3, 1, 2, 3].into_iter().enumerate() {
        let mut list = col().w_full().px(6.0).gap(6.0);
        for c in 0..cards {
            list = list.child(card(c, RAGGED[(n * 3 + c) % RAGGED.len()]));
        }
        let heading = row().w_full().h(32.0).px(10.0).center_y().child(bar(th, 64.0, 8.0));
        lanes = lanes.child(lane_frame(format!("lane-{n}"), width, th).a11y_hidden().child(heading).child(list));
    }
    pending("issues-loading", "Loading issues").child(lanes)
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
