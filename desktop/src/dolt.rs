//! The Dolt read plane, ported from `src/lib/server/dolt/client.ts`.
//!
//! The same contract as the web app (ADR-0003): one configured server,
//! single parameterized `SELECT`/`SHOW` statements, a read-only session, and
//! failures reduced to fixed classes that carry no driver text. Where the
//! connection settings and the password come from is in `settings.rs`.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use mysql::prelude::Queryable;
use mysql::{Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, Row, SslOpts, Value};

use crate::model::{Comment, Counts, Failure, Hit, IssueDetail, IssueRef, IssueSummary, Project, Source};
use crate::quick;
use crate::settings::{self, Lookup, SecretStore};

const SYSTEM_DATABASES: [&str; 4] = ["information_schema", "mysql", "performance_schema", "sys"];
const ISSUE_LIMIT: usize = 1000;

/// The per-issue counts both issue reads select, as subqueries of the one
/// statement: a list of a thousand issues costs no query per row.
///
/// `blocker_count` is the web app's Ready rule turned into a number. Its
/// `listReadyIssues` (`src/lib/server/dolt/client.ts`) keeps an open issue
/// when no row matches `d.type = 'blocks' AND (blocker.id IS NULL OR
/// blocker.status <> 'closed')`; this counts the rows of that same predicate,
/// so "ready" is `status = 'open'` with a count of zero
/// (`IssueSummary::is_ready`) and the table can also say how many.
///
/// The two `?` are bound by [`blocker_params`], ahead of any parameter in the
/// statement's `WHERE`.
fn count_columns(db: &str) -> String {
    format!(
        "(SELECT COUNT(*) FROM {db}.dependencies d WHERE d.issue_id = i.id) AS dependency_count,
         (SELECT COUNT(*) FROM {db}.dependencies d WHERE d.depends_on_issue_id = i.id) AS dependent_count,
         (SELECT COUNT(*) FROM {db}.comments c WHERE c.issue_id = i.id) AS comment_count,
         (SELECT COUNT(*) FROM {db}.dependencies d
            LEFT JOIN {db}.issues blocker ON blocker.id = d.depends_on_issue_id
           WHERE d.issue_id = i.id AND d.type = ?
             AND (blocker.id IS NULL OR blocker.status <> ?)) AS blocker_count"
    )
}

/// The values for the placeholders in [`count_columns`].
fn blocker_params() -> Vec<Value> {
    vec![Value::from("blocks"), Value::from("closed")]
}

/// How much of a `LIKE` pattern's text must sit together.
#[derive(Clone, Copy)]
enum Like {
    /// The text starts with the query.
    Prefix,
    /// The text holds the query in one piece.
    Contains,
    /// The text holds the query's characters in order, anything between them:
    /// the loose test `quick::score` applies to what comes back.
    InOrder,
}

/// A `LIKE` pattern for `needle`, always bound as a parameter. The query's
/// own `%`, `_` and `\` are escaped (backslash is `LIKE`'s default escape
/// character), so they match themselves and typing them cannot widen the
/// search.
fn like(needle: &str, shape: Like) -> String {
    let mut pattern = String::with_capacity(needle.len() * 3 + 2);
    if !matches!(shape, Like::Prefix) {
        pattern.push('%');
    }
    for c in needle.chars() {
        if matches!(c, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(c);
        if matches!(shape, Like::InOrder) {
            pattern.push('%');
        }
    }
    if !matches!(shape, Like::InOrder) {
        pattern.push('%');
    }
    pattern
}

/// The server to read and the account to read it as. Where these come from
/// (environment, settings file) is `settings.rs`'s business.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Require TLS, with the server's certificate checked against the
    /// system's trusted roots and its name against `host`. There is no
    /// switch to skip either check: a certificate the system does not trust
    /// is a failed connection, not a warning.
    pub tls: bool,
}

impl Config {
    /// True when the connection crosses a network in the clear: TLS is off
    /// and the host is not this machine. The window says so beside the
    /// server's name.
    pub fn unencrypted(&self) -> bool {
        !self.tls && !is_loopback(&self.host)
    }
}

