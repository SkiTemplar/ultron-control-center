// ULTRON Control Center — Memory Highlights & Link Graph module.
//
// Replaces the deterministic-hash 2D scatter (memory_graph.rs) with two
// data products the UI actually finds interesting:
//
//   1. compute_memory_highlights — curated "interesting" sections:
//      most_linked, recently_active, by_topic, orphans, long_form.
//   2. compute_memory_link_graph — node/edge list for an Obsidian-style
//      force-directed graph. Edges come from `[[wikilinks]]` in note
//      bodies. IMPORTANT: the current vault contains ZERO wikilinks, so
//      we also emit tag-similarity edges (Jaccard > 0.34, capped) as a
//      fallback. The UI surfaces which mode produced the graph.
//
// No external dependencies beyond what Cargo.toml already pins: serde,
// dirs, std::fs walker (reuses the pattern from memory.rs).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

const MAX_GRAPH_NODES: usize = 200;
const MIN_LONG_FORM_BYTES: u64 = 2048;
const TAG_EDGE_JACCARD_MIN: f32 = 0.34;
const TAG_EDGE_CAP_PER_NODE: usize = 4;

// ---------------------------------------------------------------------------
// Public types (serialized to the frontend)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct NoteWithLinks {
    pub path: String,
    pub relative: String,
    pub title: String,
    pub tags: Vec<String>,
    pub category: Option<String>,
    pub size_bytes: u64,
    pub last_modified: Option<String>,
    pub inbound: u32,
    pub outbound: u32,
    pub snippet: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct RecentNote {
    pub path: String,
    pub relative: String,
    pub title: String,
    pub tags: Vec<String>,
    pub category: Option<String>,
    pub size_bytes: u64,
    pub last_modified: Option<String>,
    pub snippet: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct MemoryHighlights {
    pub most_linked: Vec<NoteWithLinks>,
    pub recently_active: Vec<RecentNote>,
    pub by_topic: BTreeMap<String, Vec<RecentNote>>,
    pub orphans: Vec<RecentNote>,
    pub long_form: Vec<RecentNote>,
    pub computed_at: String,
    pub total_notes: usize,
    pub total_wikilinks: usize,
}

#[derive(Debug, Serialize, Clone)]
pub struct GraphNode {
    pub id: String,
    pub title: String,
    pub path: String,
    pub category: Option<String>,
    pub tags: Vec<String>,
    pub size_bytes: u64,
    pub last_modified: Option<String>,
    pub snippet: String,
    pub inbound: u32,
    pub outbound: u32,
}

#[derive(Debug, Serialize, Clone)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    /// "wikilink" or "tag" — UI styles them differently.
    pub kind: String,
    pub weight: f32,
}

#[derive(Debug, Serialize, Clone)]
pub struct MemoryLinkGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    /// "wikilinks" if at least one wikilink edge exists. Otherwise "tags"
    /// — surfaces to the UI so we can show a banner explaining the
    /// fallback to the user.
    pub edge_source: String,
    pub computed_at: String,
}

// ---------------------------------------------------------------------------
// Internal: raw note record built once, reused by both products.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct RawNote {
    path: PathBuf,
    relative: String,
    /// Title from H1 or first non-frontmatter heading, falling back to
    /// the filename stem. Lower-cased for cross-note link resolution.
    title: String,
    title_lower: String,
    /// Stem of the file (filename without extension). Also used as a
    /// secondary key for wikilink resolution (Obsidian falls back to
    /// filename when no H1 matches).
    stem_lower: String,
    tags: Vec<String>,
    category: Option<String>,
    size_bytes: u64,
    mtime: Option<SystemTime>,
    last_modified_iso: Option<String>,
    /// Snippet: first ~200 chars of body (post-frontmatter, whitespace
    /// collapsed). Used for both highlights and graph tooltips.
    snippet: String,
    /// Wikilink targets found in the body — kept as raw strings, will
    /// be resolved to RawNote indices in a second pass.
    wikilink_targets: Vec<String>,
}

// ---------------------------------------------------------------------------
// Filesystem walker (same pattern as memory.rs — no walkdir dep)
// ---------------------------------------------------------------------------

struct WalkIter {
    stack: Vec<PathBuf>,
}

fn walkdir(root: &Path) -> WalkIter {
    WalkIter {
        stack: vec![root.to_path_buf()],
    }
}

