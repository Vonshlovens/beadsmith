//! Where the connection comes from: the environment, a settings file and the
//! system keychain.
//!
//! An app launched from Finder has no shell environment, so the server's
//! host, port and user are kept in Rune's preferences file
//! (`prefs.json` under the OS config directory, on macOS
//! `~/Library/Application Support/Beadsmith`) and the password in the macOS
//! Keychain. The `BEADS_DOLT_*` variables the web service reads still win,
//! field by field, so a shell or a launcher can point one run elsewhere
//! without touching what is saved.
//!
//! The password is never written to the settings file. It is stored per
//! `user@host:port`, so a password saved for one server is never offered to
//! another: changing the host and leaving the password blank fails with
//! "credential unavailable" rather than sending the old secret somewhere new.

use std::sync::Arc;

use rune::prefs::{Prefs, PrefsError};

use crate::dolt::Config;
use crate::model::Failure;

/// The folder name under the OS config directory.
pub const APP_ID: &str = "Beadsmith";
pub const DEFAULT_PORT: u16 = 3306;
pub const DEFAULT_USER: &str = "root";

const HOST_KEY: &str = "dolt.host";
const PORT_KEY: &str = "dolt.port";
const USER_KEY: &str = "dolt.user";
/// `true` to require TLS; absent for a plain connection, which stays the
/// default because a stock Dolt server has no certificate configured.
const TLS_KEY: &str = "dolt.tls";
const REFRESH_KEY: &str = "refresh.seconds";

/// How often the window can re-read the server by itself: the choices the
/// toolbar offers, as seconds between reads, 0 for never. A fixed list
/// rather than a free number, so the control can always show the setting in
/// effect and no file can ask for a read every second.
pub const REFRESH_CHOICES: [(&str, u32); 5] =
    [("Auto off", 0), ("Auto 30 s", 30), ("Auto 1 min", 60), ("Auto 5 min", 300), ("Auto 15 min", 900)];
/// Often enough that a list left open is rarely wrong, and one small read a
/// minute is nothing to a server the web app polls harder.
pub const DEFAULT_REFRESH: u32 = 60;

/// The saved refresh interval. A missing file, a missing key or a value that
/// is not one of the choices is the default, without an error.
pub fn load_refresh(prefs: &Prefs) -> u32 {
    prefs
        .get::<u32>(REFRESH_KEY)
        .filter(|secs| REFRESH_CHOICES.iter().any(|(_, c)| c == secs))
        .unwrap_or(DEFAULT_REFRESH)
}

pub fn save_refresh(prefs: &mut Prefs, secs: u32) -> Result<(), PrefsError> {
    prefs.set(REFRESH_KEY, &secs)
}

/// Where the Beadsmith web app for this server is served, such as
/// `https://beads.example`: the base of the links "Copy Link" and "Open in
/// Beadsmith Web" make. Optional, because the desktop app reads Dolt
/// directly and needs no web app; without it those two actions are absent.
const WEB_KEY: &str = "web.url";

/// The window's content size in points when nothing is remembered, and the
/// smallest it goes: below that the table's columns no longer fit.
pub const DEFAULT_WINDOW: (f32, f32) = (1440.0, 880.0);
pub const MIN_WINDOW: (f32, f32) = (1100.0, 560.0);
/// Larger than any display: a size beyond it is a damaged file, not a window.
const MAX_WINDOW: f32 = 16384.0;

const WINDOW_KEY: &str = "window.size";
/// The window's top-left in points (`placement`), beside its size.
const POSITION_KEY: &str = "window.position";
const PROJECT_KEY: &str = "view.project";
const STATUS_KEY: &str = "view.status";
const SORT_KEY: &str = "view.sort";
const SORT_DESCENDING_KEY: &str = "view.sort_descending";
const LAYOUT_KEY: &str = "view.layout";
/// The web app's name for the same preference (`THEME_SETTING_KEY` in
/// `src/lib/client/theme.ts`), with the same three values.
const THEME_KEY: &str = "ui.theme";

