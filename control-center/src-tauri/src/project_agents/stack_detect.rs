// project_agents/stack_detect.rs — Stack detection from project manifest files.

use std::fs;

/// Read at most `max_bytes` Unicode characters from a file, returning an empty
/// string if the file does not exist or cannot be read.
pub fn read_head(path: &std::path::Path, max_bytes: usize) -> String {
    fs::read_to_string(path)
        .ok()
        .map(|s| s.chars().take(max_bytes).collect())
        .unwrap_or_default()
}

/// Returns a deduplicated, sorted list of detected technology tokens.
/// Reads CLAUDE.md, package.json, Cargo.toml, pyproject.toml, go.mod from
/// `project_path`.  Each file contributes at most its first 2000 chars to
/// avoid over-reading monorepo package-locks.
pub fn detect_stack(project_path: &str) -> Vec<String> {
    let root = std::path::Path::new(project_path);
    let mut corpus = String::new();

    for file in &[
        "CLAUDE.md",
        "package.json",
        "Cargo.toml",
        "pyproject.toml",
        "go.mod",
        "build.gradle",
        "pom.xml",
    ] {
        let p = root.join(file);
        if p.is_file() {
            let snippet = read_head(&p, 2_000);
            corpus.push(' ');
            corpus.push_str(&snippet);
        }
    }

    let hay = corpus.to_lowercase();
    let mut detected: std::collections::BTreeSet<String> = Default::default();

    let tokens: &[(&str, &str)] = &[
        ("rust", "rust"),
        ("cargo", "rust"),
        ("[package]", "rust"),
        ("typescript", "typescript"),
        ("\"tsx\"", "typescript"),
        ("react", "react"),
        ("next.js", "next.js"),
        ("nextjs", "next.js"),
        ("vue", "vue"),
        ("svelte", "svelte"),
        ("python", "python"),
        ("fastapi", "python"),
        ("django", "python"),
        ("flask", "python"),
        ("go ", "go"),
        ("golang", "go"),
        ("module ", "go"), // go.mod starts with "module"
        ("java", "java"),
        ("spring", "java"),
        ("kotlin", "kotlin"),
        ("swift", "swift"),
        ("c++", "cpp"),
        ("#include", "cpp"),
        ("cmake", "cpp"),
        ("unreal", "unreal"),
        ("unity", "unity"),
        ("tauri", "tauri"),
        ("electron", "electron"),
        ("postgres", "postgres"),
        ("postgresql", "postgres"),
        ("sqlite", "sqlite"),
        ("redis", "redis"),
        ("docker", "docker"),
        ("kubernetes", "kubernetes"),
        ("terraform", "terraform"),
    ];

    for (keyword, label) in tokens {
        if hay.contains(keyword) {
            detected.insert(label.to_string());
        }
    }

    detected.into_iter().collect()
}