impl Iterator for WalkIter {
    type Item = PathBuf;
    fn next(&mut self) -> Option<Self::Item> {
        while let Some(p) = self.stack.pop() {
            let Ok(meta) = fs::metadata(&p) else { continue };
            if meta.is_dir() {
                if let Ok(rd) = fs::read_dir(&p) {
                    for child in rd.flatten() {
                        let name = child.file_name();
                        let s = name.to_string_lossy();
                        // Skip hidden dirs (.obsidian, .git, etc.) and
                        // the _archive folder the user uses for retired
                        // notes — orphans would otherwise be polluted
                        // with archived files we already chose to drop.
                        if s.starts_with('.') || s == "_archive" || s == "archive" {
                            continue;
                        }
                        self.stack.push(child.path());
                    }
                }
                continue;
            }
            return Some(p);
        }
        None
    }
}

// ---------------------------------------------------------------------------
// epoch -> ISO (no chrono dep; mirrors memory.rs)
// ---------------------------------------------------------------------------

fn system_time_to_iso(t: SystemTime) -> Option<String> {
    let secs = t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some(epoch_to_iso(secs))
}

fn epoch_to_iso(secs: u64) -> String {
    if secs == 0 {
        return "1970-01-01T00:00:00Z".to_string();
    }
    let mut days = (secs / 86_400) as i64;
    let secs_in_day = (secs % 86_400) as u32;
    let hh = secs_in_day / 3600;
    let mm = (secs_in_day % 3600) / 60;
    let ss = secs_in_day % 60;
    let mut year = 1970i32;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let yd: i64 = if leap { 366 } else { 365 };
        if days < yd {
            break;
        }
        days -= yd;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mdays: [i64; 12] = [
        31,
        if leap { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] {
        days -= mdays[month];
        month += 1;
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month + 1,
        days + 1,
        hh,
        mm,
        ss
    )
}

// ---------------------------------------------------------------------------
// Frontmatter + body parsing
// ---------------------------------------------------------------------------

/// Parses a markdown file into (frontmatter-block, body). Both strings
/// borrow into `content`. If there's no `---\n...---` opener, the whole
/// content is treated as body.
fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    let trimmed = content.trim_start_matches('\u{FEFF}');
    if !trimmed.starts_with("---") {
        return (None, content);
    }
    // Look for the closing `\n---` on its own line.
    let after_open = &trimmed[3..];
    // Skip the optional newline right after the opener.
    let after_open = after_open.strip_prefix('\r').unwrap_or(after_open);
    let after_open = after_open.strip_prefix('\n').unwrap_or(after_open);
    if let Some(close_idx) = after_open.find("\n---") {
        let fm = &after_open[..close_idx];
        let rest = &after_open[close_idx + 4..]; // skip "\n---"
        let rest = rest.strip_prefix('\r').unwrap_or(rest);
        let rest = rest.strip_prefix('\n').unwrap_or(rest);
        return (Some(fm), rest);
    }
    (None, content)
}

/// Extracts `title:`, `tags:` (inline `[a, b]` or YAML-list `- tag`), and
/// `category:` from a frontmatter block. Lightweight YAML-ish parser —
/// vault files all follow the same simple convention so we don't need
/// a real YAML lib (saves a dependency).
fn parse_frontmatter(fm: &str) -> (Option<String>, Vec<String>, Option<String>) {
    let mut title: Option<String> = None;
    let mut tags: Vec<String> = Vec::new();
    let mut category: Option<String> = None;
    let mut in_tags_block = false;

    for raw_line in fm.lines() {
        let line = raw_line.trim_end_matches('\r');
        // List item under `tags:`
        if in_tags_block {
            let trimmed = line.trim_start();
            if let Some(rest) = trimmed.strip_prefix("- ") {
                let t = rest.trim().trim_matches('"').trim_matches('\'').to_string();
                if !t.is_empty() {
                    tags.push(t);
                }
                continue;
            }
            // End of list when we hit a non-indented, non-`-` line.
            if !trimmed.starts_with('-') && !line.starts_with(' ') && !line.starts_with('\t') {
                in_tags_block = false;
                // Fall through to parse the new key.
            } else if trimmed.is_empty() {
                continue;
            } else {
                continue;
            }
        }

        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_lowercase();
            let val = v.trim().trim_matches('"').trim_matches('\'');
            match key.as_str() {
                "title" => {
                    if !val.is_empty() {
                        title = Some(val.to_string());
                    }
                }
                "category" => {
                    if !val.is_empty() {
                        category = Some(val.to_string());
                    }
                }
                "tags" => {
                    if val.is_empty() {
                        in_tags_block = true;
                    } else if val.starts_with('[') && val.ends_with(']') {
                        let inner = &val[1..val.len() - 1];
                        for t in inner.split(',') {
                            let t = t.trim().trim_matches('"').trim_matches('\'');
                            if !t.is_empty() {
                                tags.push(t.to_string());
                            }
                        }
                    } else if !val.is_empty() {
                        // single tag on same line as `tags:`
                        tags.push(val.to_string());
                    }
                }
                _ => {}
            }
        }
    }

    (title, tags, category)
}