/// The size the window was closed at, to open at again. A missing or
/// unusable value is the default; one smaller than the minimum is raised to
/// it, as the window itself would be.
pub fn load_window(prefs: &Prefs) -> (f32, f32) {
    match prefs.get::<(f32, f32)>(WINDOW_KEY) {
        Some((w, h)) if w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 => {
            (w.clamp(MIN_WINDOW.0, MAX_WINDOW), h.clamp(MIN_WINDOW.1, MAX_WINDOW))
        }
        _ => DEFAULT_WINDOW,
    }
}

pub fn save_window(prefs: &mut Prefs, size: (f32, f32)) -> Result<(), PrefsError> {
    if prefs.get::<(f32, f32)>(WINDOW_KEY) == Some(size) {
        return Ok(());
    }
    prefs.set(WINDOW_KEY, &size)
}

/// Where the window was closed, as `placement` keeps it: a top-left in
/// points. Whether it is still on a display is `placement::restore`'s call;
/// here only a value that is no point at all is dropped.
pub fn load_position(prefs: &Prefs) -> Option<(f64, f64)> {
    prefs.get::<(f64, f64)>(POSITION_KEY).filter(|(x, y)| x.is_finite() && y.is_finite())
}

pub fn save_position(prefs: &mut Prefs, origin: (f64, f64)) -> Result<(), PrefsError> {
    if prefs.get::<(f64, f64)>(POSITION_KEY) == Some(origin) {
        return Ok(());
    }
    prefs.set(POSITION_KEY, &origin)
}

/// What the window was showing, so the next launch opens on the same view:
/// the project, the status tab, the sort, the table-or-board layout and the
/// theme preference. The
/// values are kept as the names the app uses (a project's database, a tab's
/// label, a column's key) and are not checked here: the app drops a name it
/// no longer has, so a file from another version, or edited by hand, costs
/// only the memory of that one choice.
///
/// The filter text is left out on purpose: a list that opens already
/// narrowed by words typed last week reads as missing issues.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Session {
    pub project: Option<String>,
    pub status: Option<String>,
    /// The sorted column and whether it runs descending.
    pub sort: Option<(String, bool)>,
    /// How the issues are laid out (`app::Layout::name`); absent for the table.
    pub layout: Option<String>,
    /// `system`, `light` or `dark` (`theme::Appearance::name`).
    pub theme: Option<String>,
}

impl Session {
    pub fn load(prefs: &Prefs) -> Session {
        let text = |key: &str| prefs.get::<String>(key).filter(|v| !v.is_empty());
        Session {
            project: text(PROJECT_KEY),
            status: text(STATUS_KEY),
            sort: text(SORT_KEY).map(|column| (column, prefs.get::<bool>(SORT_DESCENDING_KEY).unwrap_or(false))),
            layout: text(LAYOUT_KEY),
            theme: text(THEME_KEY),
        }
    }

    /// Write what differs from the file. Every `Prefs::set` rewrites and
    /// syncs the whole file, and this runs on each change of view, so a
    /// change of one thing costs one write and no change costs none.
    pub fn save(&self, prefs: &mut Prefs) -> Result<(), PrefsError> {
        let old = Session::load(prefs);
        let mut put = |key: &str, was: Option<&String>, now: Option<&String>| match now {
            _ if was == now => Ok(()),
            Some(value) => prefs.set(key, value),
            None => prefs.remove(key),
        };
        put(PROJECT_KEY, old.project.as_ref(), self.project.as_ref())?;
        put(STATUS_KEY, old.status.as_ref(), self.status.as_ref())?;
        put(THEME_KEY, old.theme.as_ref(), self.theme.as_ref())?;
        put(LAYOUT_KEY, old.layout.as_ref(), self.layout.as_ref())?;
        put(SORT_KEY, old.sort.as_ref().map(|s| &s.0), self.sort.as_ref().map(|s| &s.0))?;
        match (old.sort.map(|s| s.1), self.sort.as_ref().map(|s| s.1)) {
            (was, now) if was == now => Ok(()),
            (_, Some(descending)) => prefs.set(SORT_DESCENDING_KEY, &descending),
            (_, None) => prefs.remove(SORT_DESCENDING_KEY),
        }
    }
}

