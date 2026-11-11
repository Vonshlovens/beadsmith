//! Quick open's matching and ranking: what a typed query finds among the
//! projects and the issues the server offered, and in what order.
//!
//! The server only gathers candidates (`Source::search`): issues whose id or
//! title holds the query's characters in order. That is deliberately loose,
//! so a typo-free fragment of either finds the issue, and it is the same test
//! [`score`] applies. The order is decided here, in one place, for projects
//! and issues alike, so the list reads best-first whatever the server's order.

use crate::model::{Hit, Project};

/// The longest query sent to the server, in characters. Each character is a
/// wildcard segment of the `LIKE` pattern, so the pattern is bounded too.
pub const MAX_QUERY: usize = 64;
/// The most results the list offers. Past the first screens a longer query
/// is the faster way to an issue than scrolling.
pub const MAX_RESULTS: usize = 50;

/// Where quick open can go.
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    Project(String),
    Issue(Hit),
}

// How well a text matches, in tiers a tie-break never crosses: each tier is
// further from the next than the widest bonus or penalty within one.
const EXACT: i32 = 4000;
const PREFIX: i32 = 3000;
/// The query starts a word inside the text.
const WORD: i32 = 2000;
/// The query sits inside a word.
const INSIDE: i32 = 1000;
/// The most a scattered match scores before brevity, so the best of them
/// stays under the worst match in one piece (`INSIDE - BREVITY`).
const SCATTERED_MOST: i32 = 700;
/// The longest text length that still costs rank, so brevity breaks ties
/// without lifting a short weak match over a long strong one.
const BREVITY: usize = 200;

/// An id is what people type when they know the issue, so a match on it
/// outranks the same kind of match on a title, and a project's name sits
/// between the two.
const ID_BONUS: i32 = 500;
const PROJECT_BONUS: i32 = 250;

/// A query as it is matched and sent: trimmed, lower-cased, and capped.
pub fn needle(query: &str) -> String {
    query.trim().to_lowercase().chars().take(MAX_QUERY).collect()
}

/// How well `text` matches `needle` (from [`needle`]), or `None` when it does
/// not hold the needle's characters in order. Case is ignored. Whole and
/// leading matches rank above matches at a word start, those above matches
/// inside a word, and scattered characters last, where runs and word starts
/// count for more; among equals the shorter text wins.
pub fn score(needle: &str, text: &str) -> Option<i32> {
    let hay = text.to_lowercase();
    let brevity = -(hay.chars().count().min(BREVITY) as i32);
    if hay == needle {
        return Some(EXACT);
    }
    if let Some(at) = hay.find(needle) {
        let mid_word = hay[..at].chars().next_back().is_some_and(char::is_alphanumeric);
        let tier = match (at, mid_word) {
            (0, _) => PREFIX,
            (_, false) => WORD,
            (_, true) => INSIDE,
        };
        return Some(tier + brevity);
    }
    let mut wanted = needle.chars().peekable();
    let (mut run, mut word_start, mut points) = (false, true, 0);
    for c in hay.chars() {
        if wanted.peek() == Some(&c) {
            wanted.next();
            points += 2 + if run { 3 } else { 0 } + if word_start { 8 } else { 0 };
            run = true;
        } else {
            run = false;
        }
        word_start = !c.is_alphanumeric();
    }
    // Capped below the tier above, however long the query.
    wanted.peek().is_none().then_some(points.min(SCATTERED_MOST) + brevity)
}

/// Whether an issue is a candidate for `needle`: the test the server's
/// `LIKE` applies, for sources that hold their issues in memory.
pub fn matches(needle: &str, id: &str, title: &str) -> bool {
    score(needle, id).or_else(|| score(needle, title)).is_some()
}

