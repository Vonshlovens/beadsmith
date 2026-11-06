//! The window: projects on the left, the issue table in the middle, the
//! selected issue on the right. Layout follows the web app's project page
//! (`src/routes/p/[id]/+page.svelte`) in Rune's own components.

use std::borrow::Cow;

use rune::{Align, Color, Cx, El, ScrollSpec, Tx, col, el, row, text};
use rune_kit::{
    Badge, BadgeVariant, Button, ButtonVariant, Cell, Divider, Kit, Markdown, SegmentedControl, Spinner, Table,
    TableColumn, TextInput,
};

use crate::app::{Load, STATUS_FILTERS, State};
use crate::model::{IssueDetail, IssueRef, Project};

const SIDEBAR_W: f32 = 232.0;
const DETAIL_W: f32 = 400.0;

pub fn view(s: &State, cx: &mut Cx<State>) -> El {
    let k = Kit::neutral(cx.system_dark());
    let body = row()
        .key("shell")
        .w_full()
        .h_full()
        .fill(k.c.page)
        .child(sidebar(s, &k))
        .child(Divider::vertical().build(&k))
        .child(main_pane(s, &k))
        .child(Divider::vertical().build(&k))
        .child(detail_pane(s, &k));
    rune_kit::root(body, Vec::new())
}

// ---------------------------------------------------------------------------------------------
// Sidebar

fn sidebar(s: &State, k: &Kit) -> El {
    let header = col()
        .key("brand")
        .px(16.0)
        .pt(18.0)
        .pb(12.0)
        .gap(2.0)
        .child(text("Beadsmith").font(k.ty.body_medium).color(k.c.text_strong))
        .child(text("Desktop prototype").font(k.ty.text_xsmall).color(k.c.text_faint));

    let list = match &s.projects {
        Load::Ready(projects) if projects.is_empty() => note(k, "No projects on this server."),
        Load::Ready(projects) => {
            let mut list = col().key("projects").px(8.0).gap(2.0);
            for p in projects {
                list = list.child(project_row(p, s.project.as_deref() == Some(p.name.as_str()), k));
            }
            list.scroll(ScrollSpec { stick_bottom: false }).grow(1.0).min_h(0.0)
        }
        Load::Failed(f) => note(k, f.message()),
        Load::Idle | Load::Loading => loading(k, "Finding projects"),
    };

    let refresh = Button::new(if s.is_loading() { "Refreshing" } else { "Refresh" })
        .variant(if s.is_loading() { ButtonVariant::Loading } else { ButtonVariant::Ghost })
        .on_press(|s: &mut State| s.refresh())
        .build(k)
        .key("refresh");
    let footer = row()
        .key("connection")
        .px(16.0)
        .py(12.0)
        .gap(8.0)
        .center_y()
        .child(el().size(7.0, 7.0).radius(3.5).fill(connection_color(s, k)))
        .child(text(s.source.label()).font(k.ty.text_xsmall).color(k.c.text_muted).truncate().grow(1.0).min_w(0.0))
        .child(refresh);

    col()
        .key("sidebar")
        .w(SIDEBAR_W)
        .h_full()
        .fill(k.c.bg_base)
        .child(header)
        .child(col().w_full().grow(1.0).min_h(0.0).child(list))
        .child(Divider::horizontal().build(k))
        .child(footer)
}

