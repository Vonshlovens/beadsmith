//! A built-in sample dataset, for `--sample`, the headless scenes and tests.
//! It needs no Dolt server and holds nothing real.

use crate::model::{Comment, Counts, Failure, Hit, IssueDetail, IssueRef, IssueSummary, Project, Source};
use crate::quick;

pub struct Sample;

struct Row {
    id: &'static str,
    title: &'static str,
    status: &'static str,
    priority: i64,
    kind: &'static str,
    assignee: Option<&'static str>,
    labels: &'static [&'static str],
    updated: &'static str,
}

#[allow(clippy::too_many_arguments)]
const fn row(
    id: &'static str,
    title: &'static str,
    status: &'static str,
    priority: i64,
    kind: &'static str,
    assignee: Option<&'static str>,
    labels: &'static [&'static str],
    updated: &'static str,
) -> Row {
    Row { id, title, status, priority, kind, assignee, labels, updated }
}

const LIGHTHOUSE: &[Row] = &[
    row(
        "lh-1",
        "Rotate the lamp on a schedule",
        "in_progress",
        1,
        "feature",
        Some("keeper"),
        &["lamp"],
        "2026-11-06 09:41",
    ),
    row(
        "lh-2",
        "Fog horn misses its first blast after a restart",
        "open",
        0,
        "bug",
        None,
        &["horn", "reliability"],
        "2026-11-06 08:12",
    ),
    row("lh-3", "Log every passing ship", "open", 2, "feature", Some("agent"), &["log"], "2026-11-05 17:30"),
    row("lh-4", "Replace the lens gasket", "blocked", 1, "task", Some("keeper"), &["maintenance"], "2026-11-05 11:02"),
    row("lh-5", "Order the gasket kit", "open", 1, "task", None, &["maintenance"], "2026-11-04 15:48"),
    row("lh-6", "Weather feed drops gusts above 60 knots", "open", 2, "bug", None, &["weather"], "2026-11-03 10:20"),
    row("lh-7", "Night mode for the control panel", "open", 3, "feature", None, &["ui"], "2026-11-02 19:05"),
    row("lh-8", "Paint the gallery railing", "closed", 3, "chore", Some("keeper"), &[], "2026-10-30 14:00"),
    row("lh-9", "Document the shift handover", "closed", 2, "task", Some("agent"), &["docs"], "2026-10-28 09:15"),
];

const PANTRY: &[Row] = &[
    row("pa-1", "Track what expires this week", "open", 1, "feature", None, &["inventory"], "2026-11-06 07:55"),
    row("pa-2", "Barcode scan reads 0 as O", "in_progress", 0, "bug", Some("agent"), &["scanner"], "2026-11-05 22:10"),
    row("pa-3", "Shopping list from the meal plan", "open", 2, "feature", None, &["planning"], "2026-11-04 12:00"),
    row("pa-4", "Import the old spreadsheet", "closed", 2, "task", Some("cook"), &[], "2026-10-29 18:40"),
];

fn rows(database: &str) -> Option<&'static [Row]> {
    match database {
        "lighthouse" => Some(LIGHTHOUSE),
        "pantry" => Some(PANTRY),
        _ => None,
    }
}

/// `(from, to, type)`: `from` depends on `to`. A `blocks` dependency holds
/// `from` back until `to` closes; other types only link the two. Between them
/// these cover every case Ready turns on: an open blocker (`lh-4`, `lh-1`,
/// and `lh-6`, which is open but not ready), a closed one (`lh-3` is ready
/// again), links that do not block (`lh-7`; `lh-5` is also `lh-4`'s child,
/// and `lh-6` was found while documenting `lh-9`), and a blocker that is not
/// in the project, which blocks because nothing says it is done (`pa-3`).
const DEPENDENCIES: &[(&str, &str, &str)] = &[
    ("lh-4", "lh-5", "blocks"),
    ("lh-1", "lh-4", "blocks"),
    ("lh-3", "lh-9", "blocks"),
    ("lh-6", "lh-2", "blocks"),
    ("lh-7", "lh-6", "related"),
    ("lh-5", "lh-4", "parent-child"),
    ("lh-6", "lh-9", "discovered-from"),
    ("pa-3", "pa-7", "blocks"),
];

fn find(id: &str) -> Option<&'static Row> {
    LIGHTHOUSE.iter().chain(PANTRY).find(|r| r.id == id)
}

fn summary(r: &Row) -> IssueSummary {
    IssueSummary {
        id: r.id.into(),
        title: r.title.into(),
        status: r.status.into(),
        priority: r.priority,
        issue_type: r.kind.into(),
        assignee: r.assignee.map(Into::into),
        labels: r.labels.iter().map(|l| l.to_string()).collect(),
        updated_at: r.updated.into(),
        dependency_count: DEPENDENCIES.iter().filter(|(from, ..)| *from == r.id).count() as u64,
        dependent_count: DEPENDENCIES.iter().filter(|(_, to, _)| *to == r.id).count() as u64,
        comment_count: comments(r.id).len() as u64,
        blocker_count: DEPENDENCIES
            .iter()
            .filter(|(from, to, kind)| {
                *from == r.id && *kind == "blocks" && find(to).is_none_or(|blocker| blocker.status != "closed")
            })
            .count() as u64,
    }
}

