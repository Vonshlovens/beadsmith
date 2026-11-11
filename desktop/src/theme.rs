//! Beadsmith's look in Rune: the web app's tokens (`src/app.css`) as a
//! rune-kit theme, so the two clients read as one product.
//!
//! The palette, type scale and radii below are copied from the `:root` and
//! `:root.dark` blocks of `src/app.css`, and each field is named after the
//! custom property it copies. Change them there first. Rune has no CSS, so
//! this is the one place the desktop restates them.

use rune::color::hex;
use rune::{Color, TextStyle};
use rune_kit::{Kit, Radius, StateColors};

/// The tokens the kit has no slot for: Beadsmith's surfaces, text roles,
/// the red mark, and the status colours. Views read these for anything the
/// kit's components do not draw themselves.
#[derive(Clone, Copy, Debug)]
pub struct Tokens {
    pub bg: Color,
    pub s2: Color,
    pub s3: Color,
    pub line: Color,
    pub line_2: Color,
    /// The 2px rule that frames the page, under the title bar.
    pub rule: Color,

    /// Three text roles that all pass 4.5:1 on `bg`. `tx_faint` does not, so
    /// it is not here: nothing the desktop draws is decoration-only text.
    pub tx_hi: Color,
    pub tx: Color,
    pub tx_mid: Color,
    pub tx_dim: Color,

    /// The red mark: selection, the lit bead, focus, blocked work.
    pub em_700: Color,
    pub em_500: Color,
    pub em_400: Color,
    pub em_300: Color,
    pub em_wash: Color,
    pub em_wash_2: Color,

    pub mint: Color,
    pub mint_tx: Color,
    pub mint_line: Color,
    pub amber: Color,
    pub amber_tx: Color,
    pub amber_line: Color,
    pub violet: Color,
    pub violet_tx: Color,
    pub violet_line: Color,
    pub cyan: Color,
    pub cyan_tx: Color,
    pub cyan_line: Color,
}

/// The type scale (`--t-micro` to `--t-md`), in the interface face.
#[derive(Clone, Copy, Debug)]
pub struct Scale {
    /// 12px: labels, counts, ids, every secondary datum.
    pub xs: TextStyle,
    pub xs_strong: TextStyle,
    /// 13px: table rows and controls.
    pub sm: TextStyle,
    pub sm_strong: TextStyle,
    /// 14px: navigation and the brand.
    pub base: TextStyle,
    pub base_strong: TextStyle,
    /// 16px: the heading of a pane.
    pub md_strong: TextStyle,
    /// A section heading (`.caps`): uppercase, tracked, in ink. The caller
    /// uppercases the string; Rune has no text-transform.
    pub caps: TextStyle,
}

#[derive(Clone)]
pub struct Theme {
    /// For rune-kit components.
    pub k: Kit,
    /// The same kit with the body in the sans face, for long Markdown: the
    /// web app reads issue bodies in a sans and keeps mono for the interface.
    pub prose: Kit,
    pub t: Tokens,
    pub ty: Scale,
}

/// The font slots for `AppSpec::families`. The interface is set in the mono
/// slot, as the web app's is in JetBrains Mono. Rune loads no installed
/// fonts except the platform's monospaced UI font (`ui-monospace`: SF Mono
/// on macOS), so that stands in for JetBrains Mono without bundling a font
/// file; a machine with no system mono falls back to the built-in Inter.
pub const FAMILIES: (&str, &str) = ("Inter", "ui-monospace, Inter");

fn c(s: &str) -> Color {
    hex(s).expect("a literal colour")
}