/// First H1 in body, falling back to None. `body` is the post-frontmatter
/// content. We stop at the first non-empty content line so we don't
/// accidentally grab a level-1 heading from much later in the file.
fn extract_h1(body: &str) -> Option<String> {
    for raw in body.lines().take(40) {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("# ") {
            return Some(rest.trim().to_string());
        }
        // First content line that isn't H1 — bail.
        if !line.starts_with('#') {
            return None;
        }
    }
    None
}

/// Manual `[[wikilink]]` extractor. We don't pull the `regex` crate — a
/// 30-line scanner is faster and zero-dep. We accept the canonical
/// `[[Target]]` and `[[Target|Alias]]` forms; anything weirder we skip.
fn extract_wikilinks(body: &str) -> Vec<String> {
    let bytes = body.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            // Find the closing ]]
            let start = i + 2;
            let mut j = start;
            while j + 1 < bytes.len() {
                if bytes[j] == b']' && bytes[j + 1] == b']' {
                    break;
                }
                // Multiline links are not standard in Obsidian — bail
                // out at the first newline to keep parsing cheap.
                if bytes[j] == b'\n' {
                    j = start; // sentinel: no valid link found
                    break;
                }
                j += 1;
            }
            if j > start && j + 1 < bytes.len() && bytes[j] == b']' && bytes[j + 1] == b']' {
                let inner = &body[start..j];
                // Strip alias `|` and section anchor `#`.
                let target = inner
                    .split('|')
                    .next()
                    .unwrap_or(inner)
                    .split('#')
                    .next()
                    .unwrap_or(inner)
                    .trim();
                if !target.is_empty() {
                    out.push(target.to_string());
                }
                i = j + 2;
                continue;
            }
        }
        i += 1;
    }
    // Dedupe while preserving order — a note that links to the same
    // target 3x should count once for outbound, not three times.
    let mut seen: HashSet<String> = HashSet::new();
    out.retain(|t| seen.insert(t.to_lowercase()));
    out
}

fn collapse_ws_take(s: &str, max_chars: usize) -> String {
    let mut buf = String::with_capacity(max_chars + 8);
    let mut prev_space = false;
    for c in s.chars() {
        if buf.chars().count() >= max_chars {
            break;
        }
        if c.is_whitespace() {
            if !prev_space && !buf.is_empty() {
                buf.push(' ');
                prev_space = true;
            }
        } else {
            buf.push(c);
            prev_space = false;
        }
    }
    buf.trim().to_string()
}

// ---------------------------------------------------------------------------
// Roots + corpus build
// ---------------------------------------------------------------------------

fn corpus_roots() -> Result<Vec<(PathBuf, &'static str)>, String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME dir".to_string())?;
    let mut roots: Vec<(PathBuf, &str)> = Vec::new();
    let vault = home.join(".ultron-vault");
    if vault.exists() {
        roots.push((vault, "vault"));
    }
    let skill_vault = home.join(".ultron/skill-vault");
    if skill_vault.exists() {
        roots.push((skill_vault, "skill-vault"));
    }
    Ok(roots)
}

