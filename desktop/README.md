# Beadsmith desktop (prototype)

A native desktop client for Beadsmith, built on
[Rune](https://github.com/anomalyco/rune), a GPU-rendered Rust UI framework.
It is a prototype for deciding whether a native port is worth carrying: it
covers the web app's read path for one project at a time, and nothing else.
The decision record is
[ADR-0017](../specs/decisions/0017-native-desktop-prototype.md).

![Beadsmith desktop, dark](docs/sample-dark.png)

![Beadsmith desktop, light](docs/sample-light.png)

## What it does

- Lists the projects (user databases) on one Dolt server, with open, blocked
  and last-activity summaries.
- Shows a project's issues in a sortable, virtualised table, filtered by
  status and by text (title, id, label or assignee).
- Shows the selected issue: Markdown description, design, acceptance
  criteria and notes, labels, dependencies both ways (click one to open it)
  and comments.
- Refreshes on the Refresh button or Ctrl/Cmd-R. It follows the system's
  light or dark theme.
- Keeps its connection: host, port and user in a settings file, the password
  in the macOS Keychain, set from a connection screen that can test them
  first.

It reads only. Dispatch, accounts, the console, backups, the board, Ready,
todos and the command palette are web-only.

## The read contract

The client keeps the web app's Dolt contract
([ADR-0003](../specs/decisions/0003-dolt-read-plane.md)), ported from
[`src/lib/server/dolt/client.ts`](../src/lib/server/dolt/client.ts) into
[`src/dolt.rs`](src/dolt.rs):

- one configured server; single `SELECT`/`SHOW` statements with bound
  parameters; database names validated against `^[a-z0-9_]{1,64}$`, never
  escaped;
- each session asks for `SET SESSION TRANSACTION READ ONLY`;
- failures reduce to the same fixed classes (credential unavailable,
  authentication rejected, unreachable, unknown), read from driver codes and
  never from driver messages, which can contain hosts or user names.

Use a SELECT-only Dolt account, as the web service does
([ADR-0013](../specs/decisions/0013-owner-account-and-global-readers.md)).

Every read runs on a Rune worker (`rune::Latest`), so the window never waits
on the network, and a newer request supersedes an older one.

## Run it

You need the Rust toolchain in [`rust-toolchain.toml`](rust-toolchain.toml)
(rustup installs it on first use). On Linux, building also needs the
`libxkbcommon` and `libwayland` development packages (Rune's
[Linux notes](https://github.com/anomalyco/rune/blob/dev/crates/rune/README.md#linux)):

```sh
sudo apt-get install libxkbcommon-dev libwayland-dev   # Debian/Ubuntu
```

Then, from this directory:

```sh
cargo run --release -- --sample      # built-in sample data, no server
```

Against a Dolt server, start it with no arguments:

```sh
cargo run --release
```

The first launch opens the connection screen. Enter the host, port, user and
password, press **Test connection** to see whether the server answers and how
many projects the account can see, then **Save**. Later launches reconnect
without asking. The screen reopens from the server name at the bottom of the
sidebar.

![The connection screen after a successful test](docs/connection-dark.png)

## Install it on macOS

`cargo run` gives a bare binary: no Dock icon, no place in `/Applications`.
[`scripts/bundle-macos.sh`](scripts/bundle-macos.sh) wraps the release binary
in `Beadsmith.app`, using only tools macOS ships:

```sh
scripts/bundle-macos.sh              # target/bundle/Beadsmith.app
scripts/bundle-macos.sh install      # build, then copy to /Applications
scripts/bundle-macos.sh uninstall    # remove /Applications/Beadsmith.app
```

`BEADSMITH_INSTALL_DIR` installs somewhere else, such as `~/Applications`.
Try a build without installing it, on the sample data:

```sh
open target/bundle/Beadsmith.app --args --sample
```

The bundle's version is the crate's, read from [`Cargo.toml`](Cargo.toml).
Its icon is rendered from [`assets/icon.svg`](assets/icon.svg), the Beadsmith
mark redrawn as vectors because the web app's copies are too small for a
1024 px icon; the rendered sizes are left in `target/bundle/Beadsmith.iconset`.

The app is signed ad hoc, which has two consequences:

- It runs on the Mac that built it. Another Mac's Gatekeeper refuses it:
  that needs a Developer ID signature and notarization, which need Apple
  credentials this repository does not have. `BEADSMITH_SIGN_IDENTITY` signs
  with an identity from your keychain instead.
- An ad-hoc signature identifies one exact build, so after installing a new
  build macOS asks once more whether Beadsmith may read its `Beadsmith Dolt`
  Keychain item. Choose **Always Allow**.

Uninstalling removes the app only. The settings file and the Keychain item
stay; [Where the connection is kept](#where-the-connection-is-kept) says how
to remove them.

## Where the connection is kept

| What                | Where                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host, port and user | `prefs.json` in the OS config folder: `~/Library/Application Support/Beadsmith` on macOS, `$XDG_CONFIG_HOME/Beadsmith` on Linux, `%APPDATA%\Beadsmith` on Windows |
| Password, on macOS  | The login Keychain, as a generic password named `Beadsmith Dolt` with the account `user@host:port`                                                                |
| Password, elsewhere | Not stored: this build has no keychain binding off macOS, so set `BEADS_DOLT_PASSWORD_FILE`                                                                       |

The password is never written to the settings file, a log or a command line.
It is saved for one `user@host:port`, so changing the host and leaving the
password blank fails with "no password is available" instead of sending the
saved password to a different server. A blank password on Save keeps the one
already saved. The app reads the Keychain only when it connects, on a worker
thread, never to fill in the form.

To forget a connection, delete `prefs.json` and remove the `Beadsmith Dolt`
item in Keychain Access.

The web service's variables still work and win over the settings file, one
field at a time, so a shell can point a single run somewhere else:

| Variable                   | Default |                                                |
| -------------------------- | ------- | ---------------------------------------------- |
| `BEADS_DOLT_SERVER_HOST`   | saved   | With neither, the connection screen opens      |
| `BEADS_DOLT_SERVER_PORT`   | `3306`  |                                                |
| `BEADS_DOLT_SERVER_USER`   | `root`  | Use a SELECT-only account                      |
| `BEADS_DOLT_PASSWORD_FILE` | —       | Preferred; one trailing line ending is dropped |
| `BEADS_DOLT_PASSWORD`      | —       | Used only when no password file is set         |

The password is looked for in that order, then in the Keychain. The
connection screen shows a field the environment sets as read-only and names
the variable.

```sh
BEADS_DOLT_SERVER_HOST=127.0.0.1 BEADS_DOLT_SERVER_USER=beadsmith \
BEADS_DOLT_PASSWORD_FILE=/path/to/password cargo run --release
```

The repository's [quickstart](../quickstart/compose.yaml) serves three sample
projects; publish its Dolt port to point the client at it.

There is no TLS yet: connect over loopback, an SSH tunnel or a private
network, not across the internet.

## Check it headlessly

Rune renders any app without a window, on the same renderer:

```sh
cargo run -- --list-scenes
cargo run -- --snap sample.png --scene sample [--theme light]
cargo run -- --tree tree.json --scene filtered     # the element tree as JSON
```

Scenes fill state directly, so they need no server: `sample`, `filtered`,
`unconfigured`, `unreachable`, and the connection screen as `connection`
(first launch), `connection-testing`, `connection-failed`, `connection-ok`
and `connection-invalid`. A headless run reads no environment, settings file
or keychain, so an image depends on its scene alone. The screenshots above
are `--snap docs/sample-dark.png --scene sample`, the same with
`--theme light`, and `--scene connection-ok`.

To render every scene in both themes at once, as CI does:

```sh
scripts/snap-scenes.sh            # target/scenes/<scene>-<theme>.png
```

Snapshots render on the GPU path. A Linux machine without a GPU needs a
software Vulkan driver (`mesa-vulkan-drivers` on Debian/Ubuntu, with
`VK_ICD_FILENAMES` pointing at its `lvp_icd*.json`).

## Tests

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test                       # unit tests: no server, no keychain
BEADS_DOLT_SERVER_HOST=127.0.0.1 BEADS_DOLT_SERVER_USER=beadsmith \
BEADS_DOLT_PASSWORD=… cargo test -- --ignored --skip keychain   # a live server
cargo test -- --ignored keychain # macOS: the real Keychain
```

The live-server tests read, and save a connection to a scratch settings file
and relaunch from it. The Keychain test writes one item under a test-only
service name and deletes it.

CI runs the first three and `scripts/snap-scenes.sh` on macOS and Linux for
every pull request and push to `main` that touches `desktop/`
([`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml)), and
uploads the scene images as an artifact. It is a separate workflow from the
web app's, so neither waits on the other.

## Layout

| File                                 | Role                                              |
| ------------------------------------ | ------------------------------------------------- |
| [`src/main.rs`](src/main.rs)         | Entry point: picks the data source, scenes, keys  |
| [`src/app.rs`](src/app.rs)           | State, requests on workers, filtering and sorting |
| [`src/view.rs`](src/view.rs)         | The window: projects, issue table, issue detail   |
| [`src/dolt.rs`](src/dolt.rs)         | The Dolt read plane                               |
| [`src/settings.rs`](src/settings.rs) | Environment, settings file and keychain           |
| [`src/model.rs`](src/model.rs)       | Read-model types and the failure classes          |
| [`src/sample.rs`](src/sample.rs)     | Built-in sample data                              |

Rune is pre-release and asks apps to pin a revision of its `dev` branch; the
pin is in [`Cargo.toml`](Cargo.toml).

## Not done yet

- TLS to the Dolt server.
- Storing the password off macOS (Secret Service, Windows Credential
  Manager).
- Talking to a Beadsmith server's API instead of Dolt, which would bring
  accounts and the project gate (see the ADR's alternatives).
- A release: downloadable builds, Developer ID signing and notarization.
  Bundles for Linux and Windows.
- The board, Ready, the activity feed, search across projects, and any
  writes.
