//! The Dolt read plane, ported from `src/lib/server/dolt/client.ts`.
//!
//! The same contract as the web app (ADR-0003): one configured server,
//! single parameterized `SELECT`/`SHOW` statements, a read-only session, and
//! failures reduced to fixed classes that carry no driver text. Configuration
//! comes from the same environment variables the web service reads.

use std::collections::HashMap;
use std::sync::OnceLock;

use mysql::prelude::Queryable;
use mysql::{Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, Row, Value};

use crate::model::{Comment, Counts, Failure, IssueDetail, IssueRef, IssueSummary, Project, Source};

const DEFAULT_PORT: u16 = 3306;
const DEFAULT_USER: &str = "root";
const SYSTEM_DATABASES: [&str; 4] = ["information_schema", "mysql", "performance_schema", "sys"];
const ISSUE_LIMIT: usize = 1000;

/// Connection settings, read from the process environment.
#[derive(Clone, Debug)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub user: String,
}

impl Config {
    /// `BEADS_DOLT_SERVER_HOST` (required), `BEADS_DOLT_SERVER_PORT` and
    /// `BEADS_DOLT_SERVER_USER`, with the web service's defaults.
    pub fn from_env() -> Option<Config> {
        Config::from_lookup(|k| std::env::var(k).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Option<Config> {
        let host = get("BEADS_DOLT_SERVER_HOST")?.trim().to_string();
        if host.is_empty() {
            return None;
        }
        let port = get("BEADS_DOLT_SERVER_PORT")
            .and_then(|p| p.trim().parse::<u16>().ok())
            .filter(|p| *p > 0)
            .unwrap_or(DEFAULT_PORT);
        let user = get("BEADS_DOLT_SERVER_USER").filter(|u| !u.is_empty()).unwrap_or_else(|| DEFAULT_USER.to_string());
        Some(Config { host, port, user })
    }
}

/// The password, as `resolveDoltPassword` in `src/lib/server/dolt-password.ts`
/// finds it: `BEADS_DOLT_PASSWORD_FILE` first, so a protected file is never
/// shadowed by a shell export, then `BEADS_DOLT_PASSWORD`. It goes only into
/// the driver's options, never into a URL, argv or log line.
pub fn resolve_password(
    get: impl Fn(&str) -> Option<String>,
    read_file: impl Fn(&str) -> std::io::Result<String>,
) -> Result<String, Failure> {
    if let Some(path) = get("BEADS_DOLT_PASSWORD_FILE") {
        if path.is_empty() {
            return Err(Failure::CredentialUnavailable);
        }
        let contents = read_file(&path).map_err(|_| Failure::CredentialUnavailable)?;
        let value = contents.strip_suffix('\n').unwrap_or(&contents);
        let value = value.strip_suffix('\r').unwrap_or(value);
        return if value.is_empty() { Err(Failure::CredentialUnavailable) } else { Ok(value.to_string()) };
    }
    match get("BEADS_DOLT_PASSWORD") {
        Some(v) if !v.is_empty() => Ok(v),
        _ => Err(Failure::CredentialUnavailable),
    }
}

/// True for a valid user database name (`DB_NAME_PATTERN` in the web app).
pub fn valid_database(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// True when a database is a Beads project rather than server plumbing.
pub fn is_user_database(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !SYSTEM_DATABASES.contains(&lower.as_str()) && !lower.starts_with("dolt_")
}

/// Backtick-quote a database name after validating it. Identifiers are
/// validated, never escaped ad hoc.
fn quote(database: &str) -> Result<String, Failure> {
    if valid_database(database) { Ok(format!("`{database}`")) } else { Err(Failure::Unknown) }
}

/// Reduce a driver error to a fixed class. Only codes are read, never
/// messages, which can hold hosts, user names or other connection details.
pub fn classify(error: &mysql::Error) -> Failure {
    match error {
        mysql::Error::MySqlError(e) if e.code == 1045 || e.state == "28000" => Failure::AuthenticationRejected,
        mysql::Error::IoError(_) => Failure::Unreachable,
        mysql::Error::DriverError(mysql::DriverError::ConnectTimeout | mysql::DriverError::CouldNotConnect(_)) => {
            Failure::Unreachable
        }
        _ => Failure::Unknown,
    }
}

/// A read-only client over one Dolt server. The pool connects lazily, on the
/// first read, so constructing it never blocks the UI thread.
pub struct Dolt {
    config: Config,
    pool: OnceLock<Pool>,
}

impl Dolt {
    pub fn new(config: Config) -> Dolt {
        Dolt { config, pool: OnceLock::new() }
    }

    fn pool(&self) -> Result<&Pool, Failure> {
        if let Some(pool) = self.pool.get() {
            return Ok(pool);
        }
        let password = resolve_password(|k| std::env::var(k).ok(), |p| std::fs::read_to_string(p))?;
        let constraints = PoolConstraints::new(0, 4).expect("0 <= 4");
        let opts = OptsBuilder::new()
            .ip_or_hostname(Some(self.config.host.clone()))
            .tcp_port(self.config.port)
            .user(Some(self.config.user.clone()))
            .pass(Some(password))
            .tcp_connect_timeout(Some(std::time::Duration::from_secs(5)))
            .pool_opts(PoolOpts::default().with_constraints(constraints));
        let pool = Pool::new(Opts::from(opts)).map_err(|e| classify(&e))?;
        Ok(self.pool.get_or_init(|| pool))
    }

    /// Run one statement in a read-only session.
    fn select(&self, sql: &str, params: Vec<Value>) -> Result<Vec<Row>, Failure> {
        let mut conn = self.pool()?.get_conn().map_err(|e| classify(&e))?;
        // The pool resets sessions between uses, so ask on every checkout.
        // Older servers may refuse; reads still work, as in the web client.
        let _ = conn.query_drop("SET SESSION TRANSACTION READ ONLY");
        let rows = if params.is_empty() { conn.query(sql) } else { conn.exec(sql, params) };
        rows.map_err(|e| classify(&e))
    }

    fn labels_for(&self, db: &str, ids: &[String]) -> Result<HashMap<String, Vec<String>>, Failure> {
        let mut out: HashMap<String, Vec<String>> = HashMap::new();
        if ids.is_empty() {
            return Ok(out);
        }
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!("SELECT issue_id, label FROM {db}.labels WHERE issue_id IN ({placeholders})");
        let params = ids.iter().map(|id| Value::from(id.as_str())).collect();
        for row in self.select(&sql, params)? {
            if let (Some(id), Some(label)) = (text(&row, "issue_id"), text(&row, "label")) {
                out.entry(id).or_default().push(label);
            }
        }
        for labels in out.values_mut() {
            labels.sort();
        }
        Ok(out)
    }

    fn refs(&self, sql: &str, id: &str) -> Result<Vec<IssueRef>, Failure> {
        let rows = self.select(sql, vec![Value::from(id)])?;
        Ok(rows
            .iter()
            .map(|r| IssueRef {
                id: text(r, "id").unwrap_or_default(),
                title: text(r, "title"),
                status: text(r, "status"),
                dep_type: text(r, "dep_type"),
            })
            .collect())
    }
}

impl Source for Dolt {
    fn projects(&self) -> Result<Vec<Project>, Failure> {
        let rows = self.select("SHOW DATABASES", vec![])?;
        let mut names: Vec<String> = rows
            .iter()
            .filter_map(|r| r.as_ref(0).and_then(value_text))
            .filter(|n| is_user_database(n) && valid_database(n))
            .collect();
        names.sort();
        // One project's summary failing must not hide the others.
        Ok(names
            .into_iter()
            .map(|name| {
                let db = quote(&name).ok();
                let counts = db.as_ref().and_then(|db| {
                    let rows = self
                        .select(&format!("SELECT status, COUNT(*) AS n FROM {db}.issues GROUP BY status"), vec![])
                        .ok()?;
                    let mut c = Counts::default();
                    for r in &rows {
                        c.add(&text(r, "status").unwrap_or_default(), number(r, "n").max(0) as u64);
                    }
                    Some(c)
                });
                let last_activity = db.as_ref().and_then(|db| {
                    let rows = self.select(&format!("SELECT MAX(updated_at) AS last FROM {db}.issues"), vec![]).ok()?;
                    rows.first().and_then(|r| text(r, "last")).map(|t| minutes(&t))
                });
                Project { name, counts, last_activity }
            })
            .collect())
    }

    fn issues(&self, database: &str) -> Result<Vec<IssueSummary>, Failure> {
        let db = quote(database)?;
        let sql = format!(
            "SELECT i.id, i.title, i.status, i.priority, i.issue_type, i.assignee, i.updated_at,
                    (SELECT COUNT(*) FROM {db}.dependencies d WHERE d.issue_id = i.id) AS dependency_count,
                    (SELECT COUNT(*) FROM {db}.dependencies d WHERE d.depends_on_issue_id = i.id) AS dependent_count,
                    (SELECT COUNT(*) FROM {db}.comments c WHERE c.issue_id = i.id) AS comment_count
             FROM {db}.issues i
             ORDER BY i.updated_at DESC
             LIMIT {ISSUE_LIMIT}"
        );
        let rows = self.select(&sql, vec![])?;
        let mut issues: Vec<IssueSummary> = rows.iter().map(summary).filter(|i| !i.id.is_empty()).collect();
        let ids: Vec<String> = issues.iter().map(|i| i.id.clone()).collect();
        let mut labels = self.labels_for(&db, &ids)?;
        for issue in &mut issues {
            issue.labels = labels.remove(&issue.id).unwrap_or_default();
        }
        Ok(issues)
    }

    fn issue(&self, database: &str, id: &str) -> Result<Option<IssueDetail>, Failure> {
        let db = quote(database)?;
        let sql = format!(
            "SELECT i.id, i.title, i.description, i.design, i.acceptance_criteria, i.notes,
                    i.status, i.priority, i.issue_type, i.assignee, i.created_at, i.created_by, i.updated_at,
                    (SELECT COUNT(*) FROM {db}.dependencies d WHERE d.issue_id = i.id) AS dependency_count,
                    (SELECT COUNT(*) FROM {db}.dependencies d WHERE d.depends_on_issue_id = i.id) AS dependent_count,
                    (SELECT COUNT(*) FROM {db}.comments c WHERE c.issue_id = i.id) AS comment_count
             FROM {db}.issues i WHERE i.id = ? LIMIT 1"
        );
        let rows = self.select(&sql, vec![Value::from(id)])?;
        let Some(row) = rows.first() else { return Ok(None) };
        let mut s = summary(row);
        s.labels = self.labels_for(&db, &[id.to_string()])?.remove(id).unwrap_or_default();
        let dependencies = self.refs(
            &format!(
                "SELECT d.depends_on_issue_id AS id, d.type AS dep_type, i.title, i.status
                 FROM {db}.dependencies d LEFT JOIN {db}.issues i ON i.id = d.depends_on_issue_id
                 WHERE d.issue_id = ? ORDER BY d.created_at DESC LIMIT {ISSUE_LIMIT}"
            ),
            id,
        )?;
        let dependents = self.refs(
            &format!(
                "SELECT d.issue_id AS id, d.type AS dep_type, i.title, i.status
                 FROM {db}.dependencies d LEFT JOIN {db}.issues i ON i.id = d.issue_id
                 WHERE d.depends_on_issue_id = ? ORDER BY d.created_at DESC LIMIT {ISSUE_LIMIT}"
            ),
            id,
        )?;
        let comments = self
            .select(
                &format!(
                    "SELECT author, text, created_at FROM {db}.comments
                     WHERE issue_id = ? ORDER BY created_at ASC LIMIT {ISSUE_LIMIT}"
                ),
                vec![Value::from(id)],
            )?
            .iter()
            .map(|r| Comment {
                author: text(r, "author").unwrap_or_else(|| "unknown".into()),
                text: text(r, "text").unwrap_or_default(),
                created_at: text(r, "created_at").map(|t| minutes(&t)),
            })
            .collect();
        Ok(Some(IssueDetail {
            summary: s,
            description: text(row, "description"),
            design: text(row, "design"),
            acceptance_criteria: text(row, "acceptance_criteria"),
            notes: text(row, "notes"),
            created_by: text(row, "created_by"),
            created_at: text(row, "created_at").map(|t| minutes(&t)),
            dependencies,
            dependents,
            comments,
        }))
    }

    fn label(&self) -> String {
        format!("Dolt {}:{}", self.config.host, self.config.port)
    }
}

fn summary(r: &Row) -> IssueSummary {
    IssueSummary {
        id: text(r, "id").unwrap_or_default(),
        title: text(r, "title").unwrap_or_default(),
        status: text(r, "status").unwrap_or_else(|| "open".into()),
        priority: number(r, "priority"),
        issue_type: text(r, "issue_type").unwrap_or_else(|| "task".into()),
        assignee: text(r, "assignee"),
        labels: Vec::new(),
        updated_at: text(r, "updated_at").map(|t| minutes(&t)).unwrap_or_default(),
        dependency_count: number(r, "dependency_count").max(0) as u64,
        dependent_count: number(r, "dependent_count").max(0) as u64,
        comment_count: number(r, "comment_count").max(0) as u64,
    }
}

/// A column as non-empty text. Dates come back as `Value::Date` from prepared
/// statements and as text from plain queries; both read as `YYYY-MM-DD HH:MM:SS`.
fn text(r: &Row, column: &str) -> Option<String> {
    r.as_ref(r.columns_ref().iter().position(|c| c.name_str() == column)?).and_then(value_text)
}

fn value_text(v: &Value) -> Option<String> {
    let s = match v {
        Value::NULL => return None,
        Value::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
        Value::Int(n) => n.to_string(),
        Value::UInt(n) => n.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Double(f) => f.to_string(),
        Value::Date(y, mo, d, h, mi, s, _) => format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}"),
        Value::Time(..) => return None,
    };
    if s.is_empty() { None } else { Some(s) }
}

fn number(r: &Row, column: &str) -> i64 {
    text(r, column).and_then(|t| t.parse::<f64>().ok()).map_or(0, |f| f as i64)
}

/// `2026-11-06 13:05:42` → `2026-11-06 13:05`.
fn minutes(t: &str) -> String {
    t.get(..16).unwrap_or(t).replace('T', " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn config_needs_a_host_and_keeps_the_web_defaults() {
        assert!(Config::from_lookup(env(&[])).is_none());
        assert!(Config::from_lookup(env(&[("BEADS_DOLT_SERVER_HOST", "  ")])).is_none());
        let c = Config::from_lookup(env(&[("BEADS_DOLT_SERVER_HOST", " db.example ")])).unwrap();
        assert_eq!((c.host.as_str(), c.port, c.user.as_str()), ("db.example", 3306, "root"));
        let c = Config::from_lookup(env(&[
            ("BEADS_DOLT_SERVER_HOST", "h"),
            ("BEADS_DOLT_SERVER_PORT", "13306"),
            ("BEADS_DOLT_SERVER_USER", "reader"),
        ]))
        .unwrap();
        assert_eq!((c.port, c.user.as_str()), (13306, "reader"));
    }

    #[test]
    fn the_password_file_wins_and_loses_one_line_ending() {
        let read = |_: &str| Ok("from-file\r\n".to_string());
        let got = resolve_password(env(&[("BEADS_DOLT_PASSWORD_FILE", "/p"), ("BEADS_DOLT_PASSWORD", "raw")]), read);
        assert_eq!(got.unwrap(), "from-file");
        let missing = |_: &str| Err(std::io::Error::other("no"));
        let got = resolve_password(env(&[("BEADS_DOLT_PASSWORD_FILE", "/p"), ("BEADS_DOLT_PASSWORD", "raw")]), missing);
        assert_eq!(got, Err(Failure::CredentialUnavailable), "an unreadable file never falls back");
        assert_eq!(resolve_password(env(&[("BEADS_DOLT_PASSWORD", "raw")]), missing).unwrap(), "raw");
        assert_eq!(resolve_password(env(&[]), missing), Err(Failure::CredentialUnavailable));
    }

    #[test]
    fn database_names_are_validated_and_plumbing_is_hidden() {
        assert!(valid_database("lighthouse_2"));
        assert!(!valid_database("Bad-Name") && !valid_database("") && !valid_database("a`b"));
        assert!(!is_user_database("mysql") && !is_user_database("dolt_cluster"));
        assert!(is_user_database("pantry"));
        assert_eq!(quote("x`; DROP"), Err(Failure::Unknown));
    }

    #[test]
    fn driver_errors_reduce_to_fixed_classes() {
        let io = mysql::Error::IoError(std::io::Error::other("connect to 10.0.0.1 failed"));
        assert_eq!(classify(&io), Failure::Unreachable);
        let denied = mysql::Error::MySqlError(mysql::MySqlError {
            state: "28000".into(),
            message: "Access denied for user 'secret'@'host'".into(),
            code: 1045,
        });
        assert_eq!(classify(&denied), Failure::AuthenticationRejected);
        assert_eq!(classify(&mysql::Error::DriverError(mysql::DriverError::ConnectTimeout)), Failure::Unreachable);
    }

    #[test]
    fn timestamps_trim_to_minutes() {
        assert_eq!(minutes("2026-11-06 13:05:42"), "2026-11-06 13:05");
        assert_eq!(value_text(&Value::Date(2026, 1, 2, 3, 4, 5, 0)).unwrap(), "2026-01-02 03:04:05");
        assert_eq!(value_text(&Value::NULL), None);
    }
}

/// Against a real server: `BEADS_DOLT_SERVER_HOST=… cargo test -- --ignored`.
/// The repository's quickstart (`quickstart/compose.yaml`) serves sample
/// projects to read.
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore = "needs a Dolt server"]
    fn reads_projects_issues_and_one_issue() {
        let dolt = Dolt::new(Config::from_env().expect("BEADS_DOLT_SERVER_HOST"));
        let projects = dolt.projects().expect("projects");
        assert!(!projects.is_empty(), "the server has projects");
        let p = &projects[0];
        assert!(p.counts.as_ref().is_some_and(|c| c.total > 0), "{p:?}");
        let issues = dolt.issues(&p.name).expect("issues");
        assert!(!issues.is_empty());
        let linked =
            issues.iter().find(|i| i.dependency_count + i.dependent_count + i.comment_count > 0).unwrap_or(&issues[0]);
        let d = dolt.issue(&p.name, &linked.id).expect("detail").expect("found");
        assert_eq!(d.summary.id, linked.id);
        assert_eq!(d.dependencies.len() as u64, linked.dependency_count);
        assert_eq!(d.comments.len() as u64, linked.comment_count);
        assert!(dolt.issue(&p.name, "no-such-issue").unwrap().is_none());
    }

    #[test]
    #[ignore = "needs a Dolt server"]
    fn a_wrong_password_is_rejected_without_detail() {
        let mut config = Config::from_env().expect("BEADS_DOLT_SERVER_HOST");
        config.user = "no_such_user_for_beadsmith".into();
        assert_eq!(Dolt::new(config).projects(), Err(Failure::AuthenticationRejected));
    }
}