fn build_corpus() -> Result<Vec<RawNote>, String> {
    let roots = corpus_roots()?;
    let mut notes: Vec<RawNote> = Vec::new();
    for (root, _label) in roots.iter() {
        for path in walkdir(root) {
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(meta) = fs::metadata(&path) else { continue };
            if !meta.is_file() {
                continue;
            }
            // Cap individual reads to 256 KB so a stray giant note can't
            // OOM the walker. Frontmatter + first-page snippet is all
            // we need; wikilinks live in the body though, so use 256 KB
            // (plenty for any human-written note).
            let content = match fs::read_to_string(&path) {
                Ok(c) => {
                    if c.len() > 262_144 {
                        c.chars().take(262_144).collect::<String>()
                    } else {
                        c
                    }
                }
                Err(_) => continue,
            };
            let (fm, body) = split_frontmatter(&content);
            let (fm_title, fm_tags, fm_category) = match fm {
                Some(f) => parse_frontmatter(f),
                None => (None, Vec::new(), None),
            };
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("untitled")
                .to_string();
            let title = fm_title
                .or_else(|| extract_h1(body))
                .unwrap_or_else(|| stem.clone());
            let snippet = collapse_ws_take(body, 280);
            let wikilink_targets = extract_wikilinks(body);
            let relative = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| path.to_string_lossy().to_string());
            let mtime = meta.modified().ok();
            let last_modified_iso = mtime.and_then(system_time_to_iso);
            notes.push(RawNote {
                path: path.clone(),
                relative,
                title_lower: title.to_lowercase(),
                title,
                stem_lower: stem.to_lowercase(),
                tags: fm_tags,
                category: fm_category,
                size_bytes: meta.len(),
                mtime,
                last_modified_iso,
                snippet,
                wikilink_targets,
            });
        }
    }
    Ok(notes)
}

// ---------------------------------------------------------------------------
// Link resolution
// ---------------------------------------------------------------------------

/// Resolves wikilink target strings to indices in `notes`. We try (in
/// order): exact title-lower, then stem-lower, then suffix-match on the
/// relative path. Returns `(adjacency_outbound, inbound_counts)`.
fn resolve_wikilink_graph(notes: &[RawNote]) -> (Vec<Vec<usize>>, Vec<u32>) {
    let n = notes.len();
    let mut title_idx: HashMap<&str, usize> = HashMap::with_capacity(n);
    let mut stem_idx: HashMap<&str, usize> = HashMap::with_capacity(n);
    for (i, note) in notes.iter().enumerate() {
        // Last writer wins — fine for vaults where titles are unique-ish.
        title_idx.insert(note.title_lower.as_str(), i);
        stem_idx.insert(note.stem_lower.as_str(), i);
    }

    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut inbound: Vec<u32> = vec![0u32; n];

    for (i, note) in notes.iter().enumerate() {
        for target in &note.wikilink_targets {
            let key = target.to_lowercase();
            let resolved = title_idx
                .get(key.as_str())
                .or_else(|| stem_idx.get(key.as_str()))
                .copied();
            if let Some(j) = resolved {
                if j == i {
                    continue; // ignore self-link
                }
                if !adj[i].contains(&j) {
                    adj[i].push(j);
                    inbound[j] = inbound[j].saturating_add(1);
                }
            }
        }
    }

    (adj, inbound)
}

// ---------------------------------------------------------------------------
// Tag-similarity fallback edges
// ---------------------------------------------------------------------------

/// Jaccard similarity between two tag sets.
fn jaccard(a: &[String], b: &[String]) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let sa: HashSet<&String> = a.iter().collect();
    let sb: HashSet<&String> = b.iter().collect();
    let inter = sa.intersection(&sb).count() as f32;
    let union = sa.union(&sb).count() as f32;
    if union == 0.0 {
        0.0
    } else {
        inter / union
    }
}

/// For each node, link to its top-K most-similar neighbours (Jaccard >=
/// TAG_EDGE_JACCARD_MIN). Edges are undirected and de-duplicated.
fn build_tag_edges(notes: &[RawNote]) -> Vec<GraphEdge> {
    let n = notes.len();
    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut seen: HashSet<(usize, usize)> = HashSet::new();
    for i in 0..n {
        if notes[i].tags.is_empty() {
            continue;
        }
        let mut scored: Vec<(usize, f32)> = Vec::new();
        for j in 0..n {
            if i == j || notes[j].tags.is_empty() {
                continue;
            }
            let s = jaccard(&notes[i].tags, &notes[j].tags);
            if s >= TAG_EDGE_JACCARD_MIN {
                scored.push((j, s));
            }
        }
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        for (j, score) in scored.into_iter().take(TAG_EDGE_CAP_PER_NODE) {
            let key = if i < j { (i, j) } else { (j, i) };
            if !seen.insert(key) {
                continue;
            }
            edges.push(GraphEdge {
                source: notes[key.0].path.to_string_lossy().to_string(),
                target: notes[key.1].path.to_string_lossy().to_string(),
                kind: "tag".to_string(),
                weight: score,
            });
        }
    }
    edges
}

// ---------------------------------------------------------------------------
// Highlights computation
// ---------------------------------------------------------------------------

fn iso_now_utc() -> String {
    let secs = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    epoch_to_iso(secs)
}