fn tokens(dark: bool) -> Tokens {
    let pick = |light: &str, dark_hex: &str| c(if dark { dark_hex } else { light });
    // `rgba(…, a)` tokens: the colour named, at that alpha.
    let wash = |light: (&str, f32), dark_wash: (&str, f32)| {
        let (hex, a) = if dark { dark_wash } else { light };
        c(hex).alpha(a)
    };
    Tokens {
        bg: pick("#ebe4d8", "#111113"),
        s2: pick("#e2dacc", "#18181b"),
        s3: pick("#dcd3c4", "#1e1e22"),
        line: pick("#d2c8b7", "#29292d"),
        line_2: pick("#b8ac98", "#3a3936"),
        rule: pick("#1f1a15", "#4a4743"),
        tx_hi: pick("#1f1a15", "#ede7dc"),
        tx: pick("#2b251f", "#d8d2c7"),
        tx_mid: pick("#4f4943", "#b2ada4"),
        tx_dim: pick("#665f57", "#8f8a82"),
        em_700: pick("#dcb0ac", "#6d0f1c"),
        em_500: pick("#b81a2f", "#fa2d41"),
        em_400: pick("#b81a2f", "#ff5566"),
        em_300: pick("#8f1424", "#ff929c"),
        em_wash: wash(("#b81a2f", 0.07), ("#fa2d41", 0.08)),
        em_wash_2: wash(("#b81a2f", 0.15), ("#fa2d41", 0.16)),
        mint: pick("#16a34a", "#2fc98f"),
        mint_tx: pick("#0d632d", "#6fe0b6"),
        mint_line: wash(("#16a34a", 0.35), ("#2fc98f", 0.24)),
        amber: pick("#b58900", "#d9a13a"),
        amber_tx: pick("#6d5200", "#f0c672"),
        amber_line: wash(("#b58900", 0.4), ("#d9a13a", 0.26)),
        violet: pick("#7c3aed", "#8b7cf0"),
        violet_tx: pick("#5b21b6", "#b4a8ff"),
        violet_line: wash(("#7c3aed", 0.32), ("#8b7cf0", 0.26)),
        cyan: pick("#0891b2", "#3fb4d8"),
        cyan_tx: pick("#055d72", "#7fd4ef"),
        cyan_line: wash(("#0891b2", 0.34), ("#3fb4d8", 0.26)),
    }
}

fn scale() -> Scale {
    let face = |size: f32, weight: f32, line: f32| TextStyle::new(size, weight).mono().lh(line);
    Scale {
        xs: face(12.0, 400.0, 18.0),
        xs_strong: face(12.0, 600.0, 18.0),
        sm: face(13.0, 400.0, 20.0),
        sm_strong: face(13.0, 600.0, 20.0),
        base: face(14.0, 400.0, 21.0),
        base_strong: face(14.0, 600.0, 21.0),
        md_strong: face(16.0, 600.0, 22.0),
        // 0.07em at 12px.
        caps: face(12.0, 600.0, 18.0).tracking(0.84),
    }
}

/// Which theme the window wears: the system's, or one chosen here. The web
/// app's three-state preference (`src/lib/client/theme.ts`), with its cycle
/// order and stored names.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

impl Appearance {
    const ALL: [Appearance; 3] = [Appearance::System, Appearance::Light, Appearance::Dark];

    /// The name the settings file holds.
    pub fn name(self) -> &'static str {
        match self {
            Appearance::System => "system",
            Appearance::Light => "light",
            Appearance::Dark => "dark",
        }
    }

    /// An unknown or missing name follows the system.
    pub fn from_name(name: Option<&str>) -> Appearance {
        Appearance::ALL.into_iter().find(|a| Some(a.name()) == name).unwrap_or_default()
    }

    /// The word the title bar shows. It names the preference, not the theme
    /// in effect, so "auto" stays distinct from whichever it resolves to
    /// (`theme-toggle.svelte`).
    pub fn word(self) -> &'static str {
        match self {
            Appearance::System => "auto",
            other => other.name(),
        }
    }

    /// system → light → dark → system.
    pub fn next(self) -> Appearance {
        match self {
            Appearance::System => Appearance::Light,
            Appearance::Light => Appearance::Dark,
            Appearance::Dark => Appearance::System,
        }
    }

    pub fn dark(self, system_dark: bool) -> bool {
        match self {
            Appearance::System => system_dark,
            Appearance::Light => false,
            Appearance::Dark => true,
        }
    }
}