fn project_row(p: &Project, selected: bool, k: &Kit) -> El {
    let name = p.name.clone();
    let counts = p.counts.as_ref();
    let active = counts.map_or(String::from("—"), |c| c.active().to_string());
    let sub = match (counts, &p.last_activity) {
        (Some(c), Some(at)) => format!(
            "{} open · {} blocked · {}",
            c.open + c.in_progress,
            c.blocked,
            short_date(at.get(..10).unwrap_or(at))
        ),
        (Some(c), None) => format!("{} open · {} blocked", c.open + c.in_progress, c.blocked),
        _ => "Summary unavailable".into(),
    };
    row()
        .key(format!("project-{}", p.name))
        .role("button")
        .label(p.name.clone())
        .focusable(true)
        .w_full()
        .px(10.0)
        .py(8.0)
        .gap(8.0)
        .center_y()
        .radius(k.radius.sm)
        .fill(if selected { k.c.surface_raised } else { Color::TRANSPARENT })
        .hover(k.c.hover)
        .on_press(move |s: &mut State| s.select_project(&name))
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .gap(2.0)
                .child(text(p.name.clone()).font(k.ty.ui_medium).color(k.c.text_strong).truncate())
                .child(text(sub).font(k.ty.text_xsmall).color(k.c.text_faint).truncate()),
        )
        .child(Badge::new(active).variant(if selected { BadgeVariant::Accent } else { BadgeVariant::Subtle }).build(k))
}

fn connection_color(s: &State, k: &Kit) -> Color {
    match s.projects {
        Load::Ready(_) => k.c.success.icon,
        Load::Failed(_) => k.c.danger.icon,
        _ => k.c.icon_faint,
    }
}

// ---------------------------------------------------------------------------------------------
// Issue table

