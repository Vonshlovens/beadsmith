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
}
