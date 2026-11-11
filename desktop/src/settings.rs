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

/// The connection the settings file holds. No password: see the module docs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stored {
    pub host: String,
    pub port: u16,
    pub user: String,
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
        Some(Stored { host, port, user })
    }

    /// The host goes last: it is what makes a saved connection exist, so a
    /// write that fails part-way leaves the previous connection or none.
    pub fn save(&self, prefs: &mut Prefs) -> Result<(), PrefsError> {
        prefs.set(PORT_KEY, &self.port)?;
        prefs.set(USER_KEY, &self.user)?;
        prefs.set(HOST_KEY, &self.host)
    }

    /// What the connection form holds, checked. An empty port or user takes
    /// the web service's default.
    pub fn parse(host: &str, port: &str, user: &str) -> Result<Stored, FormError> {
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
        Ok(Stored { host: host.to_string(), port, user: user.to_string() })
    }

    pub fn config(&self) -> Config {
        Config { host: self.host.clone(), port: self.port, user: self.user.clone() }
    }
}

/// Why the connection form could not be saved. Like [`Failure`], these are
/// fixed messages: nothing from the OS or a driver is shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FormError {
    Host,
    Port,
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
    /// None without a host from either.
    pub fn config(&self, stored: Option<&Stored>) -> Option<Config> {
        let host = self.host.clone().or_else(|| stored.map(|s| s.host.clone()))?;
        let port = self.port.or(stored.map(|s| s.port)).unwrap_or(DEFAULT_PORT);
        let user = self.user.clone().or_else(|| stored.map(|s| s.user.clone())).unwrap_or_else(|| DEFAULT_USER.into());
        Some(Config { host, port, user })
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
        Stored { host: "db.example".into(), port: 13306, user: "reader".into() }
    }

    /// A settings file in a fresh folder under the system temp directory.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("beadsmith-desktop-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("prefs.json")
    }

    #[test]
    fn the_environment_needs_a_host_and_keeps_the_web_defaults() {
        assert!(Env::from_lookup(env(&[])).config(None).is_none());
        assert!(Env::from_lookup(env(&[("BEADS_DOLT_SERVER_HOST", "  ")])).config(None).is_none());
        let c = Env::from_lookup(env(&[("BEADS_DOLT_SERVER_HOST", " db.example ")])).config(None).unwrap();
        assert_eq!((c.host.as_str(), c.port, c.user.as_str()), ("db.example", 3306, "root"));
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
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_corrupt_or_partial_file_is_no_connection() {
        let path = scratch("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(Stored::load(&Prefs::at(&path)), None);
        std::fs::write(&path, r#"{"dolt.host":"h","dolt.port":"many","dolt.user":""}"#).unwrap();
        let s = Stored::load(&Prefs::at(&path)).unwrap();
        assert_eq!((s.port, s.user.as_str()), (DEFAULT_PORT, DEFAULT_USER), "bad fields fall back to defaults");
        std::fs::write(&path, r#"{"dolt.port":3306}"#).unwrap();
        assert_eq!(Stored::load(&Prefs::at(&path)), None, "no host, no connection");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn the_form_is_checked_and_defaults_are_filled() {
        assert_eq!(Stored::parse(" db.example ", " 13306 ", " reader "), Ok(stored()));
        let s = Stored::parse("h", "", "").unwrap();
        assert_eq!((s.port, s.user.as_str()), (3306, "root"));
        assert_eq!(Stored::parse("", "3306", "u"), Err(FormError::Host));
        assert_eq!(Stored::parse("two words", "3306", "u"), Err(FormError::Host));
        for port in ["0", "65536", "-1", "abc"] {
            assert_eq!(Stored::parse("h", port, "u"), Err(FormError::Port), "{port}");
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
