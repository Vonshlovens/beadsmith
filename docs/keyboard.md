# Keyboard

Beadsmith can be driven from the keyboard. Press `?` on any page for the
shortcuts that page answers right now. Keys never fire while you are typing in
a field (Esc leaves the field), and an open dialog or menu owns the keyboard
until it closes.

The matcher is `src/lib/client/hotkeys.ts`; components register their keys
with `useHotkeys` (`src/lib/client/hotkeys.svelte.ts`), and
`src/lib/components/hotkey-host.svelte` holds the one window listener and the
`?` overlay.

## Everywhere

| Keys  | Does                                             |
| ----- | ------------------------------------------------ |
| `?`   | Keyboard shortcuts                               |
| `/`   | Search (the page's filter box, else the top bar) |
| `⌘K`  | Command palette (Ctrl+K off a Mac)               |
| `.`   | Recent changes (the drawer from the top bar)     |
| `[`   | Collapse or open the navigation rail             |
| `r`   | Refresh (pages with a refresh button)            |
| `Esc` | Leave a field; on an issue or thread, go back    |
| `g p` | Projects (`/projects`)                           |
| `g i` | Issues in the current (or last visited) project  |
| `g b` | Board                                            |
| `g r` | Ready                                            |
| `g f` | First Mate (the chat)                            |
| `g m` | Missions                                         |
| `g u` | Automations                                      |
| `g a` | Activity log                                     |
| `g c` | Console                                          |
| `g t` | Todos (admins)                                   |

`/` itself opens First Mate.

## Command palette

`⌘K` (Ctrl+K) opens it on any page; `↑` `↓` move, `Enter` runs, `Esc`
closes. With nothing typed it lists the issues you opened lately, every
screen with its key, and these actions: Recent changes, keyboard shortcuts,
theme, the navigation rail, copy this page's link (and the issue ID on an
issue), refresh projects, sign out. What you type also offers:

| Type                       | Offers                                               |
| -------------------------- | ---------------------------------------------------- |
| An issue ID (`lh-3`)       | Open it, in the project you are in when there is one |
| `todo` and a line (admins) | Add the todo, parsed as on the Todos page            |
| `ready`, `missions`        | The Ready deck or the mission list, in place         |
| `file`, `tackle`           | Launch an agent, after the usual confirmation        |
| Anything else              | Search issues for it, or ask First Mate about it     |

Only File, Tackle and Ask an agent launch an agent; their rows carry the
robot icon.

## Lists (projects, parade, list, Ready, missions, threads)

| Keys          | Does                                  |
| ------------- | ------------------------------------- |
| `j` / `↓`     | Next                                  |
| `k` / `↑`     | Previous                              |
| `o` / `Enter` | Open                                  |
| `a`           | Ask an agent about the selected issue |
| `t`           | Tackle the focused issue (Ready)      |

On a project: `1` parade, `2` list, `3` board, `n` file a new issue, `L` run a
loop, `x` show or hide closed issues. On the board, `h` `j` `k` `l` or the arrows move
between cards and `m` sends the focused card toward another status.

## Todos (admins)