/// True for a host that names this machine, so traffic to it never leaves
/// it: `localhost` (and a name under it) or a loopback address. Anything
/// else, including this machine's own LAN address, counts as a network.
pub fn is_loopback(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']').trim_end_matches('.');
    let lower = host.to_ascii_lowercase();
    lower == "localhost"
        || lower.ends_with(".localhost")
        || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// How a client gets its password. Deliberately not `Debug`.
#[derive(Clone)]
pub enum Credential {
    /// Typed into the connection form, for a test before anything is saved.
    Given(String),
    /// Looked up when the pool first connects: the environment, then the
    /// keychain (`settings::resolve_password`).
    Stored { lookup: Lookup, store: Arc<dyn SecretStore> },
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

/// Reduce a driver error to a fixed class. Only codes and variants are read,
/// never messages, which can hold hosts, user names, certificate subjects or
/// other connection details.
pub fn classify(error: &mysql::Error) -> Failure {
    match error {
        mysql::Error::MySqlError(e) if e.code == 1045 || e.state == "28000" => Failure::AuthenticationRejected,
        // The handshake failed: almost always a certificate the system does
        // not trust or one issued for another name. The platform's reason
        // is not read, so the class covers every handshake failure.
        mysql::Error::TlsError(_) => Failure::TlsRejected,
        mysql::Error::DriverError(mysql::DriverError::TlsNotSupported) => Failure::TlsUnsupported,
        mysql::Error::IoError(_) => Failure::Unreachable,
        mysql::Error::DriverError(mysql::DriverError::ConnectTimeout | mysql::DriverError::CouldNotConnect(_)) => {
            Failure::Unreachable
        }
        _ => Failure::Unknown,
    }
}

/// How the pool connects to `config`.
fn options(config: &Config, password: String) -> OptsBuilder {
    let constraints = PoolConstraints::new(0, 4).expect("0 <= 4");
    OptsBuilder::new()
        .ip_or_hostname(Some(config.host.clone()))
        .tcp_port(config.port)
        .user(Some(config.user.clone()))
        .pass(Some(password))
        .tcp_connect_timeout(Some(std::time::Duration::from_secs(5)))
        // The defaults verify the chain against the system's roots and the
        // certificate against the host name; see `Config::tls`.
        .ssl_opts(config.tls.then(SslOpts::default))
        .pool_opts(PoolOpts::default().with_constraints(constraints))
}

/// A read-only client over one Dolt server. The pool connects lazily, on the
/// first read, so constructing it never blocks the UI thread.
pub struct Dolt {
    config: Config,
    credential: Credential,
    /// The pool and the options it was built from, kept for
    /// [`Dolt::refused`]'s second attempt over TLS.
    pool: OnceLock<(Pool, Opts)>,
}

impl Dolt {
    pub fn new(config: Config, credential: Credential) -> Dolt {
        Dolt { config, credential, pool: OnceLock::new() }
    }

    /// Connect and count the projects this account can see: the connection
    /// form's "Test connection".
    pub fn probe(&self) -> Result<usize, Failure> {
        Ok(self.project_names()?.len())
    }

    fn project_names(&self) -> Result<Vec<String>, Failure> {
        let rows = self.select("SHOW DATABASES", vec![])?;
        let mut names: Vec<String> = rows
            .iter()
            .filter_map(|r| r.as_ref(0).and_then(value_text))
            .filter(|n| is_user_database(n) && valid_database(n))
            .collect();
        names.sort();
        Ok(names)
    }

    fn pool(&self) -> Result<&(Pool, Opts), Failure> {
        if let Some(pool) = self.pool.get() {
            return Ok(pool);
        }
        let password = match &self.credential {
            Credential::Given(password) => password.clone(),
            Credential::Stored { lookup, store } => {
                settings::resolve_password(lookup, |p| std::fs::read_to_string(p), store.as_ref(), &self.config)?
            }
        };
        let opts = Opts::from(options(&self.config, password));
        let pool = Pool::new(opts.clone()).map_err(|e| classify(&e))?;
        Ok(self.pool.get_or_init(|| (pool, opts)))
    }

