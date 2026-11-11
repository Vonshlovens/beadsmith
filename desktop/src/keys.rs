//! The keyboard: which key means which command, what each command does, the
//! native menu that offers the same commands, and the list the shortcuts
//! overlay and the README show.
//!
//! One path runs every command (`run`), whether it came from a key, a menu
//! click or the filter field, so a shortcut and its menu item cannot drift
//! apart. Keys follow the web app's (`docs/keyboard.md`) wherever it defines
//! the same action: `j`/`k` and the arrows in lists, `o`/Enter to open, `/`
//! to filter, `r` to refresh, `?` for the list, Esc to go back.
//!
//! Rune routes a key to the focused control first and to the window's
//! `on_key` when nothing is focused or the control passes it on, so plain
//! letters never fire while a field is being typed in.

use rune::{Key, KeyEvent, MenuItem, Tx};

use crate::app::{Layout, Pane, STATUS_FILTERS, State, Step};

/// An element inside the detail pane's scroll view, by which `Scroll` names
/// that view. The view itself is keyed per issue so each issue opens at its top.
pub const DETAIL_ANCHOR: &str = "issue-heading";

/// The scroll view around the shortcuts list (`view::shortcuts_dialog`),
/// which the reading keys page while the list is open.
pub const SHORTCUTS_SCROLL: &str = "shortcut-scroll";