/// The saved web address, already checked by `parse_web`. One that no
/// longer passes (a hand-edited file) is no address, so no link is ever made
/// from it.
pub fn load_web(prefs: &Prefs) -> Option<String> {
    prefs.get::<String>(WEB_KEY).and_then(|url| parse_web(&url).ok().flatten())
}

pub fn save_web(prefs: &mut Prefs, url: Option<&str>) -> Result<(), PrefsError> {
    match url {
        _ if prefs.get::<String>(WEB_KEY).as_deref() == url => Ok(()),
        Some(url) => prefs.set(WEB_KEY, &url.to_string()),
        None => prefs.remove(WEB_KEY),
    }
}

/// The web address as typed in the connection form: blank for none, else an
/// `http` or `https` address with a host and no query or fragment, kept
/// without its trailing slash so a route can be appended to it. A path is
/// allowed, for a web app served under one.
pub fn parse_web(text: &str) -> Result<Option<String>, FormError> {
    let url = text.trim().trim_end_matches('/');
    if url.is_empty() {
        return Ok(None);
    }
    let lower = url.to_ascii_lowercase();
    let rest = ["https://", "http://"]
        .iter()
        .find_map(|scheme| lower.starts_with(scheme).then(|| &url[scheme.len()..]))
        .ok_or(FormError::Web)?;
    let host = rest.split('/').next().unwrap_or_default();
    let bad = |c: char| c.is_whitespace() || c.is_control() || matches!(c, '?' | '#' | '"' | '<' | '>' | '\\');
    if host.is_empty() || host.starts_with(':') || rest.contains(bad) {
        return Err(FormError::Web);
    }
    Ok(Some(url.to_string()))
}

/// The connection the settings file holds. No password: see the module docs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stored {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub tls: bool,
}

impl Stored {
    /// None when no host is saved, or the file is missing or unreadable (Rune
    /// sets a file that does not parse aside and starts empty).
    pub fn load(prefs: &Prefs) -> Option<Stored> {
        let host = prefs.get::<String>(HOST_KEY)?.trim().to_string();
        if host.is_empty() {
            return None;
        }
        let port = prefs.get::<u16>(PORT_KEY).filter(|p| *p > 0).unwrap_or(DEFAULT_PORT);
        let user = prefs.get::<String>(USER_KEY).filter(|u| !u.is_empty()).unwrap_or_else(|| DEFAULT_USER.to_string());
        let tls = prefs.get::<bool>(TLS_KEY).unwrap_or(false);
        Some(Stored { host, port, user, tls })
    }

    /// The host goes last: it is what makes a saved connection exist, so a
    /// write that fails part-way leaves the previous connection or none.
    pub fn save(&self, prefs: &mut Prefs) -> Result<(), PrefsError> {
        prefs.set(PORT_KEY, &self.port)?;
        prefs.set(USER_KEY, &self.user)?;
        if self.tls {
            prefs.set(TLS_KEY, &true)?
        } else {
            prefs.remove(TLS_KEY)?
        }
        prefs.set(HOST_KEY, &self.host)
    }

    /// What the connection form holds, checked. An empty port or user takes
    /// the web service's default.
    pub fn parse(host: &str, port: &str, user: &str, tls: bool) -> Result<Stored, FormError> {
        let host = host.trim();
        if host.is_empty() || host.chars().any(char::is_whitespace) {
            return Err(FormError::Host);
        }
        let port = match port.trim() {
            "" => DEFAULT_PORT,
            p => p.parse::<u16>().ok().filter(|p| *p > 0).ok_or(FormError::Port)?,
        };
        let user = match user.trim() {
            "" => DEFAULT_USER,
            u => u,
        };
        Ok(Stored { host: host.to_string(), port, user: user.to_string(), tls })
    }

    pub fn config(&self) -> Config {
        Config { host: self.host.clone(), port: self.port, user: self.user.clone(), tls: self.tls }
    }
}

/// Why the connection form could not be saved. Like [`Failure`], these are
/// fixed messages: nothing from the OS or a driver is shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FormError {
    Host,
    Port,
    /// The web address is not an http or https address.
    Web,
    /// The keychain refused the password, or this platform has none.
    Keychain,
    /// The settings file could not be written.
    File,
}

