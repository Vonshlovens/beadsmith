# 0017. Native desktop prototype on Rune

Date: 2026-11-06

## Status

proposed

## Context

Beadsmith ships as a web server over one remote Dolt SQL server
([0001](./0001-remote-sql-control-plane.md)). We want to find out whether a
native desktop client is worth carrying alongside it: faster to open, usable
from a laptop without a deployed Beadsmith, and pleasant to keep open beside
an editor.

[Rune](https://github.com/anomalyco/rune) is a GPU-rendered Rust UI framework
for macOS, Windows, Linux and the web. It ships a component kit (virtualised
tables, Markdown, text fields), runs any app headless to PNGs and element
trees, and has request workers that keep the UI thread off the network. It is
pre-release and asks apps to pin a revision of its `dev` branch.

ADR-0001 rejected a *desktop client over local workspaces*: one that scans
for `.beads` directories, drives `bd` and uses desktop credential helpers.
That rejection stands. The question here is narrower: a desktop program that
reads the same remote Dolt server the web service reads.

Out of scope: writes, dispatch, accounts, the console, backups, and replacing
the web app.

## Decision

We will build a prototype native client in `desktop/`, a standalone Rust
crate on a pinned Rune revision, that reads Beads projects directly from one
configured Dolt server with the web app's read contract
([0003](./0003-dolt-read-plane.md)): single parameterized `SELECT`/`SHOW`
statements, validated database names, a read-only session, and the same
fixed failure classes with no driver text.

It keeps its own connection settings, because a program started from the
Finder has no shell environment: host, port and user in a settings file under
the OS config folder, and the password in the macOS Keychain, both written
from a connection screen. The web service's `BEADS_DOLT_*` variables still
override the file field by field, with the password file preferred over the
raw value and the Keychain last. The password is held only in the Keychain
and the driver's options.

The prototype covers the project list, one project's issue table with
status and text filters, and the issue detail.

## Consequences

- The desktop client is a second Dolt reader. It holds a Dolt credential on
  the user's machine, so it must use a SELECT-only account
  ([0013](./0013-owner-account-and-global-readers.md)); the read-only session
  is a second guard, not the boundary.
- It bypasses Beadsmith's accounts, roles and the target per-project gate
  ([0009](./0009-edge-identity-and-catalog-gate.md),
  [0011](./0011-accounts-and-roles.md)). Whoever has the Dolt credential sees
  every SQL-visible project. That matches what the credential already allows,
  but it means the desktop client is for the server's owner, not for shared
  readers.
- It stores a Dolt password in the user's login Keychain. ADR-0001 rejected
  _desktop credential helpers_ for a client over local workspaces; this is
  narrower. The client stores one password for the one server its user typed
  in, keyed by `user@host:port` so it is never offered to another server, and
  it reads no other program's credentials (not `bd`'s credential file, not
  other keychain items). The password is never written to the settings file,
  a log or a command line, and the form never reads it back. Off macOS there
  is no keychain binding yet, so the password comes from the environment.
- It does not scan workspaces, run `bd`, or touch the web service's
  `state.db`. ADR-0001's rejected desktop shape stays rejected.
- The read queries now exist in TypeScript and in Rust. A Beads schema change
  has to land in both until one of them goes.
- TLS to Dolt is optional and off by default, since a stock Dolt server has
  no certificate. When on, the server's certificate is verified against the
  operating system's trusted roots (Security.framework on macOS, so a
  private CA the user trusts in Keychain Access works; OpenSSL's store
  elsewhere) and against the host as typed, with no setting to skip either
  check. It goes through the `mysql` crate's `native-tls` backend rather
  than its rustls one, which only knows a bundled copy of the public web
  roots and would make a private CA unusable. Handshake failures and a
  server without TLS are two more fixed failure classes, with no text from
  the TLS library. With TLS off, a host other than this machine is marked
  "Unencrypted" under the server's name, so a password crossing a network
  in the clear is visible rather than silent. The web service's Dolt
  client has no TLS setting, so this has no environment variable.
- Shipped as an unnotarized download only. A script builds a macOS app
  bundle, on the user's own machine (where it can copy it to
  `/Applications`) or in a release workflow that runs on `desktop-v<version>`
  tags and attaches a universal zip and its SHA-256 to a GitHub Release. The
  signature is ad hoc either way: Developer ID signing and notarization need
  Apple credentials the repository does not hold. So the bundle opens where
  it was built, and a downloaded copy opens only after the user clears its
  quarantine attribute, which is a deliberate step the README explains
  beside checking the checksum. The checksum covers transport, not
  provenance. An ad-hoc signature also names one exact build, so the
  Keychain asks again for access to the saved password after each rebuild or
  update. The web app is unchanged.
