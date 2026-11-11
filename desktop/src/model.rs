//! Read-model types the desktop client shows. They mirror the web app's wire
//! types in `src/lib/types.ts`, trimmed to what the prototype draws.

/// Issue counts by lifecycle status, as `issueCounts` in
/// `src/lib/server/dolt/client.ts` computes them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Counts {
    pub open: u64,
    pub in_progress: u64,
    pub blocked: u64,
    pub closed: u64,
    pub total: u64,
}

impl Counts {
    /// Add `n` issues in `status`; unknown statuses count toward the total only.
    pub fn add(&mut self, status: &str, n: u64) {
        self.total += n;
        match status {
            "open" => self.open += n,
            "in_progress" => self.in_progress += n,
            "blocked" => self.blocked += n,
            "closed" => self.closed += n,
            _ => {}
        }
    }

    /// Issues that are not closed.
    pub fn active(&self) -> u64 {
        self.total - self.closed
    }
}

/// One Beads project: a user database on the Dolt server.
#[derive(Clone, Debug, PartialEq)]
pub struct Project {
    pub name: String,
    /// None when the summary query failed; the project still lists.
    pub counts: Option<Counts>,
    /// `MAX(updated_at)`, formatted for display.
    pub last_activity: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IssueSummary {
    pub id: String,
    pub title: String,
    pub status: String,
    pub priority: i64,
    pub issue_type: String,
    pub assignee: Option<String>,
    pub labels: Vec<String>,
    /// `YYYY-MM-DD HH:MM` in UTC (Dolt stores naive UTC datetimes).
    pub updated_at: String,
    pub dependency_count: u64,
    pub dependent_count: u64,
    pub comment_count: u64,
    /// How many issues still block this one: its `blocks` dependencies whose
    /// target is not closed, or is missing. A missing blocker counts, as it
    /// does in the web app's Ready query: nothing says that work is done.
    pub blocker_count: u64,
}

impl IssueSummary {
    /// Ready to be picked up: open, with nothing blocking it. The rule of
    /// `listReadyIssues` in `src/lib/server/dolt/client.ts` (the web app's
    /// Ready deck), applied to rows that already carry their blocker count.
    /// An issue someone has started, or one marked blocked by hand, is not
    /// ready whatever its dependencies say.
    pub fn is_ready(&self) -> bool {
        self.status == "open" && self.blocker_count == 0
    }
}

/// A related issue: a dependency or a dependent.
#[derive(Clone, Debug, PartialEq)]
pub struct IssueRef {
    pub id: String,
    pub title: Option<String>,
    pub status: Option<String>,
    pub dep_type: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Comment {
    pub author: String,
    pub text: String,
    pub created_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IssueDetail {
    pub summary: IssueSummary,
    pub description: Option<String>,
    pub design: Option<String>,
    pub acceptance_criteria: Option<String>,
    pub notes: Option<String>,
    pub created_by: Option<String>,
    pub created_at: Option<String>,
    /// Issues this one depends on.
    pub dependencies: Vec<IssueRef>,
    /// Issues that depend on this one.
    pub dependents: Vec<IssueRef>,
    pub comments: Vec<Comment>,
}

/// One heading's worth of the issue pane's dependency lists.
#[derive(Debug, PartialEq)]
pub struct DepGroup<'a> {
    /// What the linked issues are to this one, as a heading ("Blocked by").
    pub heading: &'static str,
    /// Key prefix for the group's rows, unique within the pane, so an issue
    /// linked twice (blocker and child, say) keeps a row under each heading.
    pub key: &'static str,
    /// Whether each row still names its own link type: only the catch-all
    /// groups, whose heading cannot say it.
    pub labelled: bool,
    pub refs: Vec<&'a IssueRef>,
}

/// The kinds of link the pane names, in Beads' vocabulary, as the web app's
/// `depLabel` (`src/lib/client/format.ts`) reads them.
#[derive(Clone, Copy, PartialEq)]
enum DepKind {
    Blocks,
    ParentChild,
    DiscoveredFrom,
    Related,
    Other,
}

fn dep_kind(dep_type: Option<&str>) -> DepKind {
    let key = dep_type.unwrap_or("").trim().to_ascii_lowercase().replace('_', "-");
    match key.as_str() {
        "blocks" => DepKind::Blocks,
        "parent-child" => DepKind::ParentChild,
        "discovered-from" => DepKind::DiscoveredFrom,
        "related" => DepKind::Related,
        _ => DepKind::Other,
    }
}

/// Group an issue's links by what they mean, so a `related` or `parent-child`
/// dependent never sits under "Blocks". `dependencies` are read upward (this
/// issue waits on, is a child of, was discovered from them) and `dependents`
/// downward, each heading in the web app's words for that direction. Related
/// links have no direction, so both ends share one heading. A type the pane
/// does not know keeps the plain direction as its heading and names itself
/// on each row. Empty groups are left out; the order puts what holds work
/// back first.
pub fn dep_groups(d: &IssueDetail) -> Vec<DepGroup<'_>> {
    use DepKind::*;
    let up = |kind: DepKind| d.dependencies.iter().filter(move |r| dep_kind(r.dep_type.as_deref()) == kind);
    let down = |kind: DepKind| d.dependents.iter().filter(move |r| dep_kind(r.dep_type.as_deref()) == kind);
    let groups = [
        ("Blocked by", "blocked-by", false, up(Blocks).collect::<Vec<_>>()),
        ("Blocks", "blocks", false, down(Blocks).collect()),
        ("Parent", "parent", false, up(ParentChild).collect()),
        ("Children", "child", false, down(ParentChild).collect()),
        ("Discovered from", "discovered-from", false, up(DiscoveredFrom).collect()),
        ("Discovered here", "discovered", false, down(DiscoveredFrom).collect()),
        ("Related", "related", false, up(Related).chain(down(Related)).collect()),
        ("Depends on", "depends-on", true, up(Other).collect()),
        ("Dependents", "dependents", true, down(Other).collect()),
    ];
    groups
        .into_iter()
        .filter(|(.., refs)| !refs.is_empty())
        .map(|(heading, key, labelled, refs)| DepGroup { heading, key, labelled, refs })
        .collect()
}

/// An issue quick open found, in whichever project holds it: enough to list
/// it and to go to it. The rest is read when it is opened.
#[derive(Clone, Debug, PartialEq)]
pub struct Hit {
    pub project: String,
    pub id: String,
    pub title: String,
    pub status: String,
}

/// Why a read failed. The same four sanitized classes as the web app
/// (ADR-0003, `DoltFailureKind`), plus "not configured". A failure never
/// carries a driver message: those can include hosts, user names or other
/// connection details.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    NotConfigured,
    CredentialUnavailable,
    AuthenticationRejected,
    Unreachable,
    Unknown,
}