impl FormError {
    pub fn message(self) -> &'static str {
        match self {
            FormError::Host => "Enter the server's host name or address.",
            FormError::Port => "The port must be a number from 1 to 65535.",
            FormError::Web => "The web address must start with http:// or https:// and name a host.",
            FormError::Keychain if cfg!(target_os = "macos") => "The password could not be saved to the Keychain.",
            FormError::Keychain => "This build cannot store a password. Set BEADS_DOLT_PASSWORD_FILE instead.",
            FormError::File => "The settings file could not be written.",
        }
    }
}

/// The `BEADS_DOLT_*` overrides present at launch. Read once, so the
/// connection screen can show which fields the environment owns.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Env {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    /// A password variable is set; its value is read only when connecting.
    pub password: bool,
}

impl Env {
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Env {
        Env {
            host: get("BEADS_DOLT_SERVER_HOST").map(|h| h.trim().to_string()).filter(|h| !h.is_empty()),
            port: get("BEADS_DOLT_SERVER_PORT").and_then(|p| p.trim().parse::<u16>().ok()).filter(|p| *p > 0),
            user: get("BEADS_DOLT_SERVER_USER").filter(|u| !u.is_empty()),
            password: get("BEADS_DOLT_PASSWORD_FILE").is_some()
                || get("BEADS_DOLT_PASSWORD").is_some_and(|p| !p.is_empty()),
        }
    }

    /// The connection to use: each field from the environment when it is set
    /// there, else from the settings file, else the web service's default.
    /// None without a host from either. TLS has no variable (the web
    /// service's Dolt client has no TLS setting to mirror), so it is always
    /// the saved choice, off when nothing is saved.
    pub fn config(&self, stored: Option<&Stored>) -> Option<Config> {
        let host = self.host.clone().or_else(|| stored.map(|s| s.host.clone()))?;
        let port = self.port.or(stored.map(|s| s.port)).unwrap_or(DEFAULT_PORT);
        let user = self.user.clone().or_else(|| stored.map(|s| s.user.clone())).unwrap_or_else(|| DEFAULT_USER.into());
        Some(Config { host, port, user, tls: stored.is_some_and(|s| s.tls) })
    }
}

/// The keychain could not be read or written. Carries nothing: OS error text
/// can name accounts and paths.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoreError;

/// A place for the Dolt password, keyed by [`account`]. Calls can block (the
/// Keychain may ask the user), so they run on workers, never the UI thread.
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, StoreError>;
    fn set(&self, account: &str, password: &str) -> Result<(), StoreError>;
}

/// The keychain account for a connection.
pub fn account(config: &Config) -> String {
    format!("{}@{}:{}", config.user, config.host, config.port)
}

/// A store that holds nothing and refuses writes: platforms without a
/// keychain binding, and headless runs, which must not touch the user's.
pub struct NoStore;

impl SecretStore for NoStore {
    fn get(&self, _: &str) -> Result<Option<String>, StoreError> {
        Ok(None)
    }
    fn set(&self, _: &str, _: &str) -> Result<(), StoreError> {
        Err(StoreError)
    }
}

/// The macOS login keychain: one generic-password item per account under
/// this service name, visible in Keychain Access as "Beadsmith Dolt".
#[cfg(target_os = "macos")]
pub struct Keychain {
    service: &'static str,
}

#[cfg(target_os = "macos")]
impl Keychain {
    pub const SERVICE: &'static str = "Beadsmith Dolt";
    /// `errSecItemNotFound`.
    const NOT_FOUND: i32 = -25300;
}

#[cfg(target_os = "macos")]
impl SecretStore for Keychain {
    fn get(&self, account: &str) -> Result<Option<String>, StoreError> {
        match security_framework::passwords::get_generic_password(self.service, account) {
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| StoreError),
            Err(e) if e.code() == Self::NOT_FOUND => Ok(None),
            Err(_) => Err(StoreError),
        }
    }
    fn set(&self, account: &str, password: &str) -> Result<(), StoreError> {
        security_framework::passwords::set_generic_password(self.service, account, password.as_bytes())
            .map_err(|_| StoreError)
    }
}

/// The password store for this platform.
pub fn system_store() -> Arc<dyn SecretStore> {
    #[cfg(target_os = "macos")]
    return Arc::new(Keychain { service: Keychain::SERVICE });
    #[cfg(not(target_os = "macos"))]
    Arc::new(NoStore)
}