    /// Classify a failure to connect, telling a server that refuses plain
    /// connections from any other generic error.
    ///
    /// Dolt with `require_secure_transport` answers a plain connection with
    /// error 1105 (`ER_UNKNOWN_ERROR`) before it reads the credentials, the
    /// same code it gives for many other faults, and its message is driver
    /// text this client never reads. So when TLS is off and the server
    /// answers 1105, ask once more over TLS, verified exactly as the
    /// "Use TLS" setting would be. If that handshake completes (it reads,
    /// or only the sign-in is refused) or the server at least offers a
    /// certificate, the server wants TLS and the settings can say so.
    /// Nothing is sent in the clear that the first attempt did not send, and
    /// the password goes out only after the certificate is verified.
    fn refused(&self, error: &mysql::Error, opts: &Opts) -> Failure {
        let failure = classify(error);
        let generic = matches!(error, mysql::Error::MySqlError(e) if e.code == 1105);
        if self.config.tls || !generic {
            return failure;
        }
        let secure = OptsBuilder::from_opts(opts.clone()).ssl_opts(Some(SslOpts::default()));
        match mysql::Conn::new(secure).map_err(|e| classify(&e)) {
            Ok(_) | Err(Failure::AuthenticationRejected | Failure::TlsRejected) => Failure::TlsRequired,
            Err(_) => failure,
        }
    }

    /// Run one statement in a read-only session.
    fn select(&self, sql: &str, params: Vec<Value>) -> Result<Vec<Row>, Failure> {
        let (pool, opts) = self.pool()?;
        let mut conn = pool.get_conn().map_err(|e| self.refused(&e, opts))?;
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
        // One project's summary failing must not hide the others.
        Ok(self
            .project_names()?
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
                    {counts}
             FROM {db}.issues i
             ORDER BY i.updated_at DESC
             LIMIT {ISSUE_LIMIT}",
            counts = count_columns(&db)
        );
        let rows = self.select(&sql, blocker_params())?;
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
                    {counts}
             FROM {db}.issues i WHERE i.id = ? LIMIT 1",
            counts = count_columns(&db)
        );
        let mut params = blocker_params();
        params.push(Value::from(id));
        let rows = self.select(&sql, params)?;
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

    /// One bounded statement per project: the server has no table that
    /// spans databases. The `WHERE` is the loose in-order match on the id or
    /// the title. Because only `quick::MAX_RESULTS` rows come back, the
    /// `ORDER BY` puts the closest first (the id itself, an id it starts,
    /// then the query in one piece) so a loose query that matches hundreds
    /// of titles still returns the issue whose id was typed. Ids and titles
    /// are lower-cased in the statement: Dolt's default collation tells case
    /// apart, and the needle is already lower-case.
    fn search(&self, databases: &[String], needle: &str) -> Result<Vec<Hit>, Failure> {
        let (mut hits, mut answered, mut failed) = (Vec::new(), false, None);
        for database in databases {
            let db = quote(database)?;
            let sql = format!(
                "SELECT i.id, i.title, i.status
                 FROM {db}.issues i
                 WHERE LOWER(i.id) LIKE ? OR LOWER(i.title) LIKE ?
                 ORDER BY LOWER(i.id) = ? DESC,
                          LOWER(i.id) LIKE ? DESC,
                          (LOWER(i.id) LIKE ? OR LOWER(i.title) LIKE ?) DESC,
                          i.updated_at DESC
                 LIMIT {limit}",
                limit = quick::MAX_RESULTS
            );
            let (loose, prefix, whole) =
                (like(needle, Like::InOrder), like(needle, Like::Prefix), like(needle, Like::Contains));
            let params: [&str; 6] = [&loose, &loose, needle, &prefix, &whole, &whole];
            match self.select(&sql, params.into_iter().map(Value::from).collect()) {
                Ok(rows) => {
                    answered = true;
                    hits.extend(rows.iter().filter_map(|r| {
                        Some(Hit {
                            project: database.clone(),
                            id: text(r, "id")?,
                            title: text(r, "title").unwrap_or_default(),
                            status: text(r, "status").unwrap_or_else(|| "open".into()),
                        })
                    }));
                }
                Err(failure) => failed = Some(failure),
            }
        }
        // One project failing must not hide the others' issues; a search
        // that no project answered is a failure.
        match failed {
            Some(failure) if !answered => Err(failure),
            _ => Ok(hits),
        }
    }

    fn label(&self) -> String {
        format!("Dolt {}:{}", self.config.host, self.config.port)
    }