- The crate has its own workflows, kept out of `ci.yml` so the web app's
  jobs and its image publish neither wait for a Rust build nor fail on one:
  `.github/workflows/desktop.yml` (format, Clippy, tests and a headless
  render of every scene on macOS and Linux) and
  `.github/workflows/desktop-release.yml`, whose publishing job is the only
  desktop job with write access to the repository and only uploads the two
  files the build job made.

## Alternatives considered

**Read through a Beadsmith server's HTTP API.** The desktop client would sign
in like a browser and inherit accounts, roles and the future project gate,
with one copy of the queries. It needs a deployed Beadsmith and a
non-browser sign-in flow (Better Auth sessions, or a Cloudflare Access
service token), which is more than a prototype should build before we know
the port is wanted. If the port goes ahead for anyone but the owner, this is
the likely target, and it would supersede the direct-Dolt reader.

**Wrap the web app in a webview shell.** Cheapest, but it is the web app in a
window: it still needs a running server and gains nothing native.

## Implementation notes

- Code: [`desktop/`](../../desktop/README.md); the read plane is
  [`desktop/src/dolt.rs`](../../desktop/src/dolt.rs), ported from
  [`src/lib/server/dolt/client.ts`](../../src/lib/server/dolt/client.ts).
- Connection settings: [`desktop/src/settings.rs`](../../desktop/src/settings.rs)
  (precedence, the settings file through Rune's `prefs`, the Keychain through
  the `security-framework` crate); the form's state is in
  [`desktop/src/app.rs`](../../desktop/src/app.rs).
- Automatic refresh (`State::tick` in `desktop/src/app.rs`): the same three
  reads as a manual refresh, on a saved interval and on window focus, never
  overlapping and never repeating a rejected or missing password. It adds no
  statement and no authority; see
  [Automatic refresh](../../desktop/README.md#automatic-refresh).
- Quick open (`State::open_quick` in `desktop/src/app.rs`, ranking in
  [`desktop/src/quick.rs`](../../desktop/src/quick.rs)) adds one read,
  `Source::search`: a single parameterized `SELECT` per project with `LIKE`
  on issue ids and titles, the typed text bound as a value with its
  wildcards escaped, and a fixed row limit. It reads only the projects the
  sidebar already lists and adds no authority; see
  [Quick open](../../desktop/README.md#quick-open).
- Issue actions (`keys::issue_action` in `desktop/src/keys.rs`): copy the
  id, copy a Markdown link, open in the browser. They use only what is on
  screen and add no read and no authority. Links are built from an optional
  web address saved in the settings file (`web.url`, `http` or `https`
  only) on the web app's issue route, `/p/d_<database>/i/<issue id>`
  (`model::web_issue_url`); the browser, not the desktop app, signs in to
  the web app. See
  [Links to the web app](../../desktop/README.md#links-to-the-web-app).
- The view a relaunch restores (project, status tab, sort, theme choice,
  window size and, on macOS, position) is kept in the same settings file (`settings::Session`); it
  holds names and numbers only, and an unusable value falls back to its
  default. See
  [What a relaunch remembers](../../desktop/README.md#what-a-relaunch-remembers).
  Rune cannot report a window's position, so `desktop/src/placement.rs`
  reads the frame from AppKit through Rune's raw window handle (direct
  `objc2`/`objc2-app-kit` dependencies at the versions Rune already uses)
  and keeps it in points; this is a native read of our own window, not a
  change to the data boundary.
- TLS: `Config::tls` and `options` in `desktop/src/dolt.rs` (the pool's
  `SslOpts`, defaults only), `dolt.tls` in the settings file, the form's
  checkbox and the sidebar's mark in `desktop/src/view.rs`. The ignored
  live test `tls_is_verified_and_failures_are_fixed_classes` runs against a
  local Dolt with a throwaway CA; see
  [TLS](../../desktop/README.md#tls).
- Tests: `cargo test` in `desktop/` (unit: no server, no keychain);
  `cargo test -- --ignored` against a live server and the real Keychain.
  Headless scenes: `cargo run -- --snap out.png --scene sample`.
- macOS bundle: [`desktop/scripts/bundle-macos.sh`](../../desktop/scripts/bundle-macos.sh)
  (release build, `Info.plist` with the crate's version, icon from
  [`desktop/assets/icon.svg`](../../desktop/assets/icon.svg), ad-hoc
  `codesign`, install and uninstall, and `package` for the zip and
  checksum).
- Release: [`.github/workflows/desktop-release.yml`](../../.github/workflows/desktop-release.yml)
  on `desktop-v<version>` tags; the tag must match `desktop/Cargo.toml`. A
  manual run from a branch builds the archive as a workflow artifact and
  releases nothing.
- The Rune revision is pinned in `desktop/Cargo.toml`; its toolchain in
  `desktop/rust-toolchain.toml`.
- Row in [`specs/README.md`](../README.md).