fn to_recent(n: &RawNote) -> RecentNote {
    RecentNote {
        path: n.path.to_string_lossy().to_string(),
        relative: n.relative.clone(),
        title: n.title.clone(),
        tags: n.tags.clone(),
        category: n.category.clone(),
        size_bytes: n.size_bytes,
        last_modified: n.last_modified_iso.clone(),
        snippet: n.snippet.clone(),
    }
}

pub fn compute_memory_highlights_inner() -> Result<MemoryHighlights, String> {
    let notes = build_corpus()?;
    let total_notes = notes.len();
    let (adj, inbound) = resolve_wikilink_graph(&notes);
    let total_wikilinks: usize = adj.iter().map(|a| a.len()).sum();

    // Most linked — by inbound count, descending. Ties broken by
    // outbound count then title.
    let mut indexed: Vec<usize> = (0..total_notes).collect();
    indexed.sort_by(|&a, &b| {
        inbound[b]
            .cmp(&inbound[a])
            .then_with(|| adj[b].len().cmp(&adj[a].len()))
            .then_with(|| notes[a].title.cmp(&notes[b].title))
    });
    let most_linked: Vec<NoteWithLinks> = indexed
        .iter()
        .filter(|&&i| inbound[i] > 0 || !adj[i].is_empty())
        .take(10)
        .map(|&i| NoteWithLinks {
            path: notes[i].path.to_string_lossy().to_string(),
            relative: notes[i].relative.clone(),
            title: notes[i].title.clone(),
            tags: notes[i].tags.clone(),
            category: notes[i].category.clone(),
            size_bytes: notes[i].size_bytes,
            last_modified: notes[i].last_modified_iso.clone(),
            inbound: inbound[i],
            outbound: adj[i].len() as u32,
            snippet: notes[i].snippet.clone(),
        })
        .collect();

    // Recently active — by mtime descending, top 10.
    let mut by_mtime: Vec<usize> = (0..total_notes).collect();
    by_mtime.sort_by(|&a, &b| match (notes[a].mtime, notes[b].mtime) {
        (Some(ma), Some(mb)) => mb.cmp(&ma),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    let recently_active: Vec<RecentNote> = by_mtime
        .iter()
        .take(10)
        .map(|&i| to_recent(&notes[i]))
        .collect();

    // By topic — bucket by first tag (or category if no tags). Sort
    // each bucket by mtime desc, cap each at 8 entries so the UI
    // doesn't blow up on heavily-tagged corpora. Output sorted by
    // bucket size descending (top topics first) via BTreeMap key
    // prefix `NNN__topic`.
    let mut topic_buckets: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, note) in notes.iter().enumerate() {
        let topic = note
            .tags
            .first()
            .cloned()
            .or_else(|| note.category.clone())
            .unwrap_or_else(|| "(uncategorised)".to_string());
        topic_buckets.entry(topic).or_default().push(i);
    }
    let mut topic_entries: Vec<(String, Vec<usize>)> = topic_buckets.into_iter().collect();
    topic_entries.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
    let mut by_topic: BTreeMap<String, Vec<RecentNote>> = BTreeMap::new();
    for (rank, (topic, mut idxs)) in topic_entries.into_iter().take(24).enumerate() {
        idxs.sort_by(|&a, &b| match (notes[a].mtime, notes[b].mtime) {
            (Some(ma), Some(mb)) => mb.cmp(&ma),
            _ => std::cmp::Ordering::Equal,
        });
        idxs.truncate(8);
        let key = format!("{:02}__{}", rank, topic);
        by_topic.insert(key, idxs.into_iter().map(|i| to_recent(&notes[i])).collect());
    }

    // Orphans — zero inbound AND zero outbound wikilinks. Limit to 30
    // so the UI doesn't drown if the vault has no wikilinks (which it
    // currently doesn't — every note will be flagged orphan).
    let orphans: Vec<RecentNote> = (0..total_notes)
        .filter(|&i| inbound[i] == 0 && adj[i].is_empty())
        .take(30)
        .map(|i| to_recent(&notes[i]))
        .collect();

    // Long-form — size >= 2 KB, sorted by size desc, top 20.
    let mut long_form_idx: Vec<usize> = (0..total_notes)
        .filter(|&i| notes[i].size_bytes >= MIN_LONG_FORM_BYTES)
        .collect();
    long_form_idx.sort_by(|&a, &b| notes[b].size_bytes.cmp(&notes[a].size_bytes));
    long_form_idx.truncate(20);
    let long_form: Vec<RecentNote> = long_form_idx
        .into_iter()
        .map(|i| to_recent(&notes[i]))
        .collect();

    Ok(MemoryHighlights {
        most_linked,
        recently_active,
        by_topic,
        orphans,
        long_form,
        computed_at: iso_now_utc(),
        total_notes,
        total_wikilinks,
    })
}

// ---------------------------------------------------------------------------
// Link graph computation
// ---------------------------------------------------------------------------

/// Selects up to MAX_GRAPH_NODES notes for the force-directed graph.
/// Selection priority: notes participating in wikilinks first; if not
/// enough, fill with the most recently modified notes (top by mtime).
fn select_graph_indices(notes: &[RawNote], adj: &[Vec<usize>], inbound: &[u32]) -> Vec<usize> {
    let mut score: Vec<(usize, u32, Option<SystemTime>)> = notes
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let link_score = inbound[i] + adj[i].len() as u32;
            (i, link_score, n.mtime)
        })
        .collect();
    score.sort_by(|a, b| {
        b.1.cmp(&a.1).then_with(|| match (b.2, a.2) {
            (Some(mb), Some(ma)) => mb.cmp(&ma),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        })
    });
    score
        .into_iter()
        .take(MAX_GRAPH_NODES)
        .map(|(i, _, _)| i)
        .collect()
}