    fn unencrypted(&self) -> bool {
        self.config.unencrypted()
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
        blocker_count: number(r, "blocker_count").max(0) as u64,
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
        let no_tls = mysql::Error::DriverError(mysql::DriverError::TlsNotSupported);
        assert_eq!(classify(&no_tls), Failure::TlsUnsupported);
        // `TlsError` holds a platform error that cannot be built here; the
        // ignored live test `tls_is_verified_and_failures_are_fixed_classes`
        // reaches it through a real handshake.
    }

    /// Only a plain connection the server answered with its generic 1105
    /// is asked again over TLS; when that second attempt cannot reach a TLS
    /// server, the failure stays generic. Port 1 on this machine refuses, so
    /// nothing leaves it. The ignored live test
    /// `tls_is_verified_and_failures_are_fixed_classes` sees `TlsRequired`.
    #[test]
    fn only_a_generic_refusal_is_asked_again_over_tls() {
        let generic = mysql::Error::MySqlError(mysql::MySqlError {
            state: "HY000".into(),
            message: "unknown error".into(),
            code: 1105,
        });
        let denied =
            mysql::Error::MySqlError(mysql::MySqlError { state: "28000".into(), message: String::new(), code: 1045 });
        for tls in [false, true] {
            let config = Config { host: "127.0.0.1".into(), port: 1, user: "reader".into(), tls };
            let opts = Opts::from(options(&config, String::new()));
            let dolt = Dolt::new(config, Credential::Given(String::new()));
            assert_eq!(dolt.refused(&generic, &opts), Failure::Unknown, "no TLS server answers: tls {tls}");
            assert_eq!(dolt.refused(&denied, &opts), Failure::AuthenticationRejected);
        }
    }

    #[test]
    fn only_this_machine_counts_as_loopback() {
        for host in ["localhost", "LOCALHOST", "db.localhost", "localhost.", "127.0.0.1", "127.8.0.1", "::1", "[::1]"] {
            assert!(is_loopback(host), "{host}");
        }
        for host in ["dolt.example", "10.0.0.5", "192.168.1.2", "0.0.0.0", "::", "localhost.example", "my-localhost"] {
            assert!(!is_loopback(host), "{host}");
        }
    }

    #[test]
    fn a_plain_connection_off_this_machine_is_unencrypted() {
        let config = |host: &str, tls: bool| Config { host: host.into(), port: 3306, user: "u".into(), tls };
        assert!(config("dolt.example", false).unencrypted());
        assert!(!config("dolt.example", true).unencrypted());
        assert!(!config("127.0.0.1", false).unencrypted(), "loopback never leaves the machine");
        let dolt = Dolt::new(config("10.0.0.5", false), Credential::Given(String::new()));
        assert!(Source::unencrypted(&dolt), "the window is told");
    }

    #[test]
    fn tls_asks_for_verified_tls_and_plain_asks_for_none() {
        let config = |tls: bool| Config { host: "dolt.example".into(), port: 3306, user: "u".into(), tls };
        let opts = |tls: bool| Opts::from(options(&config(tls), String::new()));
        let secure = opts(true);
        let ssl = secure.get_ssl_opts().expect("TLS is required");
        assert!(!ssl.accept_invalid_certs() && !ssl.skip_domain_validation(), "both checks stay on");
        assert!(opts(false).get_ssl_opts().is_none());
    }

    #[test]
    fn like_patterns_escape_what_was_typed() {
        assert_eq!(like("lh-4", Like::InOrder), "%l%h%-%4%");
        assert_eq!(like("lh-4", Like::Contains), "%lh-4%");
        assert_eq!(like("lh-4", Like::Prefix), "lh-4%");
        // Wildcards and the escape character match themselves.
        assert_eq!(like("50%_\\", Like::Contains), "%50\\%\\_\\\\%");
        assert_eq!(like("a_", Like::InOrder), "%a%\\_%");
    }

    #[test]
    fn timestamps_trim_to_minutes() {
        assert_eq!(minutes("2026-11-06 13:05:42"), "2026-11-06 13:05");
        assert_eq!(value_text(&Value::Date(2026, 1, 2, 3, 4, 5, 0)).unwrap(), "2026-01-02 03:04:05");
        assert_eq!(value_text(&Value::NULL), None);
    }
}

/// Against a real server: `BEADS_DOLT_SERVER_HOST=… cargo test -- --ignored reads rejected`.
/// The repository's quickstart (`quickstart/compose.yaml`) serves sample
/// projects to read.
#[cfg(test)]
mod live {
    use super::*;
    use crate::settings::{Backing, Env, NoStore};

