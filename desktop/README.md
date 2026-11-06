# Beadsmith desktop (prototype)

A native desktop client for Beadsmith, built on
[Rune](https://github.com/anomalyco/rune), a GPU-rendered Rust UI framework.
It is a prototype for deciding whether a native port is worth carrying: it
covers the web app's read path for one project at a time, and nothing else.
The decision record is
[ADR-0016](../specs/decisions/0016-native-desktop-prototype.md).

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

Against a Dolt server, the client reads the web service's variables:

| Variable                   | Default |                                                |
| -------------------------- | ------- | ---------------------------------------------- |
| `BEADS_DOLT_SERVER_HOST`   | —       | Required; without it the window says so        |
| `BEADS_DOLT_SERVER_PORT`   | `3306`  |                                                |
| `BEADS_DOLT_SERVER_USER`   | `root`  | Use a SELECT-only account                      |
| `BEADS_DOLT_PASSWORD_FILE` | —       | Preferred; one trailing line ending is dropped |
| `BEADS_DOLT_PASSWORD`      | —       | Used only when no password file is set         |

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

Scenes (`sample`, `filtered`, `unconfigured`, `unreachable`) fill state
directly, so they need no server. The screenshots above are
`--snap docs/sample-dark.png --scene sample` and the same with
`--theme light`.

## Tests

```sh
cargo test                       # unit tests, no server
cargo clippy --all-targets
BEADS_DOLT_SERVER_HOST=127.0.0.1 BEADS_DOLT_SERVER_USER=beadsmith \
BEADS_DOLT_PASSWORD=… cargo test -- --ignored   # against a live server
```

## Layout

| File                             | Role                                              |
| -------------------------------- | ------------------------------------------------- |
| [`src/main.rs`](src/main.rs)     | Entry point: picks the data source, scenes, keys  |
| [`src/app.rs`](src/app.rs)       | State, requests on workers, filtering and sorting |
| [`src/view.rs`](src/view.rs)     | The window: projects, issue table, issue detail   |
| [`src/dolt.rs`](src/dolt.rs)     | The Dolt read plane and configuration             |
| [`src/model.rs`](src/model.rs)   | Read-model types and the failure classes          |
| [`src/sample.rs`](src/sample.rs) | Built-in sample data                              |

Rune is pre-release and asks apps to pin a revision of its `dev` branch; the
pin is in [`Cargo.toml`](Cargo.toml).

## Not done yet

- TLS to the Dolt server, and storing credentials in the OS keychain.
- Talking to a Beadsmith server's API instead of Dolt, which would bring
  accounts and the project gate (see the ADR's alternatives).
- Packaging (app bundles, installers) and a CI job for this crate.
- The board, Ready, the activity feed, search across projects, and any
  writes.