pub fn compute_memory_link_graph_inner() -> Result<MemoryLinkGraph, String> {
    let notes = build_corpus()?;
    let (adj, inbound) = resolve_wikilink_graph(&notes);

    let selected = select_graph_indices(&notes, &adj, &inbound);
    let kept: HashSet<usize> = selected.iter().copied().collect();

    // Build wikilink edges restricted to kept nodes.
    let mut wikilink_edges: Vec<GraphEdge> = Vec::new();
    for &i in &selected {
        for &j in &adj[i] {
            if kept.contains(&j) {
                wikilink_edges.push(GraphEdge {
                    source: notes[i].path.to_string_lossy().to_string(),
                    target: notes[j].path.to_string_lossy().to_string(),
                    kind: "wikilink".to_string(),
                    weight: 1.0,
                });
            }
        }
    }

    // Tag-similarity fallback. Compute over the same selected subset so
    // we don't waste cycles on notes the UI won't render.
    let selected_notes: Vec<RawNote> = selected.iter().map(|&i| notes[i].clone()).collect();
    let mut all_edges = if wikilink_edges.is_empty() {
        build_tag_edges(&selected_notes)
    } else {
        wikilink_edges.clone()
    };

    let edge_source = if wikilink_edges.is_empty() {
        "tags".to_string()
    } else {
        "wikilinks".to_string()
    };

    // Build node payloads.
    let nodes: Vec<GraphNode> = selected
        .iter()
        .map(|&i| GraphNode {
            id: notes[i].path.to_string_lossy().to_string(),
            title: notes[i].title.clone(),
            path: notes[i].path.to_string_lossy().to_string(),
            category: notes[i].category.clone(),
            tags: notes[i].tags.clone(),
            size_bytes: notes[i].size_bytes,
            last_modified: notes[i].last_modified_iso.clone(),
            snippet: notes[i].snippet.clone(),
            inbound: inbound[i],
            outbound: adj[i].len() as u32,
        })
        .collect();

    // Final safety: cap edges to 2000 to keep the SVG renderer happy
    // on the lower end of the 200-node range with maximum-density tag
    // similarity output.
    if all_edges.len() > 2000 {
        all_edges.truncate(2000);
    }

    Ok(MemoryLinkGraph {
        nodes,
        edges: all_edges,
        edge_source,
        computed_at: iso_now_utc(),
    })
}

// ---------------------------------------------------------------------------
// Inbox bridge — used by the Orphans "Mark for review" button.
// ---------------------------------------------------------------------------

pub fn mark_orphan_for_review_inner(path: String, title: String) -> Result<(), String> {
    let text = format!(
        "[orphan-review] {} ({}) — candidate for connecting or pruning",
        title, path
    );
    crate::inbox::append_inbox_inner(&text)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn compute_memory_highlights() -> Result<MemoryHighlights, String> {
    compute_memory_highlights_inner()
}

#[tauri::command]
pub async fn compute_memory_link_graph() -> Result<MemoryLinkGraph, String> {
    compute_memory_link_graph_inner()
}

#[tauri::command]
pub async fn mark_orphan_for_review(path: String, title: String) -> Result<(), String> {
    mark_orphan_for_review_inner(path, title)
}