    /// The server and password the environment names; no keychain.
    fn from_env(edit: impl FnOnce(&mut Config)) -> Dolt {
        let lookup = Backing::system().lookup;
        let mut config = Env::from_lookup(lookup).config(None).expect("BEADS_DOLT_SERVER_HOST");
        edit(&mut config);
        Dolt::new(config, Credential::Stored { lookup, store: Arc::new(NoStore) })
    }

    #[test]
    #[ignore = "needs a Dolt server"]
    fn reads_projects_issues_and_one_issue() {
        let dolt = from_env(|_| {});
        let projects = dolt.projects().expect("projects");
        assert!(!projects.is_empty(), "the server has projects");
        assert_eq!(dolt.probe(), Ok(projects.len()));
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
        assert_eq!(d.summary.blocker_count, linked.blocker_count, "the list and the issue count blockers alike");
        assert!(dolt.issue(&p.name, "no-such-issue").unwrap().is_none());
    }

    /// The web app's Ready statement (`listReadyIssues` in
    /// `src/lib/server/dolt/client.ts`), run as written, must pick the issues
    /// this client calls ready from its blocker counts.
    #[test]
    #[ignore = "needs a Dolt server"]
    fn ready_matches_the_web_apps_query() {
        let dolt = from_env(|_| {});
        let mut compared = 0;
        for p in dolt.projects().expect("projects") {
            let db = quote(&p.name).unwrap();
            let sql = format!(
                "SELECT i.id FROM {db}.issues i
                 WHERE i.status = ?
                   AND NOT EXISTS (
                     SELECT 1 FROM {db}.dependencies d
                     LEFT JOIN {db}.issues blocker ON blocker.id = d.depends_on_issue_id
                     WHERE d.issue_id = i.id
                       AND d.type = ?
                       AND (blocker.id IS NULL OR blocker.status <> ?)
                   )"
            );
            let params = vec![Value::from("open"), Value::from("blocks"), Value::from("closed")];
            let mut web: Vec<String> =
                dolt.select(&sql, params).expect("web query").iter().filter_map(|r| text(r, "id")).collect();
            let issues = dolt.issues(&p.name).expect("issues");
            assert!(issues.len() < ISSUE_LIMIT, "{}: the comparison needs the whole project", p.name);
            let mut ours: Vec<String> = issues.iter().filter(|i| i.is_ready()).map(|i| i.id.clone()).collect();
            web.sort();
            ours.sort();
            assert_eq!(ours, web, "{}", p.name);
            compared += issues.len();
        }
        assert!(compared > 0, "the server has issues to compare");
    }

    /// Quick open across every project on the server: an id typed in any
    /// case finds its issue first, wildcards are literal, and the server's
    /// candidates are exactly what `quick::score` would keep.
    #[test]
    #[ignore = "needs a Dolt server"]
    fn search_finds_issues_by_id_and_title_in_every_project() {
        let dolt = from_env(|_| {});
        let projects = dolt.projects().expect("projects");
        let names: Vec<String> = projects.iter().map(|p| p.name.clone()).collect();
        let mut searched = 0;
        for p in &projects {
            let issues = dolt.issues(&p.name).expect("issues");
            let Some(issue) = issues.last() else { continue };
            searched += 1;
            let hits = dolt.search(&names, &quick::needle(&issue.id.to_uppercase())).expect("search by id");
            let found = hits.iter().find(|h| h.project == p.name && h.id == issue.id).expect("the id finds its issue");
            assert_eq!((&found.title, &found.status), (&issue.title, &issue.status));
            let first = hits.iter().find(|h| h.project == p.name).unwrap();
            assert_eq!(first.id, issue.id, "the typed id leads its project's rows");

            // A word from a title, and the loose match against the whole project.
            let word = issue.title.split_whitespace().max_by_key(|w| w.len()).unwrap_or(&issue.title);
            let needle = quick::needle(word);
            let hits = dolt.search(std::slice::from_ref(&p.name), &needle).expect("search by title");
            assert!(hits.iter().any(|h| h.id == issue.id), "{word}");
            assert!(hits.len() <= quick::MAX_RESULTS);
            assert!(hits.iter().all(|h| quick::matches(&needle, &h.id, &h.title)), "only matches come back");
            let expected = issues.iter().filter(|i| quick::matches(&needle, &i.id, &i.title)).count();
            assert_eq!(hits.len(), expected.min(quick::MAX_RESULTS), "{word}: the server and the ranking agree");
        }
        assert!(searched > 0, "the server has issues to search");
        let literal = dolt.search(&names, "%").expect("a wildcard is searched for, not expanded");
        assert!(literal.iter().all(|h| h.id.contains('%') || h.title.contains('%')), "a wildcard is literal");
        assert_eq!(dolt.search(&["Bad-Name".into()], "x"), Err(Failure::Unknown));
    }