fn main_pane(s: &State, k: &Kit) -> El {
    let title = match s.current_project() {
        Some(p) => p.name.clone(),
        None => s.project.clone().unwrap_or_else(|| "Issues".into()),
    };
    let count = match &s.issues {
        Load::Ready(all) if s.visible.len() == all.len() => format!("{} issues", all.len()),
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
        .build(k)
        .key("search");
    let labels: Vec<&str> = STATUS_FILTERS.iter().map(|(l, _)| *l).collect();
    let statuses = SegmentedControl::new(&labels, Some(s.status_filter))
        .label("Status")
        .fit()
        .on_pick(|s: &mut State, i, _: &mut Tx| {
            s.status_filter = i;
            s.refilter();
        })
        .build(k)
        .key("status-filter");

    let toolbar = col()
        .key("toolbar")
        .w_full()
        .px(20.0)
        .pt(16.0)
        .pb(12.0)
        .gap(12.0)
        .child(
            row()
                .w_full()
                .center_y()
                .gap(10.0)
                .child(text(title).font(k.ty.body_medium).color(k.c.text_strong))
                .child(text(count).font(k.ty.text_small).color(k.c.text_faint))
                .child(el().grow(1.0))
                .child(text("Read-only").font(k.ty.text_xsmall).color(k.c.text_faint)),
        )
        .child(search.w_full())
        .child(statuses);

    let content = match &s.issues {
        Load::Ready(_) if s.visible.is_empty() => note(k, "No issues match."),
        Load::Ready(_) => issue_table(s, k),
        Load::Failed(f) => note(k, f.message()),
        Load::Loading => loading(k, "Loading issues"),
        Load::Idle => note(k, if s.projects.ready().is_some() { "Choose a project." } else { "" }),
    };

    col().key("main").grow(1.0).min_w(0.0).h_full().child(toolbar).child(
        col().key("table-frame").w_full().grow(1.0).min_h(0.0).px(12.0).pb(12.0).child(
            col().w_full().h_full().radius(k.radius.md).fill(k.c.bg_base).clip_rounded(k.radius.md).child(content),
        ),
    )
}

fn issue_table(s: &State, k: &Kit) -> El {
    let kc = k.clone();
    Table::new(
        |s: &State| &s.table,
        |s: &mut State| &mut s.table,
        |s: &State| s.visible.len(),
        |s: &State, i| Cow::Borrowed(s.visible_issue(i).map_or("", |x| x.id.as_str())),
    )
    .name("Issues")
    .column(TableColumn::new("id", "ID").width(72.0).min(60.0).sortable())
    .column(TableColumn::new("title", "Title").flex(3.0).min(160.0).sortable())
    .column(TableColumn::new("status", "Status").width(104.0).min(90.0).sortable())
    .column(TableColumn::new("priority", "Pri").width(48.0).min(44.0).align(Align::Center).sortable())
    .column(TableColumn::new("type", "Type").width(72.0).min(56.0).sortable())
    .column(TableColumn::new("assignee", "Assignee").width(88.0).min(64.0).sortable())
    .column(TableColumn::new("updated", "Updated").width(104.0).min(88.0).sortable())
    .cell(move |s: &State, i, column| {
        let Some(issue) = s.visible_issue(i) else { return Cell::text("") };
        match column {
            "id" => Cell::text(&issue.id).mono().muted(),
            "title" => Cell::text(&issue.title),
            "status" => Cell::el(status_pill(&issue.status, &kc)),
            "priority" => Cell::text(format!("P{}", issue.priority)).mono().color(priority_color(issue.priority, &kc)),
            "type" => Cell::text(&issue.issue_type).muted(),
            "assignee" => Cell::text(issue.assignee.as_deref().unwrap_or("—")).muted(),
            _ => Cell::text(short_date(&issue.updated_at)).mono().muted(),
        }
    })
    .on_sort(|s: &mut State, column, dir, _| s.sort(column, dir))
    .on_select(|s: &mut State, id, _| s.select_issue(id))
    .on_open(|s: &mut State, id, _| s.select_issue(id))
    .zebra(true)
    .build(s, k)
    .key("issues")
    .grow(1.0)
    .min_h(0.0)
}

// ---------------------------------------------------------------------------------------------
// Detail

fn detail_pane(s: &State, k: &Kit) -> El {
    let inner = match (&s.issue, &s.detail) {
        (None, _) => note(k, "Select an issue to read it."),
        (Some(_), Load::Ready(Some(d))) => detail(d, k),
        (Some(id), Load::Ready(None)) => note(k, &format!("{id} is no longer on the server.")),
        (Some(_), Load::Failed(f)) => note(k, f.message()),
        (Some(_), _) => loading(k, "Loading issue"),
    };
    col().key("detail").w(DETAIL_W).h_full().fill(k.c.bg_base).child(inner)
}

fn detail(d: &IssueDetail, k: &Kit) -> El {
    let i = &d.summary;
    let mut meta = row().gap(6.0).center_y().wrap();
    meta = meta
        .child(status_pill(&i.status, k))
        .child(Badge::new(format!("P{}", i.priority)).build(k))
        .child(Badge::new(i.issue_type.clone()).variant(BadgeVariant::Subtle).build(k));
    for l in &i.labels {
        meta = meta.child(Badge::new(l.clone()).variant(BadgeVariant::Subtle).build(k));
    }

    let mut facts = col().gap(4.0);
    for (label, value) in [
        ("Assignee", i.assignee.clone()),
        ("Created", join_opt(&d.created_at, &d.created_by)),
        ("Updated", Some(short_date(&i.updated_at)).filter(|u| !u.is_empty())),
    ] {
        facts = facts.child(fact(label, value.as_deref().unwrap_or("—"), k));
    }

    let mut body = col()
        .key(format!("issue-{}", i.id))
        .w_full()
        .px(20.0)
        .py(18.0)
        .gap(14.0)
        .child(text(i.id.clone()).font(k.ty.mono).color(k.c.text_faint).selectable(true))
        .child(text(i.title.clone()).font(k.ty.body_medium).color(k.c.text_strong).wrap().selectable(true))
        .child(meta)
        .child(facts);

    for (heading, src) in [
        ("Description", &d.description),
        ("Design", &d.design),
        ("Acceptance criteria", &d.acceptance_criteria),
        ("Notes", &d.notes),
    ] {
        if let Some(src) = src {
            body = body.child(section(heading, k)).child(Markdown::new(src.clone()).selectable(true).build(k));
        }
    }
    if !d.dependencies.is_empty() {
        body = body.child(section("Depends on", k)).child(refs(&d.dependencies, "dep", k));
    }
    if !d.dependents.is_empty() {
        body = body.child(section("Blocks", k)).child(refs(&d.dependents, "blocks", k));
    }
    if !d.comments.is_empty() {
        body = body.child(section(&format!("Comments ({})", d.comments.len()), k));
        for (n, c) in d.comments.iter().enumerate() {
            let when = c.created_at.as_deref().map(short_date).unwrap_or_default();
            body = body.child(
                col()
                    .key(format!("comment-{n}"))
                    .w_full()
                    .gap(6.0)
                    .padding(12.0)
                    .radius(k.radius.sm)
                    .fill(k.c.surface_weak)
                    .child(
                        row()
                            .gap(8.0)
                            .child(text(c.author.clone()).font(k.ty.text_small_medium).color(k.c.text_base))
                            .child(text(when).font(k.ty.text_xsmall).color(k.c.text_faint)),
                    )
                    .child(Markdown::new(c.text.clone()).selectable(true).build(k)),
            );
        }
    }
    col().w_full().h_full().child(body.scroll(ScrollSpec { stick_bottom: false }).grow(1.0).min_h(0.0))
}

fn refs(items: &[IssueRef], prefix: &str, k: &Kit) -> El {
    let mut list = col().w_full().gap(2.0);
    for r in items {
        let id = r.id.clone();
        let status = r.status.as_deref().unwrap_or("missing");
        list = list.child(
            row()
                .key(format!("{prefix}-{}", r.id))
                .role("link")
                .label(r.id.clone())
                .focusable(true)
                .w_full()
                .px(8.0)
                .py(6.0)
                .gap(8.0)
                .center_y()
                .radius(k.radius.sm)
                .hover(k.c.hover)
                .on_press(move |s: &mut State| s.select_issue(&id))
                .child(el().size(7.0, 7.0).radius(3.5).fill(status_colors(status, k).0))
                .child(text(r.id.clone()).font(k.ty.mono).color(k.c.text_muted))
                .child(
                    text(r.title.clone().unwrap_or_else(|| "(not found)".into()))
                        .font(k.ty.text_small)
                        .color(k.c.text_base)
                        .truncate()
                        .grow(1.0)
                        .min_w(0.0),
                ),
        );
    }
    list
}

// ---------------------------------------------------------------------------------------------
// Pieces

fn section(title: &str, k: &Kit) -> El {
    text(title.to_string()).font(k.ty.text_xsmall_medium).color(k.c.text_faint).pt(6.0)
}

fn fact(label: &str, value: &str, k: &Kit) -> El {
    row()
        .gap(8.0)
        .child(text(label.to_string()).font(k.ty.text_small).color(k.c.text_faint).w(76.0))
        .child(text(value.to_string()).font(k.ty.text_small).color(k.c.text_base).truncate().grow(1.0).min_w(0.0))
}

fn status_pill(status: &str, k: &Kit) -> El {
    let (dot, ink) = status_colors(status, k);
    row()
        .gap(6.0)
        .center_y()
        .child(el().size(7.0, 7.0).radius(3.5).fill(dot))
        .child(text(status.replace('_', " ")).font(k.ty.text_small).color(ink))
}

/// Dot and label colours per lifecycle status.
fn status_colors(status: &str, k: &Kit) -> (Color, Color) {
    match status {
        "open" => (k.c.info.icon, k.c.text_base),
        "in_progress" => (k.c.warning.icon, k.c.text_base),
        "blocked" => (k.c.danger.icon, k.c.text_base),
        "closed" => (k.c.success.icon, k.c.text_faint),
        _ => (k.c.icon_faint, k.c.text_muted),
    }
}

fn priority_color(p: i64, k: &Kit) -> Color {
    match p {
        0 => k.c.danger.fg,
        1 => k.c.warning.fg,
        _ => k.c.text_muted,
    }
}

fn note(k: &Kit, message: &str) -> El {
    col()
        .key("note")
        .w_full()
        .h_full()
        .center()
        .padding(24.0)
        .child(text(message.to_string()).font(k.ty.text_small).color(k.c.text_muted).wrap().align(Align::Center))
}

fn loading(k: &Kit, message: &str) -> El {
    col()
        .key("loading")
        .w_full()
        .h_full()
        .center()
        .gap(10.0)
        .child(Spinner::new().build(k))
        .child(text(message.to_string()).font(k.ty.text_small).color(k.c.text_faint))
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