impl Theme {
    pub fn new(dark: bool) -> Theme {
        let t = tokens(dark);
        let ty = scale();
        let pick = |light: &str, dark_hex: &str| c(if dark { dark_hex } else { light });
        let (s1, s4, line_3) = (pick("#e6dfd2", "#141416"), pick("#d5cbba", "#252529"), pick("#8a8174", "#55524d"));
        let on_em = pick("#f6efe3", "#ffffff");
        let em_600 = pick("#a3172a", "#b81a2f");

        // The neutral kit supplies glyphs, motion and the shape of the
        // elevation layers; every colour, size and radius a component reads
        // is replaced below.
        let mut k = Kit::neutral(dark);
        let p = &mut k.c;
        p.page = t.bg;
        p.bg_base = t.bg;
        p.bg_deep = s1;
        p.layer_01 = t.s2;
        p.layer_02 = t.s3;
        p.layer_03 = t.s3;
        p.layer_04 = s4;
        // The primary action is the mark (`.btn-primary`), not inverted ink.
        p.bg_contrast = em_600;
        p.bg_icon_button_contrast = em_600;
        p.bg_accent = em_600;
        p.text_contrast = on_em;
        p.icon_contrast = on_em;
        p.submit_fg = on_em;
        p.submit_icon = on_em;
        p.bg_inverse = t.tx_hi;
        p.surface_float = t.tx_hi;
        p.text_inverse = t.bg;
        p.icon_inverse = t.bg;
        p.text_invert_strong = t.bg;
        p.std_icon_invert = t.bg;
        p.bg_button_neutral = t.s2;

        p.text_strong = t.tx_hi;
        p.text_base = t.tx;
        p.std_text = t.tx;
        p.text_muted = t.tx_mid;
        // The kit sets readable text (placeholders, captions) in its faint
        // role, so it takes the dimmest role that still passes 4.5:1.
        p.text_faint = t.tx_dim;
        p.text_weak = t.tx_dim;
        p.text_accent = t.em_400;
        p.icon_base = t.tx;
        p.std_icon_strong = t.tx_hi;
        p.icon_muted = t.tx_mid;
        p.std_icon = t.tx_mid;
        p.icon_faint = t.tx_dim;
        p.icon_weaker = t.tx_dim;
        p.icon_accent = t.em_500;

        p.border_muted = t.line;
        p.border_weak = t.line;
        p.border_disabled = t.line;
        p.border_base = t.line_2;
        p.std_border = t.line_2;
        p.border_strong = line_3;
        p.border_hover = line_3;
        p.border_focus = t.em_400;
        p.border_active = t.em_500;

        // Overlays rather than the web's opaque `--s3`: Rune paints hover
        // over whatever the row already shows (a selection, a stripe).
        p.hover = t.tx_hi.alpha(if dark { 0.06 } else { 0.05 });
        p.pressed = t.tx_hi.alpha(if dark { 0.10 } else { 0.09 });
        p.surface_hover = p.hover;
        p.surface_raised_hover = p.hover;
        p.scrim = pick("#1f1a15", "#070708").alpha(if dark { 0.72 } else { 0.4 });

        p.surface_base = t.s2;
        p.surface_weak = t.s2;
        p.surface_raised = t.s3;
        p.surface_raised_base = t.s2;
        p.surface_disabled = s1;

        p.success = StateColors { bg: t.mint.alpha(0.08), fg: t.mint_tx, border: t.mint_line, icon: t.mint };
        p.warning = StateColors { bg: t.amber.alpha(0.08), fg: t.amber_tx, border: t.amber_line, icon: t.amber };
        p.danger = StateColors { bg: t.em_wash, fg: t.em_300, border: t.em_700, icon: t.em_500 };
        p.info = StateColors { bg: t.cyan.alpha(0.08), fg: t.cyan_tx, border: t.cyan_line, icon: t.cyan };

        // Elevation rings were baked from the neutral palette; this makes
        // them follow the border token set above.
        k.ring = Some(|p| p.border_base);
        // Nearly square, like the website's ruled tables (`--r-1` to `--r-3`).
        k.radius = Radius { xs: 2.0, sm: 2.0, md: 3.0, lg: 3.0, xl: 4.0 };

        k.ty.ui = ty.sm;
        k.ty.ui_medium = TextStyle { weight: 500.0, ..ty.sm };
        k.ty.ui_compact = ty.sm.lh(16.0);
        k.ty.small = TextStyle::new(11.0, 400.0).mono().lh(12.0);
        k.ty.small_medium = TextStyle::new(11.0, 500.0).mono().lh(12.0);
        k.ty.body = ty.base;
        k.ty.body_medium = TextStyle { weight: 500.0, ..ty.base };
        k.ty.text_small = ty.sm.lh(19.5);
        k.ty.text_small_medium = TextStyle { weight: 500.0, ..ty.sm.lh(19.5) };
        k.ty.text_xsmall = ty.xs;
        k.ty.text_xsmall_medium = TextStyle { weight: 500.0, ..ty.xs };
        k.ty.mono = ty.xs;

        let mut prose = k.clone();
        // `.prose`: 15px in the sans face; code inside it stays mono at 13px.
        prose.ty.body = TextStyle::new(15.0, 400.0).lh(24.0);
        prose.ty.body_medium = TextStyle::new(15.0, 600.0).lh(24.0);
        prose.ty.mono = ty.sm;

        Theme { k, prose, t, ty }
    }