    /// TLS end to end, against two servers: the one the environment names,
    /// which must not offer TLS (the quickstart's does not), and one that
    /// does, on `BEADS_DOLT_TLS_PORT` of the same host, with a certificate
    /// for that host signed by the CA in the PEM file `BEADS_DOLT_TLS_CA`
    /// and `require_secure_transport: true` in its listener config.
    /// That CA is not in the system's trust store, so the app's own
    /// connection is refused as untrusted, and the same connection that
    /// also trusts the CA reads.
    #[test]
    #[ignore = "needs two Dolt servers, one with TLS"]
    fn tls_is_verified_and_failures_are_fixed_classes() {
        let plain = from_env(|c| c.tls = true);
        assert_eq!(plain.probe(), Err(Failure::TlsUnsupported), "a server without TLS is not read in the clear");

        let port: u16 = std::env::var("BEADS_DOLT_TLS_PORT").expect("BEADS_DOLT_TLS_PORT").parse().unwrap();
        let ca = std::env::var("BEADS_DOLT_TLS_CA").expect("BEADS_DOLT_TLS_CA");
        let secure = from_env(|c| {
            c.port = port;
            c.tls = true;
        });
        assert_eq!(secure.probe(), Err(Failure::TlsRejected), "a CA the system does not trust");

        let password = settings::resolve_password(
            Backing::system().lookup,
            |p| std::fs::read_to_string(p),
            &NoStore,
            &secure.config,
        )
        .expect("password");
        let trusting = options(&secure.config, password)
            .ssl_opts(SslOpts::default().with_root_cert_path(Some(std::path::PathBuf::from(ca.clone()))));
        let mut conn = mysql::Conn::new(trusting).expect("a verified TLS connection");
        assert_eq!(conn.query_first::<i64, _>("SELECT 1").expect("a read"), Some(1));
        // Dolt reports no `Ssl_*` status, so the proof the read above was
        // encrypted is that the server refuses one that is not.
        let plain = from_env(|c| c.port = port);
        assert_eq!(plain.probe(), Err(Failure::TlsRequired), "the TLS server refuses plain transport");
        // Dolt refuses before it reads the credentials, so a wrong password
        // reads the same, and settings point at TLS first.
        let stranger = from_env(|c| {
            c.port = port;
            c.user = "no_such_user_for_beadsmith".into();
        });
        assert_eq!(stranger.probe(), Err(Failure::TlsRequired));

        // The same server by another name: the certificate names only the
        // address the environment gave, so this must be refused.
        let other = if secure.config.host == "localhost" { "127.0.0.1" } else { "localhost" };
        let elsewhere = options(&Config { host: other.into(), ..secure.config.clone() }, String::new())
            .ssl_opts(SslOpts::default().with_root_cert_path(Some(std::path::PathBuf::from(ca))));
        let wrong_name = mysql::Conn::new(elsewhere).map(|_| ()).map_err(|e| classify(&e));
        assert_eq!(wrong_name, Err(Failure::TlsRejected), "a certificate for another name");
    }

    #[test]
    #[ignore = "needs a Dolt server"]
    fn a_wrong_password_is_rejected_without_detail() {
        let dolt = from_env(|c| c.user = "no_such_user_for_beadsmith".into());
        assert_eq!(dolt.probe(), Err(Failure::AuthenticationRejected));
    }
}