`/todos` has two layouts over the same todos: **Agenda** (cards in due-date
columns) and **List** (a dense, monospace, one-row-per-todo list modelled on
[tuxedo](https://github.com/webstonehq/tuxedo)). The tabs in the header switch;
the choice is remembered per browser (`?view=list` wins when present).

### Both layouts

| Keys  | Does                                                            |
| ----- | --------------------------------------------------------------- |
| `Tab` | Switch Agenda ⇄ List (only when nothing but the page has focus) |
| `l`   | List layout (from the Agenda)                                   |

### Agenda

| Keys                       | Does                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| `n` / `/`                  | Focus the capture field                                           |
| `Enter`                    | Add the parsed todo at once                                       |
| `↓` / `Tab` (in the field) | Refine: date chips and a priority stepper (below)                 |
| `Esc`                      | Clear the field, then leave it                                    |
| `r`                        | Route the focused todo to a project (otherwise refresh)           |
| `Alt+↑` / `Alt+↓`          | Move the focused card up or down within its column                |
| `Alt+←` / `Alt+→`          | Move the focused card to the neighbouring column (reschedules it) |

**Refine.** With a title typed, `↓` or `Tab` moves into a panel under the
field. `1`–`4` pick Today, Tomorrow, Next week or No date (offered only when
the line named no date), `←`/`→` step the priority (← is more urgent),
`⌘Enter` or `Enter` adds, `Esc` or `↑` goes back to the field. The chips are
clickable too. Everything is parsed locally; there is no model.

**Drag and drop.** Drag a card onto a column to reschedule it, or to a spot in
a column to reorder it. Dropping in another column sets the date:

| Column          | A card dropped there…                                       |
| --------------- | ----------------------------------------------------------- |
| Today & overdue | keeps a past or today date; anything else becomes today     |
| Next 7 days     | keeps a date 1–7 days out; anything else becomes tomorrow   |
| Upcoming        | keeps a date more than 7 days out; anything else is cleared |

(With two columns, "Upcoming" keeps any date after today and clears the rest;
with one column a drop never changes the date.) Reordering sets `sort_key`
between the neighbours. Columns sort by urgency, which would undo a manual
drop, so a reorder switches the **Order** button in the header to _manual_ and
stamps the order on screen into `sort_key` (the List view's _manual_ sort
follows it). Switch back with the button. Native drag does not work on touch
screens; use `Alt+arrows` or the reschedule menu there. Layout animation is
paused while a card is held and springs (overshoot, as agenda.dev) when it lands.

### List

The status bar shows the mode chip (`NORMAL`, `VISUAL`, `SEARCH`, `INSERT` for
the add / edit / tag prompts, `COMMAND`, `FILTER` while `f…` cycles) and, while
a two-key chord is armed, the keys typed so far (`d…`). The list scope outranks
the global map while it is mounted, so it rebinds `/` and `[`. Nothing here
fires while you type in a field. Priority maps tuxedo's `(A)`–`(E)` onto
P0–P4.

| Keys                                        | Does                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `j` / `↓`, `k` / `↑`                        | Next / previous todo                                                                   |
| `g g`, `G`                                  | First / last todo (also `Home` / `End`)                                                |
| `Ctrl-d`, `Ctrl-u`                          | Half page down / up                                                                    |
| `n`, `o`                                    | Add a todo (capture syntax; under a `+`/`@` filter the tags are pre-filled)            |
| `e`, `i`                                    | Edit the todo as a capture line (`title p1 due:2026-11-03 +tag @ctx`)                  |
| `x`                                         | Complete or reopen                                                                     |
| `d d`                                       | Archive                                                                                |
| `A`                                         | Archive every completed todo (asks for a second `A` above 3; `u` undoes)               |
| `p`                                         | Cycle priority P0 → P1 → … → P4 → P0                                                   |
| `J` / `K`                                   | Move down / up by swapping `sort_key` with a neighbour that ties under the sort        |
| `c`, `+`                                    | Add or remove an `@context` / `+project` (a prompt; toggles per todo)                  |
| `y y`, `y b`                                | Copy the todo.txt line / the title only                                                |
| `u`                                         | Undo, 50 levels (complete, archive, priority, move, edit, tags, add)                   |
| `v`                                         | Visual mode: the cursor extends the selection; `Space` adds or drops a row             |
| `x` `d d` `p` `c` `+` `y y` `y b` in visual | The same actions on every selected row, then back to normal                            |
| `/`                                         | Search (live); `Enter` keeps it, `Esc` restores the previous query                     |
| `n` / `N`                                   | While a search is kept: next / previous match (wraps; the list shows matches only)     |
| `S`, `f s`                                  | Save the search or filter as a named saved search (settings `todos.filters`)           |
| `f p`, `f c`                                | Cycle the `+project` / `@context` filter (`j`/`k` cycle, `Enter` keeps, `Esc` reverts) |
| `f f`                                       | Cycle saved searches (same keys)                                                       |
| `s`                                         | Cycle sort: urgency → due → priority → manual (due groups by bucket)                   |
| `H`                                         | Show or hide done todos in the list                                                    |
| `a`                                         | Archive view: done todos grouped by completion date                                    |
| `[` / `]`                                   | Toggle the filter sidebar / the detail pane (raw line, comments)                       |
| `D`, `L`                                    | Cycle density (compact, comfortable, cozy) / toggle line numbers                       |
| `:`, `Ctrl-P`                               | Command palette: type to filter, `↑↓` choose, `Enter` run                              |
| `r`                                         | Route the todo to a project (unrouted, or again after a failed route)                  |
| `Esc`                                       | Cancel a chord, leave visual or filter mode, then clear search and filters             |
| `?`                                         | This overlay                                                                           |

**`g g` and the go-to chords.** `g` waits 1.2 s for a second key, so `g g`
(first todo) and `g t`, `g p`, … (go to) share the prefix without clashing:
no go-to chord is `g g`. `Esc` drops a pending `g`. The floating hint under a
pending `g` lists every second key the page answers.

**Reorder.** `J`/`K` only swap past a neighbour the active sort cannot tell
apart (same urgency and due date; same due date; same priority and date;
anything in manual), so the visible order never fights the sort. Press `s` to
reach manual order when a move is refused.

**`A`** archives every completed todo in one undoable step (tuxedo moves them
to `done.txt`; here "archived" hides them, and `u` brings them back). More than
three asks for a second `A` within 5 s.

**Not in the list** (tuxedo keys with no meaning here): `o`/`O` notes, `T` theme picker (the app has its own
theme control), `s` QR capture, `,` settings, `q` quit, `rec:` recurrence, `t:`
threshold dates, and todo.txt import/export. Edits use the browser's text
field rather than tuxedo's vim-style modal editor. Tuxedo's `S` (sort) is `s`
here, and `S` / `f s` save a search: a deliberate difference.

## Issue page

| Keys  | Does                          |
| ----- | ----------------------------- |
| `a`   | Ask an agent about this issue |
| `t`   | Tackle it                     |
| `L`   | Run a loop on it              |
| `c`   | Write a comment               |
| `y`   | Copy the issue id             |
| `Esc` | Back to the list              |

## Agent dialog

| Keys      | Does                                        |
| --------- | ------------------------------------------- |
| `d` / `1` | Discuss: ask about it, nothing changes      |
| `e` / `2` | Elaborate: rewrite description and criteria |
| `c` / `3` | Close it with a reason                      |
| `t` / `4` | Tackle: claim, do the work, open a PR       |
| `l`       | Run a loop on it instead (the loop dialog)  |
| `⌘Enter`  | Launch                                      |
| `Enter`   | Send a reply in a thread (`⇧Enter`: line)   |
| `n`       | New request (from a thread)                 |

## Loop dialog

Opened with `L` on a project or issue page, or `l` in the agent dialog, when
a runner on this service runs ralph loops (admins only).

| Keys        | Does                                                       |
| ----------- | ---------------------------------------------------------- |
| `1` `2` `3` | Pick a preset: this bead, build the plan, plan the project |
| `Enter`     | Start, from the iteration field                            |
| `⌘Enter`    | Start the loop                                             |

## Agent terminal

Admins open an agent's terminal from a Sand mission's thread or a Sand chat
(the **Terminal** strip). Watching takes no keys: the page's shortcuts work
as usual. While you have taken over, every key goes to the agent, including
Esc (Claude Code's interrupt), Tab, `/` and the page's other shortcuts.

| Keys        | Does                                              |
| ----------- | ------------------------------------------------- |
| `Shift+Esc` | Leave the terminal (focus moves to **Hand back**) |

Take over is offered only with a mouse or trackpad on a screen at least
640px wide; on touch and narrow screens the terminal is watch-only.

## First Mate

`/first-mate` is a chat: a rail of chats (and agent threads, when an agent
runner is configured) beside one conversation. With a mate runner configured,
an admin's chat is one long-lived agent that runs a crew and reports back
([first-mate.md](first-mate.md)); without one, replies are placeholders.
Chats are kept on the server. The commands stay on `⌘K`, and every composer
has a **Commands** button.

| Keys      | Does                           |
| --------- | ------------------------------ |
| `Enter`   | Send (`⌘Enter` too)            |
| `⇧Enter`  | New line                       |
| `n`       | New chat                       |
| `j` / `k` | Next / previous chat or thread |
| `Esc`     | Close the chat or thread       |

On a touch screen with no pointer, Enter starts a new line, because an
on-screen keyboard has no Shift+Enter: send with the **Send** button (or
`⌘Enter` from a hardware keyboard). `n` is live only when you can chat.