/// The password, in the web service's order (`resolveDoltPassword` in
/// `src/lib/server/dolt-password.ts`) with the keychain last:
/// `BEADS_DOLT_PASSWORD_FILE` first, so a protected file is never shadowed by
/// a shell export, then `BEADS_DOLT_PASSWORD`, then the saved password for
/// this exact account. It goes only into the driver's options, never into a
/// URL, argv, file or log line.
pub fn resolve_password(
    get: impl Fn(&str) -> Option<String>,
    read_file: impl Fn(&str) -> std::io::Result<String>,
    store: &dyn SecretStore,
    config: &Config,
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
    if let Some(value) = get("BEADS_DOLT_PASSWORD").filter(|v| !v.is_empty()) {
        return Ok(value);
    }
    match store.get(&account(config)) {
        Ok(Some(value)) if !value.is_empty() => Ok(value),
        _ => Err(Failure::CredentialUnavailable),
    }
}

/// How environment variables are read: the process's, or none at all.
pub type Lookup = fn(&str) -> Option<String>;

/// What a launch reads its connection from. A headless or test run gets
/// [`Backing::detached`], so it never depends on, or changes, the machine's
/// environment, settings and keychain.
pub struct Backing {
    /// Reads the password variables when a connection opens.
    pub lookup: Lookup,
    pub env: Env,
    pub prefs: Prefs,
    pub secrets: Arc<dyn SecretStore>,
}

impl Backing {
    pub fn system() -> Backing {
        let lookup: Lookup = |k| std::env::var(k).ok();
        Backing { lookup, env: Env::from_lookup(lookup), prefs: Prefs::open(APP_ID), secrets: system_store() }
    }

    pub fn detached() -> Backing {
        Backing { lookup: |_| None, env: Env::default(), prefs: Prefs::memory(), secrets: Arc::new(NoStore) }
    }
}

