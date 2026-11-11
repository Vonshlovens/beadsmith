//! Where the window sits on the desktop, so a relaunch reopens it there.
//!
//! Rune can place a window (`WindowOptions::position`) but cannot say where
//! one is, so on macOS the frame is read from AppKit through the window's
//! raw handle when it closes. The origin is kept in points, top-left, in the
//! global space whose origin is the top-left of the menu-bar display: the
//! space winit flips AppKit's bottom-left frames into. Points rather than
//! pixels, because a pixel position means a different place once a display
//! of another scale is attached or the main display changes.
//!
//! A saved origin is used only while the window's title bar would still land
//! on an attached display's visible area (below the menu bar, beside the
//! Dock): a window reopened on a display that has gone, or tucked under the
//! menu bar, could not be dragged back. Otherwise the window opens where it
//! always did, centred on the main display.
//!
//! Elsewhere the window opens at the default placement and nothing is saved.

/// How much of the window's top edge must land on one display's visible
/// area, in points: enough of the title bar (`view::title_bar` is 44pt) to
/// grab and drag the window back into view.
const GRAB: (f64, f64) = (120.0, 30.0);

/// Whether a window of `size` points with its top-left at `origin` keeps
/// enough of its title bar on one of `screens` (visible areas as
/// `[x, y, w, h]`, points, top-left) to be dragged.
pub fn reachable(origin: (f64, f64), size: (f32, f32), screens: &[[f64; 4]]) -> bool {
    let (x, y) = origin;
    let w = f64::from(size.0);
    if !(x.is_finite() && y.is_finite()) {
        return false;
    }
    screens.iter().any(|&[sx, sy, sw, sh]| {
        let across = (x + w).min(sx + sw) - x.max(sx);
        let down = (y + GRAB.1).min(sy + sh) - y.max(sy);
        across >= GRAB.0 && down >= GRAB.1
    })
}

/// A saved origin in points as the physical position winit opens a window
/// at: it divides by the main screen's scale when it makes the window.
pub fn to_physical((x, y): (f64, f64), scale: f64) -> (i32, i32) {
    ((x * scale).round() as i32, (y * scale).round() as i32)
}

#[cfg(target_os = "macos")]
mod native {
    use std::cell::RefCell;

    use objc2::rc::Retained;
    use objc2_app_kit::{NSScreen, NSView, NSWindow, NSWindowStyleMask};
    use objc2_foundation::{MainThreadMarker, NSRect};
    use rune::WindowHandle;
    use rune::raw_window_handle::RawWindowHandle;

    thread_local! {
        /// The app window, from `App::on_window`. AppKit is main-thread
        /// only and so are both callbacks that use it.
        static WINDOW: RefCell<Option<WindowHandle>> = const { RefCell::new(None) };
    }

    pub fn track(handle: &WindowHandle) {
        WINDOW.with(|w| *w.borrow_mut() = Some(handle.clone()));
    }

    /// The height of the display with the menu bar, whose bottom-left is
    /// AppKit's origin: `screens[0]`, as winit's flip uses `CGMainDisplayID`.
    fn flip_height(mtm: MainThreadMarker) -> Option<f64> {
        let screens = NSScreen::screens(mtm);
        screens.iter().next().map(|main| main.frame().size.height)
    }

    /// `rect`'s top-left in the top-left global space.
    fn top_left(rect: NSRect, height: f64) -> (f64, f64) {
        (rect.origin.x, height - rect.origin.y - rect.size.height)
    }

    fn ns_window(handle: &WindowHandle) -> Option<Retained<NSWindow>> {
        handle
            .with_raw_handle(|raw| {
                let RawWindowHandle::AppKit(appkit) = raw.as_raw() else { return None };
                // SAFETY: the view is winit's content view, alive while the
                // handle's window is, which `with_raw_handle` holds for this call;
                // retaining it keeps it alive past the call.
                let view: Option<Retained<NSView>> = unsafe { Retained::retain(appkit.ns_view.as_ptr().cast()) };
                view?.window()
            })
            .ok()
            .flatten()
    }

    /// The window's top-left now, in points; `None` without a window, off
    /// the main thread, or in full screen, whose frame is the display's.
    pub fn origin() -> Option<(f64, f64)> {
        let mtm = MainThreadMarker::new()?;
        let window = WINDOW.with(|w| w.borrow().as_ref().and_then(ns_window))?;
        if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
            return None;
        }
        Some(top_left(window.frame(), flip_height(mtm)?))
    }

    /// Each attached display's visible area, top-left, in points.
    pub fn screens() -> Vec<[f64; 4]> {
        let Some(mtm) = MainThreadMarker::new() else { return Vec::new() };
        let Some(height) = flip_height(mtm) else { return Vec::new() };
        NSScreen::screens(mtm)
            .iter()
            .map(|screen| {
                let area = screen.visibleFrame();
                let (x, y) = top_left(area, height);
                [x, y, area.size.width, area.size.height]
            })
            .collect()
    }

    /// The scale winit converts a physical position by when it makes the
    /// window: the main screen's (`NSScreen::mainScreen`).
    pub fn scale() -> Option<f64> {
        NSScreen::mainScreen(MainThreadMarker::new()?).map(|s| s.backingScaleFactor())
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    pub fn track(_: &rune::WindowHandle) {}
    pub fn origin() -> Option<(f64, f64)> {
        None
    }
    pub fn screens() -> Vec<[f64; 4]> {
        Vec::new()
    }
    pub fn scale() -> Option<f64> {
        None
    }
}

pub use native::{origin, track};

/// The physical position to open a window of `size` at, from the saved
/// origin, when that still lands on an attached display.
pub fn restore(saved: Option<(f64, f64)>, size: (f32, f32)) -> Option<(i32, i32)> {
    let saved = saved?;
    if !reachable(saved, size, &native::screens()) {
        return None;
    }
    Some(to_physical(saved, native::scale()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 1512×982 laptop with the menu bar (25pt) and a Dock at the bottom,
    /// and a 1920×1080 display to its right, its top 100pt higher.
    const SCREENS: [[f64; 4]; 2] = [[0.0, 25.0, 1512.0, 890.0], [1512.0, -100.0, 1920.0, 1080.0]];
    const SIZE: (f32, f32) = (1440.0, 880.0);

    #[test]
    fn a_window_on_a_display_is_reachable() {
        assert!(reachable((36.0, 60.0), SIZE, &SCREENS));
        assert!(reachable((1600.0, -80.0), SIZE, &SCREENS), "the second display, above the first's top");
        assert!(reachable((-1300.0, 200.0), SIZE, &SCREENS), "hanging off the left with 140pt left on");
    }

    #[test]
    fn a_window_whose_title_bar_cannot_be_grabbed_is_not() {
        assert!(!reachable((36.0, 60.0), SIZE, &[]), "no displays");
        assert!(!reachable((4000.0, 60.0), SIZE, &SCREENS), "a display that has gone");
        assert!(!reachable((36.0, 0.0), SIZE, &SCREENS), "under the menu bar");
        assert!(!reachable((-1340.0, 200.0), SIZE, &SCREENS), "only 100pt of bar on screen");
        assert!(!reachable((36.0, 900.0), SIZE, &SCREENS), "below the visible area");
        assert!(!reachable((f64::NAN, 60.0), SIZE, &SCREENS));
    }

    #[test]
    fn the_origin_opens_at_the_main_screen_scale() {
        assert_eq!(to_physical((36.0, 60.5), 2.0), (72, 121));
        assert_eq!(to_physical((-1300.0, 200.0), 1.0), (-1300, 200));
    }
}