/// The element key of a row in quick open's list, by its place in it: what
/// the view builds the row under and the keys here scroll to.
pub fn quick_row_key(row: usize) -> String {
    format!("quick-row-{row}")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scroll {
    PageDown,
    PageUp,
    Top,
    Bottom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    /// Move the selection through the issue list, or down a board column.
    Select(Step),
    /// On the board, move the selection this many columns (-1 or 1).
    Lane(isize),
    /// Switch between the table and the board.
    SwitchLayout,
    /// Choose a status tab by its place in `app::STATUS_FILTERS`, from 0.
    Status(usize),
    /// Give the keyboard to the selected issue (or select the first one).
    Open,
    /// Esc: step back out of whatever is innermost.
    Back,
    /// Put the caret in the filter field.
    Filter,
    Refresh,
    Connection,
    /// The `n`th project in the sidebar, from 0.
    Project(usize),
    SortNext,
    SortReverse,
    Shortcuts,
    /// Open the palette that jumps to a project or an issue (`app::Quick`).
    QuickOpen,
    /// Step the theme preference: system, light, dark.
    Theme,
    /// Scroll the issue being read.
    Scroll(Scroll),
    /// Back to the issue a dependency link was followed from (`app::Trail`).
    TrailBack,
    /// Forward again after `TrailBack`.
    TrailForward,
    /// Copy the selected issue's id, as `y` does on the web issue page.
    CopyId,
    /// Copy a Markdown link to the selected issue's web page.
    CopyLink,
    /// Open the selected issue's web page in the browser.
    OpenWeb,
    CloseWindow,
    Quit,
}

impl Command {
    /// Whether holding the key down should repeat the command. Moving and
    /// scrolling do; a held `r` must not queue a refresh per repeat.
    pub fn repeats(self) -> bool {
        matches!(self, Command::Select(_) | Command::Lane(_) | Command::Scroll(_))
    }
}

/// The command a key means. `pane` is the pane plain keys drive, and `typing`
/// is true while the filter field has focus: then only chords and Esc mean
/// anything, whatever the field passed on.
pub fn command(key: &KeyEvent, pane: Pane, typing: bool) -> Option<Command> {
    let m = key.mods;
    if let Key::Command(c) = key.key {
        if m.alt || m.shift {
            return None;
        }
        return match c {
            'f' => Some(Command::Filter),
            'r' => Some(Command::Refresh),
            ',' => Some(Command::Connection),
            // The editors' and the web's "go to anything".
            'k' => Some(Command::QuickOpen),
            '1'..='9' => Some(Command::Project(c as usize - '1' as usize)),
            // The browser's and Finder's history keys.
            '[' => Some(Command::TrailBack),
            ']' => Some(Command::TrailForward),
            // macOS closes and quits from its own menus (`App::standard_menus`
            // and the app menu); elsewhere nothing would answer these.
            'w' if !cfg!(target_os = "macos") => Some(Command::CloseWindow),
            'q' if !cfg!(target_os = "macos") => Some(Command::Quit),
            _ => None,
        };
    }
    if m.cmd || m.ctrl || m.alt {
        return None;
    }
    if key.key == Key::Escape {
        return Some(Command::Back);
    }
    if typing {
        return None;
    }
    let reading = pane == Pane::Detail;
    if reading && let Some(to) = reading_key(key) {
        return Some(Command::Scroll(to));
    }
    match &key.key {
        Key::Down => Some(Command::Select(Step::Next)),
        Key::Up => Some(Command::Select(Step::Previous)),
        // The web board's keys. In the table they find nothing to move
        // (`run` says so) and the key goes on to whatever else wants it.
        Key::Left if !reading => Some(Command::Lane(-1)),
        Key::Right if !reading => Some(Command::Lane(1)),
        Key::Home => Some(Command::Select(Step::First)),
        Key::End => Some(Command::Select(Step::Last)),
        // In the list Rune's own paging of the table is left alone.
        Key::Enter if !m.shift => Some(Command::Open),
        Key::Text(t) => match t.as_str() {
            "j" => Some(Command::Select(Step::Next)),
            "k" => Some(Command::Select(Step::Previous)),
            "h" if !reading => Some(Command::Lane(-1)),
            "l" if !reading => Some(Command::Lane(1)),
            "v" => Some(Command::SwitchLayout),
            // The tabs in their order, as the web project page's digits pick
            // its views. Cmd with a digit is the sidebar's projects.
            "1" | "2" | "3" | "4" | "5" | "6" => {
                let n = t.parse::<usize>().map_or(0, |d| d - 1);
                (n < STATUS_FILTERS.len()).then_some(Command::Status(n))
            }
            "o" => Some(Command::Open),
            // The web issue page's key, and its capital for the link.
            "y" => Some(Command::CopyId),
            "Y" => Some(Command::CopyLink),
            // `o` reads the issue here; the capital reads it over there.
            "O" => Some(Command::OpenWeb),
            "/" => Some(Command::Filter),
            "r" => Some(Command::Refresh),
            "s" => Some(Command::SortNext),
            "S" => Some(Command::SortReverse),
            "t" => Some(Command::Theme),
            "?" => Some(Command::Shortcuts),
            _ => None,
        },
        _ => None,
    }
}

/// The keys that move through something being read, as `command` gives
/// them in the detail pane: arrows, j/k, Space and the page keys page it,
/// Home and End go to its ends.
fn reading_key(key: &KeyEvent) -> Option<Scroll> {
    let m = key.mods;
    if m.cmd || m.ctrl || m.alt {
        return None;
    }
    match &key.key {
        Key::Down | Key::PageDown => Some(Scroll::PageDown),
        Key::Up | Key::PageUp => Some(Scroll::PageUp),
        Key::Home => Some(Scroll::Top),
        Key::End => Some(Scroll::Bottom),
        Key::Text(t) => match t.as_str() {
            "j" => Some(Scroll::PageDown),
            "k" => Some(Scroll::PageUp),
            " " => Some(if m.shift { Scroll::PageUp } else { Scroll::PageDown }),
            _ => None,
        },
        _ => None,
    }
}

/// Move the scroll view keyed `anchor` (or the one around it).
fn scroll(anchor: &str, to: Scroll, tx: &mut Tx) {
    match to {
        Scroll::PageDown => tx.scroll_page(anchor, 1),
        Scroll::PageUp => tx.scroll_page(anchor, -1),
        Scroll::Top => tx.scroll_to_y(anchor, 0.0),
        Scroll::Bottom => tx.scroll_to_bottom_instant(anchor),
    }
}

/// The window's key handler (`AppSpec::on_key`).
pub fn on_key(s: &mut State, key: &KeyEvent, tx: &mut Tx) -> bool {
    // The shortcuts list is taller than the smallest window: the keys that
    // page an issue being read page it too, so every row is reachable
    // without a pointer. Nothing else in it takes a key.
    if s.shortcuts && s.connection.is_none() {
        let Some(to) = reading_key(key) else { return false };
        scroll(SHORTCUTS_SCROLL, to, tx);
        return true;
    }
    // A dialog owns the keyboard; Rune closes it on Esc.
    if s.modal_open() {
        return false;
    }
    let Some(command) = command(key, s.pane, s.search.focused) else { return false };
    if tx.key_repeat() && !command.repeats() {
        return true;
    }
    run(s, command, tx)
}

/// Carry out a command. False when it had nothing to act on, so the key that
/// asked goes on to whatever else wants it.
pub fn run(s: &mut State, command: Command, tx: &mut Tx) -> bool {
    // Menu items stay clickable under a dialog; they must not act behind it.
    if s.modal_open() {
        return false;
    }
    match command {
        Command::Select(step) => {
            if s.move_selection(step).is_some() {
                s.scroll_to_selected(tx);
            }
        }
        Command::Lane(by) => {
            if s.layout != Layout::Board {
                return false;
            }
            if s.move_lane(by).is_some() {
                s.scroll_to_selected(tx);
            }
        }
        Command::SwitchLayout => {
            let next = if s.layout == Layout::Table { Layout::Board } else { Layout::Table };
            set_layout(s, next, tx);
        }
        Command::Status(n) => {
            s.set_status_filter(n);
            // The selection stays when the tab still shows it.
            s.scroll_to_selected(tx);
        }
        Command::Open => open(s, tx),
        Command::Back => {
            // Innermost first: the field (Rune's own Esc usually leaves it
            // before this runs), the issue being read, the filters, then
            // the selection.
            if s.search.focused {
                tx.blur();
            } else if s.pane == Pane::Detail {
                s.pane = Pane::List;
            } else if s.has_filters() {
                s.clear_filters();
            } else if s.issue.is_some() {
                s.clear_selection();
            } else {
                return false;
            }
        }
        Command::Filter => {
            s.pane = Pane::List;
            s.search.focused = true;
            // Typing replaces the old filter, as Cmd-F does in a browser.
            let end = s.search.text.len();
            s.search.set_selection(0, end);
        }
        Command::Refresh => s.refresh(),
        Command::Connection => s.open_connection(),
        Command::Project(n) => return s.select_project_at(n),
        Command::SortNext => s.sort_next(),
        Command::SortReverse => return s.sort_reverse(),
        Command::Shortcuts => s.shortcuts = true,
        Command::QuickOpen => return s.open_quick(),
        Command::Theme => s.cycle_appearance(),
        Command::Scroll(to) => scroll(DETAIL_ANCHOR, to, tx),
        Command::TrailBack | Command::TrailForward => {
            let moved = if command == Command::TrailBack { s.go_back() } else { s.go_forward() };
            if moved.is_none() {
                return false;
            }
            // The detail pane moved without the list; bring its row along.
            s.scroll_to_selected(tx);
        }
        Command::CopyId | Command::CopyLink | Command::OpenWeb => return issue_action(s, command, tx),
        Command::CloseWindow => tx.close_window(),
        Command::Quit => tx.quit(),
    }
    true
}

/// Copy from or open the selected issue. Nothing here reaches the server:
/// the id, title and project are already on screen, and the link is built
/// from the saved web address (`State::issue_url`). Each says what it did in
/// a notice, or why it could not; with no issue selected the key passes on.
fn issue_action(s: &mut State, command: Command, tx: &mut Tx) -> bool {
    let Some(id) = s.issue.clone() else { return false };
    match command {
        Command::CopyId => {
            tx.copy(id.clone());
            s.notify(true, "Copied the id", Some(id));
        }
        Command::CopyLink => match s.issue_markdown() {
            Ok(link) => {
                tx.copy(link.clone());
                s.notify(true, "Copied a Markdown link", Some(link));
            }
            Err(why) => s.notify(false, "No link to the web app", Some(why.message().into())),
        },
        _ => match s.issue_url() {
            // The browser coming forward is the confirmation.
            Ok(url) => {
                if tx.open_url(&url).is_err() {
                    s.notify(false, "Could not open the link", Some(url));
                }
            }
            Err(why) => s.notify(false, "No link to the web app", Some(why.message().into())),
        },
    }
    // The notice's clock starts on the next `poll` (`State::tick`).
    if s.notice.is_some() {
        tx.wake_after(std::time::Duration::ZERO);
    }
    true
}

/// Follow a dependency link in the issue being read (`State::follow_link`).
pub fn follow_link(s: &mut State, id: &str, tx: &mut Tx) {
    s.follow_link(id);
    s.scroll_to_selected(tx);
}

/// Show the issues as `layout` and bring the selected one into view there:
/// the toggle changes how the list is drawn, not where the reader is in it.
pub fn set_layout(s: &mut State, layout: Layout, tx: &mut Tx) {
    s.set_layout(layout);
    s.scroll_to_selected(tx);
}

/// `run` for a caller with no key to pass on: a menu item or a button.
pub fn perform(s: &mut State, command: Command, tx: &mut Tx) {
    run(s, command, tx);
}

/// Enter on the list: read the selected issue, or select the first one when
/// none is. Focus leaves whatever had it, so the keys that follow reach the
/// window (and through it the detail pane) instead of the table.
fn open(s: &mut State, tx: &mut Tx) {
    if s.issue.is_none() {
        if s.move_selection(Step::First).is_some() {
            s.scroll_to_selected(tx);
        }
    } else if s.open_detail() {
        tx.blur();
    }
}

/// Enter in the filter field: leave it for the list, on the first match
/// unless the selected issue is still among the matches.
pub fn submit_filter(s: &mut State, tx: &mut Tx) {
    tx.blur();
    if s.selected_row().is_none() && s.move_selection(Step::First).is_some() {
        s.scroll_to_selected(tx);
    }
}

/// The filter field's own keys: Down walks out of the field into the matches
/// (Esc would clear them first).
pub fn filter_key(s: &mut State, key: &KeyEvent, tx: &mut Tx) -> bool {
    if key.key != Key::Down || key.mods != rune::Mods::default() {
        return false;
    }
    tx.blur();
    run(s, Command::Select(Step::Next), tx)
}

/// Go to a row of quick open's list (`State::quick_choose`) and bring the
/// issue's row into view when the table already has it.
pub fn quick_choose(s: &mut State, row: usize, tx: &mut Tx) {
    if s.quick_choose(row).is_some() {
        s.scroll_to_selected(tx);
    }
}

/// The keys of quick open's field. The palette is a dialog, so the window's
/// `on_key` stands back and these are all of its keyboard: the arrows (and
/// Ctrl-N/Ctrl-P, as in a terminal) move through the list while the caret
/// stays in the field, Enter goes to the active row, and Esc or a second
/// Cmd-K closes it. Everything else is the field's.
pub fn quick_key(s: &mut State, key: &KeyEvent, tx: &mut Tx) -> bool {
    let Some(quick) = &s.quick else { return false };
    // An input method is composing: its Enter and arrows are its own.
    if quick.query.preedit.is_some() {
        return false;
    }
    let m = key.mods;
    let control = m.ctrl && !m.shift && !m.alt && !m.cmd;
    let plain = !m.ctrl && !m.alt && !m.cmd;
    let by = match &key.key {
        Key::Escape => {
            s.close_quick();
            return true;
        }
        Key::Command('k') if m.cmd && !m.shift && !m.alt => {
            if !tx.key_repeat() {
                s.close_quick();
            }
            return true;
        }
        Key::Enter if plain => {
            if !tx.key_repeat() {
                quick_choose(s, quick.active, tx);
            }
            return true;
        }
        Key::Down if plain => 1,
        Key::Up if plain => -1,
        Key::Text(c) if control && c == "n" => 1,
        Key::Text(c) if control && c == "p" => -1,
        Key::Command('n') if control => 1,
        Key::Command('p') if control => -1,
        _ => return false,
    };
    if let Some(row) = s.quick_move(by) {
        tx.scroll_into_view(quick_row_key(row));
    }
    true
}

/// The native menu bar (macOS). Every item runs through `run`. Items with a
/// key equivalent are `keys_first`: the key reaches the window like any
/// other, so `on_key` answers it once and a dialog can keep it; picking the
/// item with the pointer runs the command directly.
pub fn menu() -> Vec<MenuItem<State>> {
    type Action = fn(&mut State, &mut Tx);
    let chord = |accelerator: &str| accelerator.parse::<rune::Shortcut>().expect("a valid accelerator");
    let keyed = |title: &str, action: Action, accelerator: &str| {
        MenuItem::new(title, action).key_equivalent(chord(accelerator)).keys_first()
    };
    vec![
        // No menu named: the application menu, where macOS keeps Settings.
        keyed("Connection Settings…", |s, tx| perform(s, Command::Connection, tx), "cmd+,"),
        keyed("Filter Issues", |s, tx| perform(s, Command::Filter, tx), "cmd+f").menu("View"),
        keyed("Refresh", |s, tx| perform(s, Command::Refresh, tx), "cmd+r").menu("View"),
        MenuItem::separator().menu("View"),
        MenuItem::new("Switch Between Table and Board", |s, tx| perform(s, Command::SwitchLayout, tx)).menu("View"),
        MenuItem::new("Sort by Next Column", |s, tx| perform(s, Command::SortNext, tx)).menu("View"),
        MenuItem::new("Reverse Sort Order", |s, tx| perform(s, Command::SortReverse, tx)).menu("View"),
        MenuItem::separator().menu("View"),
        MenuItem::new("Switch Theme", |s, tx| perform(s, Command::Theme, tx)).menu("View"),
        keyed("Quick Open…", |s, tx| perform(s, Command::QuickOpen, tx), "cmd+k").menu("Go"),
        MenuItem::separator().menu("Go"),
        MenuItem::new("Next Issue", |s, tx| perform(s, Command::Select(Step::Next), tx)).menu("Go"),
        MenuItem::new("Previous Issue", |s, tx| perform(s, Command::Select(Step::Previous), tx)).menu("Go"),
        MenuItem::new("Read Issue", |s, tx| perform(s, Command::Open, tx)).menu("Go"),
        MenuItem::new("Back", |s, tx| perform(s, Command::Back, tx)).menu("Go"),
        MenuItem::separator().menu("Go"),
        keyed("Back Along Links", |s, tx| perform(s, Command::TrailBack, tx), "cmd+[").menu("Go"),
        keyed("Forward Along Links", |s, tx| perform(s, Command::TrailForward, tx), "cmd+]").menu("Go"),
        MenuItem::new("Copy Issue ID", |s, tx| perform(s, Command::CopyId, tx)).menu("Issue"),
        MenuItem::new("Copy Markdown Link", |s, tx| perform(s, Command::CopyLink, tx)).menu("Issue"),
        MenuItem::new("Open in Beadsmith Web", |s, tx| perform(s, Command::OpenWeb, tx)).menu("Issue"),
        MenuItem::new("Keyboard Shortcuts", |s, tx| perform(s, Command::Shortcuts, tx)).menu("Help"),
    ]
}

/// A row of the shortcuts list: the keys, any of which does it, and what it does.
pub type Shortcut = (&'static [&'static str], &'static str);

/// Every shortcut, as the overlay (`?`) and `desktop/README.md` list them; a
/// test keeps the README in step. `⌘` is Ctrl off macOS (`key_label`).
pub const SHORTCUTS: &[(&str, &[Shortcut])] = &[
    (
        "Issues",
        &[
            (&["j", "↓"], "Next issue"),
            (&["k", "↑"], "Previous issue"),
            (&["Home", "End"], "First or last issue"),
            (&["o", "Enter"], "Read the selected issue"),
            (&["y"], "Copy the selected issue's id"),
            (&["⇧Y"], "Copy a Markdown link to it in the web app"),
            (&["⇧O"], "Open it in the web app"),
            (&["s"], "Sort by the next column"),
            (&["⇧S"], "Reverse the sort"),
            (&["/", "⌘F"], "Filter issues"),
            (&["1–6"], "Status tab: All, Ready, Open, In progress, Blocked, Closed"),
            (&["v"], "Show the table or the board"),
            (&["h", "←"], "Board: previous column"),
            (&["l", "→"], "Board: next column"),
        ],
    ),
    (
        "Reading an issue",
        &[
            (&["j", "↓", "Space"], "Page down"),
            (&["k", "↑", "⇧Space"], "Page up"),
            (&["Home", "End"], "Top or bottom"),
            (&["Tab"], "Step through its links"),
            (&["⌘["], "Back to the issue a link was followed from"),
            (&["⌘]"], "Forward again"),
        ],
    ),
    (
        "Everywhere",
        &[
            (&["Esc"], "Back: leave the field or the issue, then clear the filters, then the selection"),
            (&["⌘K"], "Quick open: jump to a project, or to an issue in any project"),
            (&["⌘1–9"], "Switch to that project in the sidebar"),
            (&["r", "⌘R"], "Refresh"),
            (&["⌘,"], "Connection settings"),
            (&["t"], "Switch theme: auto, light, dark"),
            (&["?"], "Keyboard shortcuts"),
            (&["⌘W"], "Close the window"),
            (&["⌘Q"], "Quit"),
        ],
    ),
];

/// A key as this platform's keyboard names it.
pub fn key_label(key: &str) -> String {
    if cfg!(target_os = "macos") { key.to_string() } else { key.replace('⌘', "Ctrl+").replace('⇧', "Shift+") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::Mods;

    fn text(t: &str) -> KeyEvent {
        KeyEvent::from(Key::Text(t.into()))
    }

    fn cmd(c: char) -> KeyEvent {
        KeyEvent { key: Key::Command(c), mods: Mods { cmd: true, ..Mods::default() } }
    }

    #[test]
    fn list_keys_follow_the_web_app() {
        let list = |key: KeyEvent| command(&key, Pane::List, false);
        assert_eq!(list(text("j")), Some(Command::Select(Step::Next)));
        assert_eq!(list(Key::Down.into()), Some(Command::Select(Step::Next)));
        assert_eq!(list(text("k")), Some(Command::Select(Step::Previous)));
        assert_eq!(list(Key::Up.into()), Some(Command::Select(Step::Previous)));
        assert_eq!(list(Key::Home.into()), Some(Command::Select(Step::First)));
        assert_eq!(list(Key::End.into()), Some(Command::Select(Step::Last)));
        assert_eq!(list(text("o")), Some(Command::Open));
        assert_eq!(list(Key::Enter.into()), Some(Command::Open));
        assert_eq!(list(text("/")), Some(Command::Filter));
        assert_eq!(list(text("r")), Some(Command::Refresh));
        assert_eq!(list(text("?")), Some(Command::Shortcuts));
        assert_eq!(list(text("s")), Some(Command::SortNext));
        assert_eq!(list(text("S")), Some(Command::SortReverse));
        assert_eq!(list(Key::Escape.into()), Some(Command::Back));
        assert_eq!(list(Key::PageDown.into()), None, "the table pages itself");
        assert_eq!(list(text("v")), Some(Command::SwitchLayout));
        assert_eq!(list(text("h")), Some(Command::Lane(-1)));
        assert_eq!(list(Key::Left.into()), Some(Command::Lane(-1)));
        assert_eq!(list(text("l")), Some(Command::Lane(1)));
        assert_eq!(list(Key::Right.into()), Some(Command::Lane(1)));
        assert_eq!(list(text("y")), Some(Command::CopyId));
        assert_eq!(list(text("Y")), Some(Command::CopyLink));
        assert_eq!(list(text("O")), Some(Command::OpenWeb));
        assert_eq!(list(text("1")), Some(Command::Status(0)));
        assert_eq!(list(text("6")), Some(Command::Status(5)));
        assert_eq!(list(text("7")), None, "six tabs");
        assert_eq!(list(text("0")), None);
        assert_eq!(command(&text("2"), Pane::Detail, false), Some(Command::Status(1)));
        assert_eq!(list(text("x")), None);
    }

    #[test]
    fn the_same_keys_scroll_while_an_issue_is_read() {
        let detail = |key: KeyEvent| command(&key, Pane::Detail, false);
        assert_eq!(detail(text("j")), Some(Command::Scroll(Scroll::PageDown)));
        assert_eq!(detail(Key::Up.into()), Some(Command::Scroll(Scroll::PageUp)));
        assert_eq!(detail(Key::Home.into()), Some(Command::Scroll(Scroll::Top)));
        assert_eq!(detail(Key::End.into()), Some(Command::Scroll(Scroll::Bottom)));
        assert_eq!(detail(text(" ")), Some(Command::Scroll(Scroll::PageDown)));
        let shift_space = KeyEvent { key: Key::Text(" ".into()), mods: Mods { shift: true, ..Mods::default() } };
        assert_eq!(detail(shift_space), Some(Command::Scroll(Scroll::PageUp)));
        assert_eq!(detail(Key::Escape.into()), Some(Command::Back));
        for key in [text("h"), text("l"), Key::Left.into(), Key::Right.into()] {
            assert_eq!(detail(key), None, "an issue being read has no columns to cross");
        }
    }

    /// The shortcuts list pages by the same keys, and leaves the rest
    /// (Esc closes it, and a chord such as Cmd-Q still quits).
    #[test]
    fn the_reading_keys_page_the_shortcuts_list() {
        assert_eq!(reading_key(&text("j")), Some(Scroll::PageDown));
        assert_eq!(reading_key(&Key::PageUp.into()), Some(Scroll::PageUp));
        assert_eq!(reading_key(&Key::End.into()), Some(Scroll::Bottom));
        assert_eq!(reading_key(&Key::Escape.into()), None);
        assert_eq!(reading_key(&text("?")), None);
        assert_eq!(reading_key(&cmd('q')), None);
    }

    #[test]
    fn chords_work_from_a_field_and_plain_keys_do_not() {
        let typing = |key: KeyEvent| command(&key, Pane::List, true);
        assert_eq!(typing(cmd('f')), Some(Command::Filter));
        assert_eq!(typing(cmd('r')), Some(Command::Refresh));
        assert_eq!(typing(cmd(',')), Some(Command::Connection));
        assert_eq!(typing(cmd('k')), Some(Command::QuickOpen));
        assert_eq!(typing(cmd('1')), Some(Command::Project(0)));
        assert_eq!(typing(cmd('9')), Some(Command::Project(8)));
        assert_eq!(typing(cmd('0')), None);
        assert_eq!(typing(cmd('[')), Some(Command::TrailBack));
        assert_eq!(typing(cmd(']')), Some(Command::TrailForward));
        assert_eq!(typing(Key::Escape.into()), Some(Command::Back));
        for key in [
            text("j"),
            text("r"),
            text("/"),
            text("?"),
            text("v"),
            text("h"),
            text("y"),
            text("O"),
            text("1"),
            Key::Down.into(),
            Key::Enter.into(),
        ] {
            assert_eq!(typing(key), None);
        }
        let shifted = KeyEvent { key: Key::Command('r'), mods: Mods { cmd: true, shift: true, ..Mods::default() } };
        assert_eq!(command(&shifted, Pane::List, false), None, "another chord, not ours");
        let ctrl_j = KeyEvent { key: Key::Text("j".into()), mods: Mods { ctrl: true, ..Mods::default() } };
        assert_eq!(command(&ctrl_j, Pane::List, false), None);
    }

    #[test]
    fn only_moving_and_scrolling_repeat_while_held() {
        assert!(Command::Select(Step::Next).repeats() && Command::Scroll(Scroll::PageDown).repeats());
        assert!(Command::Lane(1).repeats() && !Command::SwitchLayout.repeats());
        assert!(!Command::Status(1).repeats());
        assert!(!Command::Refresh.repeats() && !Command::Open.repeats() && !Command::Back.repeats());
        assert!(!Command::TrailBack.repeats() && !Command::TrailForward.repeats());
        assert!(!Command::QuickOpen.repeats());
        assert!(!Command::CopyId.repeats() && !Command::CopyLink.repeats() && !Command::OpenWeb.repeats());
    }

    #[test]
    fn the_menu_is_valid_and_names_each_item_once() {
        let items = menu(); // Parses every accelerator.
        assert!(items.len() > 8);
    }

    /// The README's shortcut table is written by hand; this fails when a
    /// shortcut is added or reworded here and not there.
    #[test]
    fn the_readme_lists_every_shortcut() {
        let readme = include_str!("../README.md");
        for (_, rows) in SHORTCUTS {
            for (keys, does) in *rows {
                let line = readme
                    .lines()
                    .find(|line| line.starts_with('|') && line.contains(&format!("| {does} ")))
                    .unwrap_or_else(|| panic!("README.md does not list “{does}”"));
                for key in *keys {
                    assert!(line.contains(&format!("`{key}`")), "README.md: “{does}” does not name `{key}`");
                }
            }
        }
    }

    /// At the smallest window the board scrolls sideways. A card chosen by
    /// key brings its whole column into view, not only the card: the first
    /// and last columns with the board's padding beside them.
    #[test]
    fn a_column_moved_to_shows_whole_at_the_smallest_window() {
        use std::sync::Arc;

        use crate::app::BOARD_KEY;
        use crate::app::Load;
        use crate::model::Source;
        use crate::sample::Sample;
        use crate::settings::Backing;

        let mut s = State::new(Arc::new(Sample), Backing::detached());
        s.projects = Load::Ready(Sample.projects().unwrap());
        s.project = Some("lighthouse".into());
        s.issues = Load::Ready(Sample.issues("lighthouse").unwrap());
        s.refilter();
        s.set_layout(Layout::Board);
        s.issue = Some("lh-1".into());
        let mut rt = rune::Runtime::new(s, crate::view::view, (1100.0, 560.0), rune::Env::new(true, 1.0));
        let rect = |rt: &rune::Runtime<State>, key: &str| {
            rt.elements().into_iter().find(|e| e.key.as_deref() == Some(key)).unwrap_or_else(|| panic!("{key}")).rect
        };
        let mut step = |by: isize| {
            rt.update(|s, tx| assert!(run(s, Command::Lane(by), tx)));
            for _ in 0..60 {
                rt.frame(1.0 / 60.0);
            }
            let id = rt.state.issue.clone().unwrap();
            let lane = rt.state.selected_card().unwrap().0;
            let label = rt.state.lanes[lane].label;
            let (board, column) = (rect(&rt, BOARD_KEY), rect(&rt, &crate::app::lane_key(label)));
            let (left, right) = (column[0] - board[0], board[0] + board[2] - (column[0] + column[2]));
            (id, left, right)
        };
        let shown = |(id, left, right): (String, f32, f32)| (id, left >= 0.0 && right >= 0.0, left, right);
        // Blocked, a middle column, then Closed, the last: its right padding shows.
        let (id, whole, ..) = shown(step(1));
        assert_eq!((id.as_str(), whole), ("lh-4", true));
        let (id, whole, _, right) = shown(step(1));
        assert_eq!((id.as_str(), whole), ("lh-8", true));
        assert!(right >= 10.0, "the board's padding shows past the last column ({right})");
        // Back to In progress, then Open, the first: its left padding shows.
        let (id, whole, ..) = shown(step(-1));
        assert_eq!((id.as_str(), whole), ("lh-4", true));
        let (id, whole, ..) = shown(step(-1));
        assert_eq!((id.as_str(), whole), ("lh-1", true));
        let (id, whole, left, _) = shown(step(-1));
        assert_eq!((id.as_str(), whole), ("lh-2", true));
        assert!(left >= 10.0, "the board's padding shows before the first column ({left})");
    }
}