/// The list for `query`: the projects and candidate issues that match it,
/// best first, at most [`MAX_RESULTS`]. With nothing typed it is the projects
/// in sidebar order, so quick open is also a project switcher. Equal scores
/// keep the order they came in (projects first, then the server's order,
/// which puts recent issues first).
pub fn rank(query: &str, projects: &[Project], hits: &[Hit]) -> Vec<Target> {
    let needle = needle(query);
    if needle.is_empty() {
        return projects.iter().map(|p| Target::Project(p.name.clone())).collect();
    }
    let projects = projects
        .iter()
        .filter_map(|p| Some((score(&needle, &p.name)? + PROJECT_BONUS, Target::Project(p.name.clone()))));
    let issues = hits.iter().filter_map(|hit| {
        let id = score(&needle, &hit.id).map(|s| s + ID_BONUS);
        Some((id.max(score(&needle, &hit.title))?, Target::Issue(hit.clone())))
    });
    let mut found: Vec<(i32, Target)> = projects.chain(issues).collect();
    found.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
    found.into_iter().take(MAX_RESULTS).map(|(_, target)| target).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Source;
    use crate::sample::Sample;

    fn hit(project: &str, id: &str, title: &str) -> Hit {
        Hit { project: project.into(), id: id.into(), title: title.into(), status: "open".into() }
    }

    /// The ranked list in short: project names, and issue ids.
    fn names(found: &[Target]) -> Vec<&str> {
        found
            .iter()
            .map(|t| match t {
                Target::Project(name) => name.as_str(),
                Target::Issue(hit) => hit.id.as_str(),
            })
            .collect()
    }

    fn sample(query: &str) -> Vec<Target> {
        let projects = Sample.projects().unwrap();
        let databases: Vec<String> = projects.iter().map(|p| p.name.clone()).collect();
        rank(query, &projects, &Sample.search(&databases, &needle(query)).unwrap())
    }

    #[test]
    fn a_query_is_trimmed_lowered_and_capped() {
        assert_eq!(needle("  LH-4 "), "lh-4");
        assert_eq!(needle(&"x".repeat(200)).len(), MAX_QUERY);
        assert_eq!(needle("   "), "");
    }

    #[test]
    fn closer_matches_score_higher() {
        let of = |text: &str| score("lamp", text).unwrap_or_else(|| panic!("{text} matches"));
        assert!(of("Lamp") > of("Lamp schedule"), "the whole text beats a prefix");
        assert!(of("Lamp schedule") > of("Rotate the lamp"), "a prefix beats a later word");
        assert!(of("Rotate the lamp") > of("Streetlamps"), "a word start beats the inside of a word");
        assert!(of("Streetlamps") > of("Log a map"), "a run beats scattered characters");
        assert!(of("Lamp oil") > of("Lamp schedule for winter"), "among equals the shorter text wins");
        assert_eq!(score("lamp", "Fog horn"), None);
        assert_eq!(score("pml", "lamp"), None, "the characters must come in order");
        // Runs and word starts lift a scattered match.
        assert!(score("rtl", "Rotate the lamp") > score("rtl", "Mortal"));
    }

    #[test]
    fn nothing_typed_lists_the_projects_in_sidebar_order() {
        assert_eq!(names(&sample("")), ["lighthouse", "pantry"]);
        assert_eq!(names(&sample("   ")), ["lighthouse", "pantry"]);
    }

    #[test]
    fn an_id_from_any_project_comes_first() {
        let found = sample("pa-2");
        assert_eq!(
            found[0],
            Target::Issue(hit("pantry", "pa-2", "Barcode scan reads 0 as O")).with_status("in_progress")
        );
        // A whole id outranks ids it only starts.
        let hits = [hit("pantry", "pa-12", "Twelve"), hit("pantry", "pa-1", "One"), hit("pantry", "pa-100", "Hundred")];
        assert_eq!(names(&rank("PA-1", &[], &hits)), ["pa-1", "pa-12", "pa-100"]);
    }

    #[test]
    fn ids_then_projects_then_titles_at_the_same_closeness() {
        let projects = Sample.projects().unwrap();
        let hits = [hit("lighthouse", "lh-8", "Pantry door sticks"), hit("pantry", "pantry-1", "Shelf")];
        // All three start with the query: the id, the project, the title.
        assert_eq!(names(&rank("pantry", &projects, &hits)), ["pantry", "pantry-1", "lh-8"]);
        assert_eq!(names(&rank("pan", &projects, &hits)), ["pantry-1", "pantry", "lh-8"]);
    }

    #[test]
    fn titles_match_loosely_and_rank_by_closeness() {
        let found = sample("gasket");
        assert_eq!(names(&found)[..2], ["lh-5", "lh-4"], "“Order the gasket kit” is the shorter title");
        let found = sample("fghrn");
        assert_eq!(names(&found), ["lh-2"], "scattered characters still find “Fog horn …”");
        assert!(sample("zzzz").is_empty());
    }

    #[test]
    fn ties_keep_the_order_they_came_in_and_the_list_is_capped() {
        let hits: Vec<Hit> = (0..80).map(|n| hit("p", &format!("x-{n:02}"), "Same title")).collect();
        let found = rank("same", &[], &hits);
        assert_eq!(found.len(), MAX_RESULTS);
        assert_eq!(names(&found)[..3], ["x-00", "x-01", "x-02"]);
    }

    impl Target {
        fn with_status(self, status: &str) -> Target {
            match self {
                Target::Issue(hit) => Target::Issue(Hit { status: status.into(), ..hit }),
                project => project,
            }
        }
    }
}