/// A keychain stand-in for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore(std::sync::Mutex<std::collections::HashMap<String, String>>);

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, StoreError> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, password: &str) -> Result<(), StoreError> {
        self.0.lock().unwrap().insert(account.to_string(), password.to_string());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }

    fn stored() -> Stored {
        Stored { host: "db.example".into(), port: 13306, user: "reader".into(), tls: false }
    }

    /// A settings file in a fresh folder under the system temp directory.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("beadsmith-desktop-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("prefs.json")
    }

    #[test]
    fn a_web_address_is_http_with_a_host_and_loses_its_trailing_slash() {
        assert_eq!(parse_web("  "), Ok(None));
        assert_eq!(parse_web(" https://beads.example/ "), Ok(Some("https://beads.example".into())));
        assert_eq!(parse_web("HTTP://127.0.0.1:5173"), Ok(Some("HTTP://127.0.0.1:5173".into())));
        assert_eq!(parse_web("https://host.example/beads//"), Ok(Some("https://host.example/beads".into())));
        for bad in [
            "beads.example",
            "ftp://beads.example",
            "javascript:alert(1)",
            "https://",
            "https:///p",
            "https://:80",
            "https://beads example",
            "https://beads.example/?q=1",
            "https://beads.example/#top",
        ] {
            assert_eq!(parse_web(bad), Err(FormError::Web), "{bad}");
        }
    }

    #[test]
    fn the_web_address_round_trips_and_a_damaged_one_is_none() {
        let mut prefs = Prefs::memory();
        assert_eq!(load_web(&prefs), None);
        save_web(&mut prefs, Some("https://beads.example")).unwrap();
        assert_eq!(load_web(&prefs).as_deref(), Some("https://beads.example"));
        save_web(&mut prefs, None).unwrap();
        assert_eq!(load_web(&prefs), None);
        prefs.set(WEB_KEY, &"file:///etc/passwd".to_string()).unwrap();
        assert_eq!(load_web(&prefs), None, "a hand-edited file cannot make a link of another scheme");
    }

    #[test]
    fn the_environment_needs_a_host_and_keeps_the_web_defaults() {
        assert!(Env::from_lookup(env(&[])).config(None).is_none());
        assert!(Env::from_lookup(env(&[("BEADS_DOLT_SERVER_HOST", "  ")])).config(None).is_none());
        let c = Env::from_lookup(env(&[("BEADS_DOLT_SERVER_HOST", " db.example ")])).config(None).unwrap();
        assert_eq!((c.host.as_str(), c.port, c.user.as_str(), c.tls), ("db.example", 3306, "root", false));
    }

    #[test]
    fn the_environment_overrides_the_file_field_by_field() {
        let file = stored();
        let none = Env::default();
        assert_eq!(none.config(Some(&file)), Some(file.config()), "no variables: the file as saved");

        let port_only = Env::from_lookup(env(&[("BEADS_DOLT_SERVER_PORT", "3307")]));
        let c = port_only.config(Some(&file)).unwrap();
        assert_eq!((c.host.as_str(), c.port, c.user.as_str()), ("db.example", 3307, "reader"));

        let all = Env::from_lookup(env(&[
            ("BEADS_DOLT_SERVER_HOST", "other"),
            ("BEADS_DOLT_SERVER_PORT", "1"),
            ("BEADS_DOLT_SERVER_USER", "u"),
        ]));
        let c = all.config(Some(&file)).unwrap();
        assert_eq!((c.host.as_str(), c.port, c.user.as_str()), ("other", 1, "u"));
        let secure = Stored { tls: true, ..stored() };
        assert!(all.config(Some(&secure)).unwrap().tls, "TLS has no variable: the saved choice holds");

        let bad_port = Env::from_lookup(env(&[("BEADS_DOLT_SERVER_PORT", "0")]));
        assert_eq!(bad_port.config(Some(&file)).unwrap().port, 13306, "an unusable override is ignored");
    }

    #[test]
    fn the_environment_reports_a_password_without_holding_it() {
        assert!(!Env::from_lookup(env(&[("BEADS_DOLT_PASSWORD", "")])).password);
        assert!(Env::from_lookup(env(&[("BEADS_DOLT_PASSWORD", "raw")])).password);
        let e = Env::from_lookup(env(&[("BEADS_DOLT_PASSWORD_FILE", "/p")]));
        assert!(e.password);
        assert!(!format!("{e:?}").contains("/p"));
    }

    #[test]
    fn settings_round_trip_through_the_file_without_a_password() {
        let path = scratch("round-trip");
        assert_eq!(Stored::load(&Prefs::at(&path)), None, "a missing file is no connection");
        let mut prefs = Prefs::at(&path);
        stored().save(&mut prefs).unwrap();
        assert_eq!(Stored::load(&Prefs::at(&path)), Some(stored()), "a second open reads it back");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("db.example") && !text.to_lowercase().contains("password"), "{text}");
        assert!(!text.contains("dolt.tls"), "a plain connection writes no TLS key: {text}");

        let secure = Stored { tls: true, ..stored() };
        secure.save(&mut prefs).unwrap();
        assert_eq!(Stored::load(&Prefs::at(&path)), Some(secure));
        stored().save(&mut prefs).unwrap();
        assert_eq!(Stored::load(&Prefs::at(&path)), Some(stored()), "turning TLS off removes the key");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_corrupt_or_partial_file_is_no_connection() {
        let path = scratch("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(Stored::load(&Prefs::at(&path)), None);
        std::fs::write(&path, r#"{"dolt.host":"h","dolt.port":"many","dolt.user":"","dolt.tls":"yes"}"#).unwrap();
        let s = Stored::load(&Prefs::at(&path)).unwrap();
        assert_eq!(
            (s.port, s.user.as_str(), s.tls),
            (DEFAULT_PORT, DEFAULT_USER, false),
            "bad fields fall back to defaults"
        );
        std::fs::write(&path, r#"{"dolt.port":3306}"#).unwrap();
        assert_eq!(Stored::load(&Prefs::at(&path)), None, "no host, no connection");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn the_refresh_interval_round_trips_and_falls_back_to_the_default() {
        let path = scratch("refresh");
        assert_eq!(load_refresh(&Prefs::at(&path)), DEFAULT_REFRESH, "a missing file is the default");
        let mut prefs = Prefs::at(&path);
        for (_, secs) in REFRESH_CHOICES {
            save_refresh(&mut prefs, secs).unwrap();
            assert_eq!(load_refresh(&Prefs::at(&path)), secs, "a second open reads it back, off included");
        }
        stored().save(&mut prefs).unwrap();
        assert_eq!(load_refresh(&Prefs::at(&path)), 900, "saving a connection leaves it alone");
        for bad in
            [r#"{"refresh.seconds":1}"#, r#"{"refresh.seconds":"often"}"#, r#"{"refresh.seconds":-60}"#, "{ not json"]
        {
            std::fs::write(&path, bad).unwrap();
            assert_eq!(load_refresh(&Prefs::at(&path)), DEFAULT_REFRESH, "{bad}");
        }
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    fn session() -> Session {
        Session {
            project: Some("lighthouse".into()),
            status: Some("Ready".into()),
            sort: Some(("priority".into(), true)),
            layout: Some("board".into()),
            theme: Some("dark".into()),
        }
    }

    #[test]
    fn the_session_round_trips_and_forgets_what_is_cleared() {
        let path = scratch("session");
        assert_eq!(Session::load(&Prefs::at(&path)), Session::default(), "a missing file is no memory");
        let mut prefs = Prefs::at(&path);
        session().save(&mut prefs).unwrap();
        assert_eq!(Session::load(&Prefs::at(&path)), session(), "a second open reads it back");

        let written = std::fs::metadata(&path).unwrap().modified().unwrap();
        session().save(&mut prefs).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), written, "no change, no write");

        stored().save(&mut prefs).unwrap();
        let ascending = Session { sort: Some(("priority".into(), false)), ..session() };
        ascending.save(&mut prefs).unwrap();
        assert_eq!(Session::load(&Prefs::at(&path)), ascending);
        Session::default().save(&mut prefs).unwrap();
        assert_eq!(Session::load(&Prefs::at(&path)), Session::default(), "cleared choices leave the file");
        assert_eq!(Stored::load(&Prefs::at(&path)), Some(stored()), "and the connection stays");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_corrupt_session_falls_back_field_by_field() {
        let path = scratch("session-corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(Session::load(&Prefs::at(&path)), Session::default());
        assert_eq!(load_window(&Prefs::at(&path)), DEFAULT_WINDOW);
        let partial =
            r#"{"view.project":7,"view.status":"","view.sort":"title","view.sort_descending":"yes","ui.theme":[]}"#;
        std::fs::write(&path, partial).unwrap();
        let expected = Session { sort: Some(("title".into(), false)), ..Session::default() };
        assert_eq!(Session::load(&Prefs::at(&path)), expected, "values of the wrong type are unset");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn the_window_size_round_trips_within_its_bounds() {
        let path = scratch("window");
        assert_eq!(load_window(&Prefs::at(&path)), DEFAULT_WINDOW, "a missing file is the default");
        let mut prefs = Prefs::at(&path);
        save_window(&mut prefs, (1280.0, 760.5)).unwrap();
        assert_eq!(load_window(&Prefs::at(&path)), (1280.0, 760.5));
        for (saved, opened) in [
            (r#"[640, 300]"#, MIN_WINDOW),
            (r#"[1e9, 900]"#, (MAX_WINDOW, 900.0)),
            (r#"[0, 900]"#, DEFAULT_WINDOW),
            (r#"[-1200, 900]"#, DEFAULT_WINDOW),
            (r#"[1200]"#, DEFAULT_WINDOW),
            (r#""wide""#, DEFAULT_WINDOW),
        ] {
            std::fs::write(&path, format!(r#"{{"window.size":{saved}}}"#)).unwrap();
            assert_eq!(load_window(&Prefs::at(&path)), opened, "{saved}");
        }
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn the_window_position_round_trips() {
        let path = scratch("position");
        assert_eq!(load_position(&Prefs::at(&path)), None, "a missing file opens at the default placement");
        let mut prefs = Prefs::at(&path);
        save_position(&mut prefs, (-1300.0, 60.5)).unwrap();
        save_window(&mut prefs, (1280.0, 760.0)).unwrap();
        let prefs = Prefs::at(&path);
        assert_eq!((load_position(&prefs), load_window(&prefs)), (Some((-1300.0, 60.5)), (1280.0, 760.0)));
        for saved in [r#"[12]"#, r#""left""#, r#"[1e999, 0]"#, r#"null"#] {
            std::fs::write(&path, format!(r#"{{"window.position":{saved}}}"#)).unwrap();
            assert_eq!(load_position(&Prefs::at(&path)), None, "{saved}");
        }
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn the_form_is_checked_and_defaults_are_filled() {
        assert_eq!(Stored::parse(" db.example ", " 13306 ", " reader ", false), Ok(stored()));
        let s = Stored::parse("h", "", "", true).unwrap();
        assert_eq!((s.port, s.user.as_str(), s.tls), (3306, "root", true));
        assert_eq!(Stored::parse("", "3306", "u", false), Err(FormError::Host));
        assert_eq!(Stored::parse("two words", "3306", "u", false), Err(FormError::Host));
        for port in ["0", "65536", "-1", "abc"] {
            assert_eq!(Stored::parse("h", port, "u", false), Err(FormError::Port), "{port}");
        }
    }

    #[test]
    fn the_password_file_wins_and_loses_one_line_ending() {
        let none = NoStore;
        let c = stored().config();
        let read = |_: &str| Ok("from-file\r\n".to_string());
        let both = [("BEADS_DOLT_PASSWORD_FILE", "/p"), ("BEADS_DOLT_PASSWORD", "raw")];
        assert_eq!(resolve_password(env(&both), read, &none, &c).unwrap(), "from-file");
        let missing = |_: &str| Err(std::io::Error::other("no"));
        let got = resolve_password(env(&both), missing, &none, &c);
        assert_eq!(got, Err(Failure::CredentialUnavailable), "an unreadable file never falls back");
        assert_eq!(resolve_password(env(&[("BEADS_DOLT_PASSWORD", "raw")]), missing, &none, &c).unwrap(), "raw");
        assert_eq!(resolve_password(env(&[]), missing, &none, &c), Err(Failure::CredentialUnavailable));
    }

    #[test]
    fn the_keychain_is_last_and_only_for_the_same_account() {
        let store = MemoryStore::default();
        let c = stored().config();
        store.set(&account(&c), "saved").unwrap();
        let missing = |_: &str| Err(std::io::Error::other("no"));
        assert_eq!(resolve_password(env(&[]), missing, &store, &c).unwrap(), "saved");
        let raw = [("BEADS_DOLT_PASSWORD", "raw")];
        assert_eq!(resolve_password(env(&raw), missing, &store, &c).unwrap(), "raw", "the environment wins");
        let file = [("BEADS_DOLT_PASSWORD_FILE", "/p")];
        let got = resolve_password(env(&file), missing, &store, &c);
        assert_eq!(got, Err(Failure::CredentialUnavailable), "an unreadable file never falls back to the keychain");

        let elsewhere = Config { host: "other.example".into(), ..c.clone() };
        let got = resolve_password(env(&[]), missing, &store, &elsewhere);
        assert_eq!(got, Err(Failure::CredentialUnavailable), "a saved password never goes to another host");
        let other_user = Config { user: "admin".into(), ..c };
        assert_eq!(resolve_password(env(&[]), missing, &store, &other_user), Err(Failure::CredentialUnavailable));
    }
}

/// Against the real login keychain: `cargo test -- --ignored keychain`. It
/// writes one item under a test-only service name and deletes it again.
#[cfg(all(test, target_os = "macos"))]
mod live {
    use super::*;

    #[test]
    #[ignore = "writes to the login keychain"]
    fn keychain_stores_replaces_and_misses() {
        let service = "Beadsmith Dolt (test)";
        let store = Keychain { service };
        let account = "reader@keychain-test.invalid:3306";
        let _ = security_framework::passwords::delete_generic_password(service, account);
        assert_eq!(store.get(account), Ok(None));
        store.set(account, "first").unwrap();
        store.set(account, "second").unwrap();
        assert_eq!(store.get(account), Ok(Some("second".to_string())));
        security_framework::passwords::delete_generic_password(service, account).unwrap();
        assert_eq!(store.get(account), Ok(None));
    }
}