impl Failure {
    /// A heading for the failure where it takes over a pane.
    pub fn title(self) -> &'static str {
        match self {
            Failure::NotConfigured => "No server configured",
            Failure::CredentialUnavailable => "No password for this server",
            Failure::AuthenticationRejected => "Sign-in rejected",
            Failure::Unreachable => "Server unreachable",
            Failure::Unknown => "Connection failed",
        }
    }

    /// Whether asking again could succeed with nothing changed in the
    /// settings. With no server configured it cannot, so that failure offers
    /// only connection settings. A missing password can: the Keychain may
    /// have been locked, or its prompt dismissed.
    pub fn retryable(self) -> bool {
        self != Failure::NotConfigured
    }

    pub fn message(self) -> &'static str {
        match self {
            Failure::NotConfigured => "No Dolt server is configured. Open connection settings to add one.",
            Failure::CredentialUnavailable => {
                "No password is available for this server. Enter it in connection settings, or set BEADS_DOLT_PASSWORD_FILE."
            }
            Failure::AuthenticationRejected => "Dolt authentication was rejected. Check the configured credentials.",
            Failure::Unreachable => "The Dolt server is unreachable. Check the host and port.",
            Failure::Unknown => "The Dolt connection failed.",
        }
    }
}

/// A read-only source of Beads data. Methods block; the app calls them on
/// Rune's worker threads, never on the UI thread.
pub trait Source: Send + Sync {
    fn projects(&self) -> Result<Vec<Project>, Failure>;
    fn issues(&self, database: &str) -> Result<Vec<IssueSummary>, Failure>;
    fn issue(&self, database: &str, id: &str) -> Result<Option<IssueDetail>, Failure>;
    /// Quick open's candidates: the issues in `databases` whose id or title
    /// holds the characters of `needle` (from `quick::needle`: lower-cased,
    /// not empty) in order, at most `quick::MAX_RESULTS` per database. The
    /// order is the source's; `quick::rank` decides what is shown first.
    fn search(&self, databases: &[String], needle: &str) -> Result<Vec<Hit>, Failure>;
    /// A short label for the status bar, never a secret.
    fn label(&self) -> String;
}