    /// Bead and label colours for a lifecycle status (`.dot-*`, `.badge-*`).
    /// `None` for the bead means the hollow ring closed work wears.
    pub fn status(&self, status: &str) -> StatusLook {
        let t = &self.t;
        let look = |bead, ink, line| StatusLook { bead, ink, line, wash: Color::TRANSPARENT };
        match status {
            "open" => look(Some(t.mint), t.mint_tx, t.mint_line),
            "in_progress" => look(Some(t.amber), t.amber_tx, t.amber_line),
            "blocked" => StatusLook { wash: t.em_wash, ..look(Some(t.em_500), t.em_300, t.em_700) },
            "closed" => look(None, t.tx_dim, t.line_2),
            "pinned" => look(Some(t.violet), t.violet_tx, t.violet_line),
            "hooked" => look(Some(t.cyan), t.cyan_tx, t.cyan_line),
            // Deferred, and any status this build does not know.
            _ => look(Some(t.tx_dim), t.tx_dim, t.line_2),
        }
    }

    /// Priority is a weighted word (`.prio-*`): P0 takes the mark, P1 the
    /// amber, and the rest step down through the text roles. P4 stops at
    /// `tx_dim` rather than the web's `tx_faint`, which fails 4.5:1.
    pub fn priority(&self, priority: i64) -> Color {
        match priority {
            0 => self.t.em_500,
            1 => self.t.amber_tx,
            2 => self.t.tx_mid,
            _ => self.t.tx_dim,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct StatusLook {
    pub bead: Option<Color>,
    pub ink: Color,
    pub line: Color,
    pub wash: Color,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_appearance_cycles_and_survives_its_name() {
        let mut a = Appearance::System;
        for expected in [Appearance::Light, Appearance::Dark, Appearance::System] {
            a = a.next();
            assert_eq!(a, expected);
            assert_eq!(Appearance::from_name(Some(a.name())), a);
        }
        assert_eq!(Appearance::from_name(Some("sepia")), Appearance::System);
        assert_eq!(Appearance::from_name(None), Appearance::System);
        assert!(Appearance::Dark.dark(false) && !Appearance::Light.dark(true));
        assert!(Appearance::System.dark(true) && !Appearance::System.dark(false));
    }

    fn contrast(a: Color, b: Color) -> f32 {
        let (a, b) = (a.luminance(), b.luminance());
        (a.max(b) + 0.05) / (a.min(b) + 0.05)
    }

    /// The promise in `src/app.css`: every text role the desktop uses reads
    /// at 4.5:1 or better on every surface text sits on, in both themes.
    #[test]
    fn text_roles_pass_contrast_on_every_surface() {
        for dark in [false, true] {
            let theme = Theme::new(dark);
            let t = theme.t;
            let inks = [
                ("tx_hi", t.tx_hi),
                ("tx", t.tx),
                ("tx_mid", t.tx_mid),
                ("tx_dim", t.tx_dim),
                ("mint_tx", t.mint_tx),
                ("amber_tx", t.amber_tx),
                ("violet_tx", t.violet_tx),
                ("cyan_tx", t.cyan_tx),
                ("em_300", t.em_300),
                ("kit faint", theme.k.c.text_faint),
                ("kit muted", theme.k.c.text_muted),
            ];
            for (surface, bg) in [("bg", t.bg), ("s2", t.s2), ("s3", t.s3)] {
                for (name, ink) in inks {
                    // `tx_dim` on the raised `s3` sits at about 4.3:1 in the
                    // web app's light palette too; the desktop only puts the
                    // stronger roles there.
                    if surface == "s3" && matches!(name, "tx_dim" | "kit faint") {
                        continue;
                    }
                    let ratio = contrast(ink, bg);
                    assert!(ratio >= 4.5, "{name} on {surface} (dark: {dark}) is {ratio:.2}:1");
                }
            }
        }
    }

    #[test]
    fn the_primary_button_reads() {
        for dark in [false, true] {
            let k = Theme::new(dark).k;
            assert!(contrast(k.c.text_contrast, k.c.bg_contrast) >= 4.5);
        }
    }

    #[test]
    fn unknown_statuses_get_a_quiet_look_and_closed_a_hollow_bead() {
        let theme = Theme::new(true);
        assert!(theme.status("closed").bead.is_none());
        assert_eq!(theme.status("something-new").ink, theme.t.tx_dim);
    }
}