fn comments(id: &str) -> Vec<Comment> {
    match id {
        "lh-1" => vec![
            Comment {
                author: "keeper".into(),
                text: "The motor controller accepts a cron-style table. Starting with dusk to dawn.".into(),
                created_at: Some("2026-11-05 18:20".into()),
            },
            Comment {
                author: "agent".into(),
                text: "Blocked on `lh-4`: the gasket has to be in before the lamp can run all night.".into(),
                created_at: Some("2026-11-06 09:41".into()),
            },
        ],
        _ => Vec::new(),
    }
}

fn reference(id: &str, dep_type: &str) -> IssueRef {
    let found = find(id);
    IssueRef {
        id: id.into(),
        title: found.map(|r| r.title.into()),
        status: found.map(|r| r.status.into()),
        dep_type: Some(dep_type.into()),
    }
}

const LH1_DESCRIPTION: &str = "The lamp should turn itself on at dusk and off at dawn, \
following the published tables for the station's latitude.

## Plan

- Read sunrise and sunset from the almanac file
- Add a manual override that lasts until the next transition
- Show the next transition in the control panel

```toml
[schedule]
source = \"almanac\"
override_hours = 12
```";

impl Source for Sample {
    fn projects(&self) -> Result<Vec<Project>, Failure> {
        Ok(["lighthouse", "pantry"]
            .into_iter()
            .map(|name| {
                let all = rows(name).unwrap_or_default();
                let mut counts = Counts::default();
                for r in all {
                    counts.add(r.status, 1);
                }
                Project {
                    name: name.into(),
                    counts: Some(counts),
                    last_activity: all.iter().map(|r| r.updated).max().map(Into::into),
                }
            })
            .collect())
    }

    fn issues(&self, database: &str) -> Result<Vec<IssueSummary>, Failure> {
        Ok(rows(database).unwrap_or_default().iter().map(summary).collect())
    }

    fn issue(&self, database: &str, id: &str) -> Result<Option<IssueDetail>, Failure> {
        let Some(r) = rows(database).unwrap_or_default().iter().find(|r| r.id == id) else { return Ok(None) };
        let dependencies =
            DEPENDENCIES.iter().filter(|(from, ..)| *from == id).map(|(_, to, kind)| reference(to, kind)).collect();
        let dependents =
            DEPENDENCIES.iter().filter(|(_, to, _)| *to == id).map(|(from, _, kind)| reference(from, kind)).collect();
        let lh1 = id == "lh-1";
        Ok(Some(IssueDetail {
            summary: summary(r),
            description: Some(if lh1 { LH1_DESCRIPTION.into() } else { format!("{}.", r.title) }),
            design: None,
            acceptance_criteria: lh1
                .then(|| "- The lamp is on from dusk to dawn for a week without a manual start".into()),
            notes: None,
            created_by: Some("keeper".into()),
            created_at: Some("2026-10-20 08:00".into()),
            dependencies,
            dependents,
            comments: comments(id),
        }))
    }

    fn search(&self, databases: &[String], needle: &str) -> Result<Vec<Hit>, Failure> {
        let found = databases.iter().flat_map(|database| {
            let matching = rows(database).unwrap_or_default().iter().filter(|r| quick::matches(needle, r.id, r.title));
            matching.take(quick::MAX_RESULTS).map(move |r| Hit {
                project: database.clone(),
                id: r.id.into(),
                title: r.title.into(),
                status: r.status.into(),
            })
        });
        Ok(found.collect())
    }

    fn label(&self) -> String {
        "Sample data".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_projects_count_their_issues() {
        let projects = Sample.projects().unwrap();
        assert_eq!(projects.len(), 2);
        let lh = projects[0].counts.as_ref().unwrap();
        assert_eq!((lh.total, lh.closed, lh.blocked), (9, 2, 1));
    }

    #[test]
    fn sample_detail_links_both_ways() {
        let d = Sample.issue("lighthouse", "lh-4").unwrap().unwrap();
        assert_eq!(d.dependencies[0].id, "lh-5");
        assert_eq!(d.dependents[0].id, "lh-1");
        assert!(Sample.issue("lighthouse", "nope").unwrap().is_none());
    }

    #[test]
    fn sample_issues_cover_ready_and_blocked() {
        let issues = Sample.issues("lighthouse").unwrap();
        let of = |id: &str| issues.iter().find(|i| i.id == id).unwrap();
        let ready: Vec<_> = issues.iter().filter(|i| i.is_ready()).map(|i| i.id.as_str()).collect();
        assert_eq!(ready, ["lh-2", "lh-3", "lh-5", "lh-7"]);
        assert_eq!((of("lh-6").status.as_str(), of("lh-6").blocker_count), ("open", 1), "open, but not ready");
        assert_eq!((of("lh-3").dependency_count, of("lh-3").blocker_count), (1, 0), "a closed blocker lets go");
        assert_eq!((of("lh-7").dependency_count, of("lh-7").blocker_count), (1, 0), "a related link never blocks");
        assert_eq!(of("lh-1").blocker_count, 1, "counted on work in progress too");
        assert!(!of("lh-1").is_ready() && !of("lh-4").is_ready(), "only open issues are ready");

        let pantry = Sample.issues("pantry").unwrap();
        let pa3 = pantry.iter().find(|i| i.id == "pa-3").unwrap();
        assert_eq!(pa3.blocker_count, 1, "a blocker that is not in the project still blocks");
        let d = Sample.issue("pantry", "pa-3").unwrap().unwrap();
        assert_eq!((d.dependencies[0].id.as_str(), &d.dependencies[0].status), ("pa-7", &None));
    }
}