/// The source used when no Dolt server is configured: every read fails with
/// [`Failure::NotConfigured`].
pub struct Unconfigured;

impl Source for Unconfigured {
    fn projects(&self) -> Result<Vec<Project>, Failure> {
        Err(Failure::NotConfigured)
    }
    fn issues(&self, _: &str) -> Result<Vec<IssueSummary>, Failure> {
        Err(Failure::NotConfigured)
    }
    fn issue(&self, _: &str, _: &str) -> Result<Option<IssueDetail>, Failure> {
        Err(Failure::NotConfigured)
    }
    fn search(&self, _: &[String], _: &str) -> Result<Vec<Hit>, Failure> {
        Err(Failure::NotConfigured)
    }
    fn label(&self) -> String {
        "Not configured".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_track_known_statuses_and_total() {
        let mut c = Counts::default();
        c.add("open", 3);
        c.add("closed", 2);
        c.add("deferred", 1);
        assert_eq!((c.open, c.closed, c.total, c.active()), (3, 2, 6, 4));
    }
    #[test]
    fn dep_groups_split_links_by_type_and_direction() {
        let link = |id: &str, kind: Option<&str>| IssueRef {
            id: id.into(),
            title: None,
            status: None,
            dep_type: kind.map(Into::into),
        };
        let d = IssueDetail {
            summary: IssueSummary {
                id: "x-1".into(),
                title: String::new(),
                status: "open".into(),
                priority: 2,
                issue_type: "task".into(),
                assignee: None,
                labels: Vec::new(),
                updated_at: String::new(),
                dependency_count: 4,
                dependent_count: 3,
                comment_count: 0,
                blocker_count: 1,
            },
            description: None,
            design: None,
            acceptance_criteria: None,
            notes: None,
            created_by: None,
            created_at: None,
            dependencies: vec![
                link("x-2", Some("blocks")),
                link("x-3", Some("parent_child")),
                link("x-4", Some("related")),
                link("x-5", Some("waits-for")),
            ],
            dependents: vec![link("x-6", Some("Blocks")), link("x-7", Some("related")), link("x-8", None)],
            comments: Vec::new(),
        };
        let got: Vec<_> = dep_groups(&d)
            .into_iter()
            .map(|g| (g.heading, g.labelled, g.refs.iter().map(|r| r.id.as_str()).collect::<Vec<_>>()))
            .collect();
        assert_eq!(
            got,
            [
                ("Blocked by", false, vec!["x-2"]),
                ("Blocks", false, vec!["x-6"]),
                ("Parent", false, vec!["x-3"]),
                ("Related", false, vec!["x-4", "x-7"]),
                ("Depends on", true, vec!["x-5"]),
                ("Dependents", true, vec!["x-8"]),
            ]
        );
    }
}
