"""
File Decomposition (FD) module — shared by v15 cascading pipeline scripts.

Extracted from evaluate_cross_repo_v13.py. Splits large diffs by file,
classifies each file (regex + optional LLM), estimates per-file effort via LLM,
then aggregates into a total commit estimate.

All LLM-dependent functions accept a `call_ollama_fn` parameter with signature:
    call_ollama_fn(system, prompt, schema=None, max_tokens=1024) -> dict | str

This decouples the FD logic from script-specific Ollama wrappers.
"""
import re
import os
import json
import time
from collections import defaultdict, Counter
from concurrent.futures import ThreadPoolExecutor, as_completed


# ===== CONSTANTS =====

FILE_CHUNK_SIZE = 25000  # chars per chunk for very large files

FILE_SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "description": "Brief description of changes in this file"},
        "estimated_hours": {"type": "number", "description": "Development hours for this file, rounded to 0.1"},
    },
    "required": ["summary", "estimated_hours"],
}

FILE_CLASSIFY_SCHEMA = {
    "type": "object",
    "properties": {
        "classifications": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "file": {"type": "string"},
                    "category": {"type": "string", "enum": [
                        "manual_code", "test", "generated", "lock_file",
                        "config", "docs", "data", "formatting_only", "migration"
                    ]},
                },
                "required": ["file", "category"],
            },
        },
    },
    "required": ["classifications"],
}

EVAL_SCHEMA = {
    "type": "object",
    "properties": {
        "estimated_hours": {"type": "number", "description": "Total development hours, rounded to 0.1"},
        "reasoning": {"type": "string", "description": "Brief explanation of the estimate"},
    },
    "required": ["estimated_hours", "reasoning"],
}

# v15 cascading schemas and prompts (frozen)
ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "change_type": {"type": "string"},
        "new_logic_percent": {"type": "number"},
        "moved_or_copied_percent": {"type": "number"},
        "boilerplate_percent": {"type": "number"},
        "architectural_scope": {"type": "string"},
        "cognitive_complexity": {"type": "string"},
        "summary": {"type": "string"},
    },
    "required": ["change_type", "new_logic_percent", "moved_or_copied_percent",
                  "boilerplate_percent", "architectural_scope", "cognitive_complexity", "summary"],
}

ESTIMATE_SCHEMA = {
    "type": "object",
    "properties": {
        "estimated_hours": {"type": "number"},
        "reasoning": {"type": "string"},
    },
    "required": ["estimated_hours", "reasoning"],
}

DECOMP_SCHEMA = {
    "type": "object",
    "properties": {
        "coding_hours": {"type": "number"},
        "integration_hours": {"type": "number"},
        "testing_hours": {"type": "number"},
        "estimated_hours": {"type": "number"},
        "reasoning": {"type": "string"},
    },
    "required": ["coding_hours", "integration_hours", "testing_hours", "estimated_hours", "reasoning"],
}

PROMPT_CLASSIFY = """Classify this {lang} commit objectively. Be precise with percentages.

CODE CLASSIFICATION:
- Mechanical changes (renames, imports, formatting, moving code) are NOT new logic
- Tests that mirror implementation are boilerplate, not new logic
- Only genuinely new algorithms, business logic, or type-level code counts as new logic

ARCHITECTURAL SCOPE:
- none: Single file or simple changes within existing structure
- module: Extracting/creating modules within a package
- package: Creating new packages/crates/libraries with configuration
- multi_package: Workspace/monorepo restructuring
- system: Cross-repository architectural changes

COGNITIVE COMPLEXITY should consider BOTH code complexity AND architectural scope."""

PROMPT_EST_SIMPLE = """Estimate total hours for this {lang} commit as a middle dev (3-4yr experience, knows codebase)."""

PROMPT_EST_ARCHITECTURAL = """Estimate total hours for this {lang} commit as a middle dev (3-4yr experience, knows codebase).

IMPORTANT: For commits with architectural_scope "package", "multi_package", or "system",
the effort is dominated by architectural overhead, NOT by the percentage of moved code.

REFERENCE POINTS:
- Simple refactor (scope: none, 90%+ moved code) -> 0.1-1h
- Module extraction (scope: module, 80%+ moved code) -> 3-6h
- Package creation (scope: package, 90%+ moved code) -> 10-20h
- Workspace restructure (scope: multi_package) -> 15-30h"""

PROMPT_EST_TASK_DECOMP = """Estimate effort for this {lang} commit as a middle dev (3-4yr experience, knows codebase).

Break down the effort into components:

1. CODING TIME: Time to write/modify the actual code logic.
   - Simple renames or typos: 0.1-0.2h
   - Small logic changes: 0.5-2h
   - Complex new features (500+ LOC): 8-16h

2. INTEGRATION TIME: Time for configuration, build setup, dependencies.
   - scope: none -> 0h (no architectural overhead)
   - scope: module -> 1-3h
   - scope: package -> 4-8h
   - scope: multi_package -> 8-15h

3. TESTING TIME: Time for testing and validation.
   - Trivial changes: 0.1h
   - Module changes: 0.5-1h
   - Package restructuring: 2-4h

Provide each component separately, then sum for total."""

# ===== FILE CLASSIFICATION PATTERNS =====

GENERATED_PATTERNS = [
    # JS/TS
    r'package-lock\.json$', r'pnpm-lock\.yaml$', r'yarn\.lock$',
    r'\.generated\.\w+$', r'\.min\.\w+$', r'\.map$',
    r'dist/', r'build/', r'\.d\.ts$',
    # Rust
    r'Cargo\.lock$',
    # Go
    r'go\.sum$',
    # Java
    r'\.gradle\.kts?$', r'gradlew', r'gradle/wrapper/',
    r'mvnw', r'\.mvn/',
    # Python
    r'poetry\.lock$', r'Pipfile\.lock$',
    # General
    r'\.lock$',
]

DATA_PATTERNS = [
    r'__fixtures__/', r'testdata/', r'test[_-]?data/', r'fixtures/',
    r'__snapshots__/', r'META-INF/',
]

LOCALE_PATTERNS = [r'locale[s]?/', r'i18n/', r'l10n/', r'lang/', r'translations?/']

CONFIG_PATTERNS = [
    # JS/TS
    r'\.config\.\w+$', r'tsconfig.*\.json$', r'\.eslintrc', r'\.prettierrc',
    r'jest\.config', r'vitest\.config',
    # CI/CD
    r'\.github/', r'\.circleci/', r'\.gitlab-ci',
    # Java
    r'pom\.xml$', r'build\.gradle',
    # Rust
    r'build\.rs$', r'Cargo\.toml$',
    # Go
    r'go\.mod$',
    # Python
    r'setup\.py$', r'setup\.cfg$', r'pyproject\.toml$',
    # General
    r'Makefile$', r'Dockerfile$', r'docker-compose',
]

TEST_PATTERNS = [
    # Go
    r'_test\.go$',
    # Java/Kotlin
    r'Test\.java$', r'Test\.kt$', r'Tests\.java$', r'Tests\.kt$',
    r'Spec\.java$', r'Spec\.kt$',
    r'src/test/', r'src/testFixtures/',
    # Python
    r'test_\w+\.py$', r'tests/', r'_test\.py$',
    # JS/TS
    r'\.test\.\w+$', r'\.spec\.\w+$',
    r'__tests__/',
    # Rust
    r'tests/', r'#\[cfg\(test\)\]',
]

# Build artifact filenames — strongest signal for architectural scope
BUILD_ARTIFACT_PATTERNS = [
    r'Cargo\.toml$', r'build\.rs$',           # Rust
    r'package\.json$', r'tsconfig\.json$',      # JS/TS
    r'pom\.xml$', r'build\.gradle(\.kts)?$',    # Java
    r'go\.mod$',                                 # Go
    r'setup\.py$', r'pyproject\.toml$',          # Python
    r'CMakeLists\.txt$',                         # C/C++
]

# ===== MOVE/RENAME DETECTION PATTERNS =====

MOVE_KEYWORDS = re.compile(
    r'\b(move|rename|extract|split|reorganize|relocate|migrate|refactor.*module)\b', re.IGNORECASE
)
ARCHITECTURAL_KEYWORDS = re.compile(
    r'\b(extract\s+(crate|package|library|workspace)|create\s+(new\s+)?(crate|package|module)|split\s+into)\b', re.IGNORECASE
)
SIMPLE_KEYWORDS = re.compile(
    r'\b(move|rename|relocate|reorganize)\b', re.IGNORECASE
)

# ===== BULK EDIT DETECTION PATTERNS =====

NORM_PATTERNS = [
    # Qualified names: a.b.c.d -> <CHAIN> (but keep last segment)
    (re.compile(r'\b(\w+\.){2,}\w+\b'), '<CHAIN>'),
    # Import statements: normalize the imported name
    (re.compile(r'(import\s+)[\w.]+'), r'\1<IMPORT>'),
    # Type names (PascalCase)
    (re.compile(r'\b[A-Z][a-zA-Z0-9]{2,}\b'), '<TYPE>'),
    # String literals
    (re.compile(r'"[^"]*"'), '"<STR>"'),
    (re.compile(r"'[^']*'"), "'<STR>'"),
    # Numbers
    (re.compile(r'\b\d+\b'), '<NUM>'),
]


# ===== PURE FUNCTIONS =====

def split_diff_by_file(full_diff):
    """Split a unified diff into per-file diffs."""
    files = []
    current_file = None
    current_lines = []
    for line in full_diff.split('\n'):
        if line.startswith('diff --git'):
            if current_file:
                files.append((current_file, '\n'.join(current_lines)))
            parts = line.split(' b/')
            current_file = parts[-1] if len(parts) > 1 else line
            current_lines = [line]
        else:
            current_lines.append(line)
    if current_file:
        files.append((current_file, '\n'.join(current_lines)))
    return files


def parse_file_stat(file_diff):
    """Count added/deleted lines in a single-file diff."""
    added = len(re.findall(r'^\+(?!\+\+)', file_diff, re.MULTILINE))
    deleted = len(re.findall(r'^-(?!--)', file_diff, re.MULTILINE))
    return added, deleted


def classify_file_regex(filename, file_diff, lines_added, lines_deleted):
    """Regex-based classification. Returns tags list."""
    tags = []
    basename = os.path.basename(filename)

    for pattern in TEST_PATTERNS:
        if re.search(pattern, filename):
            tags.append("test")
            break

    for pattern in GENERATED_PATTERNS:
        if re.search(pattern, filename):
            tags.append("generated")
            break

    for pattern in DATA_PATTERNS:
        if re.search(pattern, filename):
            tags.append("test_data")
            break

    for pattern in LOCALE_PATTERNS:
        if re.search(pattern, filename):
            tags.append("locale")
            break

    for pattern in CONFIG_PATTERNS:
        if re.search(pattern, filename):
            tags.append("config")
            break

    # Heuristic: imported data (large JSON add-only)
    if lines_deleted == 0 and lines_added > 200:
        json_lines = len(re.findall(r'^\+\s*["\{}\[\],]', file_diff, re.MULTILINE))
        if json_lines > lines_added * 0.5:
            tags.append("imported_data")

    # Heuristic: likely move
    if lines_added > 50 and lines_deleted > 50:
        ratio = min(lines_added, lines_deleted) / max(lines_added, lines_deleted)
        if ratio > 0.85:
            tags.append("likely_move")

    # Heuristic: formatting only
    if file_diff:
        changed_lines = re.findall(r'^[+-](?![-+])(.*)', file_diff, re.MULTILINE)
        if len(changed_lines) > 10:
            stripped_adds = set()
            stripped_dels = set()
            for line in file_diff.split('\n'):
                if line.startswith('+') and not line.startswith('+++'):
                    stripped_adds.add(line[1:].strip())
                elif line.startswith('-') and not line.startswith('---'):
                    stripped_dels.add(line[1:].strip())
            overlap = stripped_adds & stripped_dels
            if len(overlap) > max(len(stripped_adds), len(stripped_dels)) * 0.7 and len(overlap) > 5:
                tags.append("formatting_only")

    if basename.endswith('.json') and lines_added > 500:
        tags.append("large_data_file")

    return tags


def get_content_lines(file_diff, prefix):
    """Extract stripped content lines with given prefix (+ or -)."""
    lines = set()
    for line in file_diff.split('\n'):
        if line.startswith(prefix) and not line.startswith(prefix * 2) and not line.startswith(prefix * 3):
            stripped = line[1:].strip()
            if stripped and len(stripped) > 3:
                lines.add(stripped)
    return lines


def detect_new_build_artifacts(file_info_list):
    """Detect if commit creates new build/config artifacts (add-only files matching patterns)."""
    new_artifacts = []
    for f in file_info_list:
        if f["added"] > 2 and f["deleted"] < 3:
            for pat in BUILD_ARTIFACT_PATTERNS:
                if re.search(pat, f["filename"]):
                    new_artifacts.append(f["filename"])
                    break
    return new_artifacts


def normalize_line(line):
    """Normalize a code line for pattern matching: abstract identifiers/literals."""
    for pat, repl in NORM_PATTERNS:
        line = pat.sub(repl, line)
    return line.strip()


def extract_edit_patterns(file_info_list):
    """Extract normalized (del, add) pairs from hunks across all files.

    Returns:
        pattern_counts, file_pattern_coverage, patterned_files, repeated_patterns
    """
    file_pairs = {}
    for f in file_info_list:
        diff_lines = f["diff"].split('\n')
        dels = []
        adds = []
        pairs = []
        for line in diff_lines:
            if line.startswith('-') and not line.startswith('---'):
                dels.append(line[1:])
            elif line.startswith('+') and not line.startswith('+++'):
                adds.append(line[1:])
            else:
                for d, a in zip(dels, adds):
                    if d.strip() == a.strip():
                        continue
                    nd = normalize_line(d)
                    na = normalize_line(a)
                    if not nd and not na:
                        continue
                    if nd == na:
                        pairs.append((nd, "<SYSTEMATIC>"))
                    else:
                        pairs.append((nd, na))
                dels = []
                adds = []
        # Final segment
        for d, a in zip(dels, adds):
            if d.strip() == a.strip():
                continue
            nd = normalize_line(d)
            na = normalize_line(a)
            if not nd and not na:
                continue
            if nd == na:
                pairs.append((nd, "<SYSTEMATIC>"))
            else:
                pairs.append((nd, na))
        file_pairs[f["filename"]] = pairs

    pattern_file_count = Counter()
    for fname, pairs in file_pairs.items():
        seen = set()
        for p in pairs:
            if p not in seen:
                pattern_file_count[p] += 1
                seen.add(p)

    MIN_PATTERN_SUPPORT = 3
    repeated_patterns = {p for p, c in pattern_file_count.items() if c >= MIN_PATTERN_SUPPORT}

    file_pattern_coverage = {}
    patterned_files = set()
    for fname, pairs in file_pairs.items():
        if not pairs:
            file_pattern_coverage[fname] = 0.0
            continue
        covered = sum(1 for p in pairs if p in repeated_patterns)
        coverage = covered / len(pairs)
        file_pattern_coverage[fname] = coverage
        if coverage >= 0.5:
            patterned_files.add(fname)

    return pattern_file_count, file_pattern_coverage, patterned_files, repeated_patterns


def detect_bulk_refactoring(file_info_list):
    """Detect if a commit is a bulk/systematic edit."""
    if len(file_info_list) < 5:
        return {"is_bulk": False, "patterned_files": set(), "bulk_ratio": 0}

    pattern_counts, file_coverage, patterned_files, repeated_patterns = extract_edit_patterns(file_info_list)

    total_files = len(file_info_list)
    if total_files > 20:
        for f in file_info_list:
            if f["filename"] not in patterned_files and (f["added"] + f["deleted"]) <= 10:
                patterned_files.add(f["filename"])

    bulk_ratio = len(patterned_files) / total_files
    is_bulk = bulk_ratio >= 0.3 or len(patterned_files) >= 10

    if not is_bulk:
        return {"is_bulk": False, "patterned_files": set(), "bulk_ratio": bulk_ratio}

    top_patterns = []
    for (d, a), count in pattern_counts.most_common(5):
        if count >= 3:
            top_patterns.append({"del": d[:80], "add": a[:80], "file_count": count})

    pattern_desc = (
        f"BULK/SYSTEMATIC EDIT: {len(patterned_files)}/{total_files} files contain repetitive "
        f"edit patterns (batch find-replace style). These files require near-zero individual effort. "
        f"Only {total_files - len(patterned_files)} files have unique/substantive changes."
    )

    return {
        "is_bulk": True,
        "patterned_files": patterned_files,
        "bulk_ratio": bulk_ratio,
        "top_patterns": top_patterns,
        "pattern_description": pattern_desc,
    }


def classify_move_commit(commit_message, file_info_list):
    """Detect move/rename and classify into SIMPLE_MOVE / MODULE_EXTRACT / ARCHITECTURAL_EXTRACT."""
    has_keyword = bool(MOVE_KEYWORDS.search(commit_message))

    total_added = sum(f["added"] for f in file_info_list)
    total_deleted = sum(f["deleted"] for f in file_info_list)
    if total_added > 0 and total_deleted > 0:
        commit_ratio = min(total_added, total_deleted) / max(total_added, total_deleted)
    else:
        commit_ratio = 0

    if not has_keyword and commit_ratio < 0.6:
        return {"is_move": False, "move_type": None, "pairs": [], "move_description": ""}

    # Cross-file content matching
    file_adds = {}
    file_dels = {}
    for f in file_info_list:
        if f["added"] > 5:
            file_adds[f["filename"]] = get_content_lines(f["diff"], "+")
        if f["deleted"] > 5:
            file_dels[f["filename"]] = get_content_lines(f["diff"], "-")

    pairs = []
    used_sources = set()
    used_dests = set()
    for src, del_lines in file_dels.items():
        if not del_lines or src in used_sources:
            continue
        best_match = None
        best_overlap = 0
        for dst, add_lines in file_adds.items():
            if dst == src or dst in used_dests or not add_lines:
                continue
            overlap = len(del_lines & add_lines)
            overlap_pct = overlap / max(len(del_lines), 1)
            if overlap_pct > best_overlap and overlap_pct > 0.4 and overlap > 10:
                best_overlap = overlap_pct
                best_match = dst
        if best_match:
            pairs.append((src, best_match, best_overlap))
            used_sources.add(src)
            used_dests.add(best_match)

    is_move = len(pairs) > 0 or (has_keyword and commit_ratio > 0.7)

    if not is_move:
        return {"is_move": False, "move_type": None, "pairs": [], "move_description": ""}

    # === CLASSIFY MOVE TYPE ===
    file_count = len(file_info_list)
    new_artifacts = detect_new_build_artifacts(file_info_list)
    avg_overlap = sum(p[2] for p in pairs) / len(pairs) if pairs else 0

    if new_artifacts:
        move_type = "ARCHITECTURAL_EXTRACT"
    elif file_count > 15:
        if ARCHITECTURAL_KEYWORDS.search(commit_message):
            move_type = "ARCHITECTURAL_EXTRACT"
        else:
            move_type = "MODULE_EXTRACT"
    elif file_count >= 5:
        move_type = "MODULE_EXTRACT"
    elif avg_overlap > 0.75 and file_count < 5 and SIMPLE_KEYWORDS.search(commit_message):
        move_type = "SIMPLE_MOVE"
    else:
        move_type = "MODULE_EXTRACT"  # conservative default

    # === BUILD ADAPTIVE DESCRIPTION ===
    pair_desc = []
    for src, dst, pct in pairs:
        pair_desc.append(f"{src.split('/')[-1]} \u2192 {dst.split('/')[-1]} ({pct:.0%})")
    pairs_str = "; ".join(pair_desc) if pair_desc else "code relocation detected"

    if move_type == "SIMPLE_MOVE":
        move_desc = (
            f"SIMPLE CODE MOVE: {pairs_str}. "
            f"This is a straightforward file reorganization with {file_count} files and {avg_overlap:.0%} average code overlap. "
            f"Moved code requires near-zero writing effort — estimate only coordination overhead "
            f"(updating imports, verifying compilation)."
        )
    elif move_type == "MODULE_EXTRACT":
        move_desc = (
            f"MODULE EXTRACTION: {pairs_str}. "
            f"Code is being reorganized across {file_count} files with {avg_overlap:.0%} average overlap. "
            f"While some code is moved, consider effort for: import updates, interface adjustments, "
            f"and modifications made during extraction. Provide a balanced estimate."
        )
    else:  # ARCHITECTURAL_EXTRACT
        artifact_names = [a.split("/")[-1] for a in new_artifacts]
        move_desc = (
            f"ARCHITECTURAL REFACTORING: {pairs_str}. "
            f"This is a large-scale extraction across {file_count} files"
        )
        if artifact_names:
            move_desc += f" with new build artifacts: {', '.join(artifact_names)}"
        move_desc += (
            f". Beyond code relocation, this required: architecture decisions, "
            f"dependency graph restructuring, build system integration, and cross-module testing. "
            f"Provide a comprehensive estimate reflecting the full architectural scope."
        )

    pair_files = used_sources | used_dests
    move_ratio = len(pair_files) / max(file_count, 1)

    return {
        "is_move": True,
        "move_type": move_type,
        "pairs": pairs,
        "pair_files": pair_files,
        "move_description": move_desc,
        "new_build_artifacts": new_artifacts,
        "avg_overlap": avg_overlap,
        "move_ratio": move_ratio,
    }


def group_by_directory(file_summaries):
    """Group file summaries by top-level directory."""
    groups = defaultdict(list)
    for s in file_summaries:
        path = s.get("file", "")
        parts = path.replace("\\", "/").split("/")
        if len(parts) >= 3:
            group_key = "/".join(parts[:2])
        elif len(parts) == 2:
            group_key = parts[0]
        else:
            group_key = "(root)"
        groups[group_key].append(s)
    return dict(groups)


def build_aggregation_prompt(file_summaries, commit_message, files_changed, lines_added, lines_deleted, move_info=None, bulk_info=None):
    """Build rich aggregation prompt with per-file stats and grouping."""
    groups = group_by_directory(file_summaries)

    test_files = [s for s in file_summaries if "test" in s.get("tags", [])]
    manual_files = [s for s in file_summaries
                    if not any(t in s.get("tags", []) for t in
                              ["generated", "imported_data", "large_data_file",
                               "formatting_only", "locale", "test"])]
    skipped_files = [s for s in file_summaries
                     if any(t in s.get("tags", []) for t in
                            ["generated", "imported_data", "large_data_file",
                             "formatting_only", "locale"])]

    sum_hours = sum(s.get("estimated_hours", 0) for s in file_summaries)
    manual_hours = sum(s.get("estimated_hours", 0) for s in manual_files)
    test_hours = sum(s.get("estimated_hours", 0) for s in test_files)

    lines = []
    lines.append(f"Commit: {commit_message}")
    lines.append(f"Total: {files_changed} files, +{lines_added}/-{lines_deleted}")
    lines.append("")

    # Move/rename context
    if move_info and move_info.get("is_move"):
        move_ratio = move_info.get("move_ratio", 1.0)
        pair_count = len(move_info.get("pair_files", set()))
        total_files = files_changed
        non_move_count = total_files - pair_count

        if move_ratio < 0.2:
            pair_desc = []
            for src, dst, pct in move_info.get("pairs", []):
                pair_desc.append(f"{src.split('/')[-1]} -> {dst.split('/')[-1]} ({pct:.0%})")
            pairs_str = "; ".join(pair_desc)
            lines.append(
                f"Note: This commit contains a small code move ({pair_count} files: {pairs_str}), "
                f"but primarily consists of usage updates across {non_move_count} other files. "
                f"Do not treat usage updates as complex refactoring."
            )
        else:
            lines.append(f"\u26a0 {move_info['move_description']}")
        lines.append("")

    # Bulk/systematic edit context
    bulk_patterned_files = [s for s in file_summaries if "bulk_patterned" in s.get("tags", [])]
    if bulk_info and bulk_info.get("is_bulk") and bulk_patterned_files:
        non_bulk = len(file_summaries) - len(bulk_patterned_files)
        lines.append(
            f"BULK EDIT: {len(bulk_patterned_files)} files contain repetitive/systematic changes "
            f"(batch find-replace, import updates, accessor renames) requiring near-zero individual effort. "
            f"Only {non_bulk} files have unique/substantive changes that drive the real effort. "
            f"The total effort depends primarily on these {non_bulk} files, not on the bulk count."
        )
        lines.append("")

    lines.append(f"Breakdown: {len(manual_files)} production code, {len(test_files)} test files, {len(skipped_files)} auto/generated/data")
    lines.append(f"Per-file hour estimates: total={sum_hours:.1f}h (code={manual_hours:.1f}h, tests={test_hours:.1f}h)")
    lines.append("")

    for group_name in sorted(groups.keys()):
        group = groups[group_name]
        lines.append(f"## {group_name}/ ({len(group)} files)")
        for s in group:
            fname = s.get("file", "?")
            short_name = fname.split("/")[-1] if "/" in fname else fname
            summary = s.get("summary", "?")
            hours = s.get("estimated_hours", "?")
            la = s.get("lines_added", "?")
            ld = s.get("lines_deleted", "?")
            tags_str = ""
            if s.get("tags"):
                tags_str = f" [{','.join(s['tags'])}]"
            lines.append(f"  - {short_name} (+{la}/-{ld}): {summary} ({hours}h){tags_str}")
        lines.append("")

    return "\n".join(lines)


def make_system_prompts(language):
    """Create system prompts for FD pipeline."""
    sys_file = (
        f"Estimate hours for this single file change in a {language} project as a middle dev "
        f"(3-4yr experience, knows codebase).\n"
        f"This file is part of a larger commit — estimate effort for THIS file only.\n"
        f"Per-file effort scale: trivial=0.05-0.2h, low=0.2-0.5h, medium=0.5-2.0h, high=2.0-4.0h, very_high=4.0-8.0h.\n"
        f"Most files in multi-file commits are trivial/low. Core files with substantial new logic CAN be high or very high."
    )

    sys_agg = (
        f"Estimate total hours for this {language} commit as a middle dev (3-4yr experience, knows codebase).\n"
        f"Per-file estimates below are from expert reviewers — use them as primary input."
    )

    return sys_file, sys_agg


# ===== ROBUST LLM WRAPPER =====

def _robust_wrap(call_ollama_fn, retries=2):
    """Wrap a call_ollama_fn with retries, markdown fence stripping, and JSON extraction fallback.

    v13's call_ollama had these robustness features built in. Consumer scripts may lack them.
    This wrapper ensures the FD pipeline has v13-level robustness regardless of the caller's implementation.
    """
    def wrapped(system, prompt, schema=None, max_tokens=1024):
        for attempt in range(retries + 1):
            try:
                result = call_ollama_fn(system, prompt, schema=schema, max_tokens=max_tokens)

                # If result is already a parsed dict (or None), return as-is
                if result is None:
                    if attempt < retries:
                        time.sleep(2)
                        continue
                    return None
                if isinstance(result, dict):
                    return result

                # Result is a string — apply v13-level text cleanup
                text = result
                # Strip markdown fences (v13 lines 244-245)
                text = re.sub(r'```json\s*', '', text)
                text = re.sub(r'```\s*', '', text).strip()

                if schema:
                    return json.loads(text)

                # Manual JSON extraction fallback with brace-depth tracking (v13 lines 248-256)
                start = text.find('{')
                if start >= 0:
                    depth = 0
                    for i in range(start, len(text)):
                        if text[i] == '{':
                            depth += 1
                        elif text[i] == '}':
                            depth -= 1
                            if depth == 0:
                                return json.loads(text[start:i + 1])
                return json.loads(text)
            except Exception as e:
                if attempt < retries:
                    time.sleep(2)
                    continue
                raise e
    return wrapped


# ===== LLM-DEPENDENT FUNCTIONS =====

def model_classify_files(file_list, commit_message, call_ollama_fn):
    """Use LLM to classify ambiguous files."""
    sys_prompt = """You classify files in a git commit. For each file, determine its category based on the filename and change stats.

Categories:
- manual_code: Production source code written by developers
- test: Test files (unit tests, integration tests, test helpers)
- generated: Auto-generated files, lock files, build artifacts
- lock_file: Dependency lock files
- config: Configuration files (build, CI, linting, project settings)
- docs: Documentation files (README, markdown, comments)
- data: Test fixtures, snapshots, sample data
- formatting_only: Only whitespace/formatting changes
- migration: Database or schema migrations"""

    file_descriptions = "\n".join(
        f"- {f['filename']} (+{f['added']}/-{f['deleted']})"
        for f in file_list
    )
    prompt = f"""Commit: {commit_message}

Files to classify:
{file_descriptions}

Classify each file. Reply with ONLY valid JSON."""

    try:
        result = call_ollama_fn(sys_prompt, prompt, schema=FILE_CLASSIFY_SCHEMA, max_tokens=2048)
        return {c['file']: c['category'] for c in result.get('classifications', [])}
    except Exception:
        return {}


def summarize_file_full(filename, file_diff, tags, commit_message, commit_stats,
                        sys_file, call_ollama_fn, move_info=None, bulk_info=None):
    """Summarize a file with full diff (no truncation). Handles chunking for very large files."""

    # For bulk patterned files, hardcode estimate (no LLM call)
    if bulk_info and bulk_info.get("is_bulk") and filename in bulk_info.get("patterned_files", set()):
        added, deleted = parse_file_stat(file_diff)
        return {
            "file": filename,
            "summary": "[bulk/systematic edit: repetitive pattern, batch find-replace]",
            "change_type": "refactor",
            "complexity": "trivial",
            "estimated_hours": 0.05,
            "tags": tags + ["bulk_patterned"],
            "lines_added": added, "lines_deleted": deleted,
        }

    # For skipped categories, return hardcoded summary
    skip_tags = {"generated", "imported_data", "large_data_file", "formatting_only", "locale"}
    if skip_tags & set(tags):
        added, deleted = parse_file_stat(file_diff)
        tag_str = ", ".join(tags)
        return {
            "file": filename,
            "summary": f"[{tag_str}: +{added}/-{deleted}, auto-classified as non-manual]",
            "change_type": "config" if "config" in tags else "docs" if "locale" in tags else "chore",
            "complexity": "trivial",
            "estimated_hours": 0.05,
            "tags": tags,
        }

    added, deleted = parse_file_stat(file_diff)
    tag_str = ", ".join(tags) if tags else "manual_code"

    context = f"This is 1 file in a commit with {commit_stats['files']} files total (+{commit_stats['added']}/-{commit_stats['deleted']})."

    # Move context for this file
    move_context = ""
    if move_info and move_info.get("is_move"):
        move_type = move_info.get("move_type", "MODULE_EXTRACT")
        pair_files = move_info.get("pair_files", set())
        if filename in pair_files:
            for src, dst, pct in move_info.get("pairs", []):
                role = None
                partner = None
                if filename == src:
                    role = "SOURCE"
                    partner = dst.split('/')[-1]
                elif filename == dst:
                    role = "DESTINATION"
                    partner = src.split('/')[-1]
                if role:
                    if move_type == "SIMPLE_MOVE":
                        move_context = (
                            f"\nThis file is the {role} of a simple code move ({pct:.0%} overlap with {partner}). "
                            f"The {'deleted' if role == 'SOURCE' else 'added'} code is relocated, not {'removed' if role == 'SOURCE' else 'new'}. "
                            f"Estimate minimal effort (imports/references only)."
                        )
                    elif move_type == "MODULE_EXTRACT":
                        move_context = (
                            f"\nContext: This file is the {role} of a module extraction ({pct:.0%} overlap with {partner}). "
                            f"Some code is moved between files. Estimate effort for modifications and adjustments "
                            f"beyond the moved code itself."
                        )
                    else:  # ARCHITECTURAL_EXTRACT
                        move_context = (
                            f"\nContext: This file is part of an architectural refactoring ({pct:.0%} code overlap with {partner}). "
                            f"While code is relocated, this is part of a larger structural change. "
                            f"Estimate the incremental effort for THIS file including any interface changes, "
                            f"conditional compilation, or dependency updates."
                        )
                    break

    # Test file context
    test_context = ""
    is_test_only = commit_stats.get("test_only", False)
    if "test" in tags and not is_test_only:
        test_context = "\n[TEST FILE] This is a test file. Effort typically involves adapting assertions or adding test cases. Usually 30-50% effort relative to implementation code."

    if len(file_diff) <= FILE_CHUNK_SIZE:
        prompt = f"""Commit: {commit_message}
{context}{move_context}{test_context}
File: {filename} [{tag_str}] (+{added}/-{deleted})

{file_diff}

Reply with ONLY the JSON:"""
        try:
            result = call_ollama_fn(sys_file, prompt, schema=FILE_SUMMARY_SCHEMA, max_tokens=512)
            result["file"] = filename
            result["tags"] = tags
            result["lines_added"] = added
            result["lines_deleted"] = deleted
            # Soft cap: 8h per file in multi-file commits
            if commit_stats['files'] > 1 and result.get("estimated_hours", 0) > 8.0:
                print(f"    CAP: {filename} {result['estimated_hours']}h -> 8.0h")
                result["estimated_hours_uncapped"] = result["estimated_hours"]
                result["estimated_hours"] = 8.0
            return result
        except Exception as e:
            return {
                "file": filename, "summary": f"Failed: {str(e)[:60]}",
                "change_type": "unknown", "complexity": "medium",
                "estimated_hours": 1.0, "tags": tags + ["summary_failed"],
                "lines_added": added, "lines_deleted": deleted,
            }
    else:
        # Chunked summary for very large files
        chunks = []
        for i in range(0, len(file_diff), FILE_CHUNK_SIZE):
            chunks.append(file_diff[i:i + FILE_CHUNK_SIZE])

        chunk_summaries = []
        for ci, chunk in enumerate(chunks):
            prompt = f"""Commit: {commit_message}
{context}
File: {filename} [{tag_str}] (+{added}/-{deleted}) — chunk {ci+1}/{len(chunks)}

{chunk}

Summarize ONLY the changes in this chunk. Reply with ONLY the JSON:"""
            try:
                result = call_ollama_fn(sys_file, prompt, schema=FILE_SUMMARY_SCHEMA, max_tokens=512)
                chunk_summaries.append(result.get("summary", ""))
            except Exception:
                chunk_summaries.append(f"chunk {ci+1} failed")

        merged_summary = " | ".join(chunk_summaries)
        total_hours = sum(
            r.get("estimated_hours", 0.5) if isinstance(r, dict) else 0.5
            for r in chunk_summaries
        ) if any(isinstance(r, dict) for r in chunk_summaries) else len(chunks) * 0.5

        return {
            "file": filename,
            "summary": f"[large file, {len(chunks)} chunks] {merged_summary[:200]}",
            "change_type": "new_logic",
            "complexity": "high" if len(chunks) > 2 else "medium",
            "estimated_hours": min(total_hours, 8.0),
            "tags": tags + ["chunked"],
            "lines_added": added, "lines_deleted": deleted,
        }


# ===== ORCHESTRATION =====

def run_file_decomposition(diff, message, language, fc, la, ld, call_ollama_fn):
    """Run the full file decomposition pipeline on a large diff.

    Args:
        diff: Full unified diff string
        message: Commit message
        language: Programming language (e.g. "Rust", "TypeScript")
        fc: Files changed count
        la: Lines added
        ld: Lines deleted
        call_ollama_fn: LLM wrapper with signature (system, prompt, schema=None, max_tokens=1024) -> dict|str

    Returns:
        dict with keys: estimated_hours, reasoning, file_summaries, move_info, bulk_info,
                        file_classifications, evaluation_method
    """
    # Wrap with retries, fence stripping, JSON fallback (matching v13 robustness)
    call_fn = _robust_wrap(call_ollama_fn)
    sys_file, sys_agg = make_system_prompts(language)
    commit_stats = {"files": fc, "added": la, "deleted": ld}

    # Step 1: Split diff by file
    file_diffs = split_diff_by_file(diff)

    # Step 1a: Regex classification
    file_info = []
    for filename, fdiff in file_diffs:
        fa, fd_stat = parse_file_stat(fdiff)
        tags = classify_file_regex(filename, fdiff, fa, fd_stat)
        file_info.append({
            "filename": filename, "diff": fdiff,
            "added": fa, "deleted": fd_stat, "tags": tags,
        })

    # Step 1b: Classify move/rename
    move_info = classify_move_commit(message, file_info)

    # Step 1c: Detect bulk/systematic edits
    bulk_info = detect_bulk_refactoring(file_info)

    # Step 2: Model-verified classification for untagged files with >500 lines
    ambiguous = [f for f in file_info if not f["tags"] and (f["added"] + f["deleted"]) > 500]
    if ambiguous:
        model_classes = model_classify_files(ambiguous, message, call_fn)
        for f in file_info:
            if f["filename"] in model_classes:
                mc = model_classes[f["filename"]]
                if mc in ("generated", "lock_file"):
                    f["tags"].append("generated")
                elif mc == "data":
                    f["tags"].append("imported_data")
                elif mc == "formatting_only":
                    f["tags"].append("formatting_only")
                elif mc == "test":
                    if "test" not in f["tags"]:
                        f["tags"].append("test")
                elif mc == "config":
                    f["tags"].append("config")

    # Check if commit is test-only
    skip_tags_set = {"generated", "imported_data", "large_data_file", "formatting_only", "locale", "config"}
    non_test_code = [f for f in file_info if "test" not in f["tags"] and not (skip_tags_set & set(f["tags"]))]
    commit_stats["test_only"] = len(non_test_code) == 0

    # Step 3: Summarize each file (parallel)
    fd_concurrency = max(1, min(int(os.environ.get('LLM_CONCURRENCY', '5')), 10))
    if fd_concurrency <= 1 or len(file_info) <= 1:
        file_summaries = [
            summarize_file_full(
                f["filename"], f["diff"], f["tags"],
                message, commit_stats, sys_file, call_fn, move_info, bulk_info
            )
            for f in file_info
        ]
    else:
        file_summaries = [None] * len(file_info)
        with ThreadPoolExecutor(max_workers=fd_concurrency) as executor:
            futures = {
                executor.submit(
                    summarize_file_full,
                    f["filename"], f["diff"], f["tags"],
                    message, commit_stats, sys_file, call_fn, move_info, bulk_info
                ): idx
                for idx, f in enumerate(file_info)
            }
            for future in as_completed(futures):
                idx = futures[future]
                file_summaries[idx] = future.result()

    # Count stats
    manual_count = sum(1 for s in file_summaries
                       if not any(t in s.get("tags", []) for t in
                                  ["generated", "imported_data", "large_data_file",
                                   "formatting_only", "locale"]))
    skipped_count = len(file_summaries) - manual_count
    test_count = sum(1 for s in file_summaries if "test" in s.get("tags", []))

    # Step 4: Build aggregation prompt and get total estimate
    agg_prompt = build_aggregation_prompt(
        file_summaries, message, fc, la, ld, move_info, bulk_info
    )

    prompt = f"""{agg_prompt}

Evaluate the TOTAL commit effort based on the per-file analysis above.
Reply with ONLY the JSON:"""

    evaluation = call_fn(sys_agg, prompt, schema=EVAL_SCHEMA, max_tokens=512)

    estimated_hours = evaluation.get("estimated_hours", 5.0) if isinstance(evaluation, dict) else 5.0
    reasoning = evaluation.get("reasoning", "") if isinstance(evaluation, dict) else ""

    result = {
        "estimated_hours": estimated_hours,
        "reasoning": reasoning,
        "evaluation_method": "file_decomposition",
        "file_summaries": [
            {"file": s.get("file", ""), "estimated_hours": s.get("estimated_hours", 0),
             "summary": s.get("summary", ""), "tags": s.get("tags", [])}
            for s in file_summaries
        ],
        "file_classifications": {
            "total": len(file_info),
            "manual": manual_count - test_count,
            "test": test_count,
            "skipped": skipped_count,
        },
    }

    if move_info and move_info.get("is_move"):
        result["move_detected"] = True
        result["move_type"] = move_info.get("move_type")
        result["move_pairs"] = [
            {"source": s, "dest": d, "overlap": round(p, 2)}
            for s, d, p in move_info.get("pairs", [])
        ]
        result["move_ratio"] = round(move_info.get("move_ratio", 0), 3)
        if move_info.get("new_build_artifacts"):
            result["new_build_artifacts"] = move_info["new_build_artifacts"]
    if bulk_info and bulk_info.get("is_bulk"):
        result["bulk_detected"] = True
        result["bulk_patterned_count"] = len(bulk_info.get("patterned_files", set()))
        result["bulk_ratio"] = round(bulk_info.get("bulk_ratio", 0), 3)
        result["bulk_top_patterns"] = bulk_info.get("top_patterns", [])

    return result


def synthesize_analysis_from_fd(fd_result, commit_message):
    """Convert FD result into a v15-compatible analysis dict for correction rules.

    The v15 correction rules expect an analysis dict with keys like:
    change_type, new_logic_percent, moved_or_copied_percent, boilerplate_percent,
    architectural_scope, cognitive_complexity, summary.

    We synthesize these from FD metadata.
    """
    file_summaries = fd_result.get("file_summaries", [])
    total_files = fd_result.get("file_classifications", {}).get("total", 1)
    test_count = fd_result.get("file_classifications", {}).get("test", 0)
    skipped_count = fd_result.get("file_classifications", {}).get("skipped", 0)

    # Determine change_type from file composition
    if test_count > 0 and test_count >= total_files - skipped_count:
        change_type = "test"
    elif fd_result.get("move_detected"):
        change_type = "refactoring"
    elif fd_result.get("bulk_detected"):
        change_type = "mechanical changes"
    else:
        change_type = "feature"

    # Estimate moved percentage from move info
    moved_pct = 0
    if fd_result.get("move_detected"):
        move_pairs = fd_result.get("move_pairs", [])
        if move_pairs:
            avg_overlap = sum(p.get("overlap", 0) for p in move_pairs) / len(move_pairs)
            # Rough: moved files / total files * avg overlap
            moved_files = len(move_pairs) * 2  # source + dest
            moved_pct = min(95, int(moved_files / max(total_files, 1) * avg_overlap * 100))

    # Estimate boilerplate from bulk info
    boilerplate_pct = 0
    if fd_result.get("bulk_detected"):
        bulk_count = fd_result.get("bulk_patterned_count", 0)
        boilerplate_pct = min(90, int(bulk_count / max(total_files, 1) * 100))

    new_logic_pct = max(0, 100 - moved_pct - boilerplate_pct)

    # Determine architectural scope
    move_type = fd_result.get("move_type")
    if move_type == "ARCHITECTURAL_EXTRACT":
        scope = "package"
    elif move_type == "MODULE_EXTRACT":
        scope = "module"
    elif total_files > 30:
        scope = "package"
    elif total_files > 10:
        scope = "module"
    else:
        scope = "none"

    # Cognitive complexity
    if new_logic_pct > 50:
        complexity = "high"
    elif new_logic_pct > 20:
        complexity = "medium"
    else:
        complexity = "low"

    summary = fd_result.get("reasoning", "File decomposition estimate")

    return {
        "change_type": change_type,
        "new_logic_percent": new_logic_pct,
        "moved_or_copied_percent": moved_pct,
        "boilerplate_percent": boilerplate_pct,
        "architectural_scope": scope,
        "cognitive_complexity": complexity,
        "summary": summary,
    }


# ===== HYBRID FD: CLASSIFY-FIRST APPROACH =====

def _check_cheap_signals(message, fc, la, ld):
    """Pre-LLM heuristic checks based on commit metadata.

    Returns (estimated_hours, method_tag) if a cheap signal fires, or (None, None) otherwise.
    """
    msg_lower = message.lower()
    total_churn = la + ld

    # Signal 1: Bulk deletion — la tiny, ld huge (lockfile removal, dead code purge)
    if la < 20 and ld > 500:
        return 0.5, 'cheap_bulk_deletion'

    # Signal 2: Near-zero net delta with high churn → formatting/rename
    if total_churn > 200:
        net_ratio = abs(la - ld) / total_churn
        if net_ratio < 0.05:
            # Almost symmetric: likely reformat or rename
            for kw in ['prettier', 'format', 'lint', 'eslint', 'rustfmt', 'gofmt',
                        'rename', 'whitespace', 'indent']:
                if kw in msg_lower:
                    return min(2.0, max(0.5, fc * 0.05)), 'cheap_reformat_keyword'
            # No keyword but very symmetric — still likely formatting
            if net_ratio < 0.02 and total_churn > 500:
                return min(2.0, max(0.5, fc * 0.05)), 'cheap_reformat_symmetric'

    # Signal 3: Lockfile-only or "remove lock" patterns
    for kw in ['remove lock', 'delete lock', 'pnpm-lock', 'package-lock',
                'yarn.lock', 'cargo.lock']:
        if kw in msg_lower:
            return 0.5, 'cheap_lockfile'

    # Signal 4: Translation/locale bulk
    for kw in ['locale', 'translation', 'i18n', 'l10n']:
        if kw in msg_lower:
            return min(5.0, max(1.0, fc * 0.1)), 'cheap_locale'

    return None, None


def _build_metadata_prompt(message, fc, la, ld, file_info, language):
    """Build a compact metadata-only prompt for v15-style classification.

    No diff content — just filenames, stats, and regex tags.
    This fits easily in context regardless of diff size.
    """
    lines = []
    lines.append(f"Commit: {message}")
    lines.append(f"Language: {language}")
    lines.append(f"Total: {fc} files changed, +{la}/-{ld}")
    lines.append("")

    # Summarize file composition
    tag_counts = {}
    for f in file_info:
        for t in f["tags"]:
            tag_counts[t] = tag_counts.get(t, 0) + 1

    if tag_counts:
        tag_summary = ", ".join(f"{t}:{c}" for t, c in sorted(tag_counts.items()))
        lines.append(f"File tags: {tag_summary}")

    untagged = sum(1 for f in file_info if not f["tags"])
    lines.append(f"Untagged (manual code): {untagged} files")
    lines.append("")

    # File list (truncated for very large commits)
    lines.append("Files:")
    display_files = file_info[:50]  # cap at 50 for prompt size
    for f in display_files:
        tags_str = f" [{','.join(f['tags'])}]" if f["tags"] else ""
        lines.append(f"  {f['filename']} (+{f['added']}/-{f['deleted']}){tags_str}")
    if len(file_info) > 50:
        lines.append(f"  ... and {len(file_info) - 50} more files")

    return "\n".join(lines)


def run_fd_hybrid(diff, message, language, fc, la, ld, call_ollama_fn):
    """Hybrid FD: classify first, then route.

    For diffs >60K chars:
    1. Check cheap signals (no LLM) → immediate estimate for obvious cases
    2. Split diff, classify files with regex, detect move/bulk patterns
    3. Classify commit via v15 PROMPT_CLASSIFY on metadata (no full diff)
    4. Route:
       a. Mechanical (new_logic < 20%) → metadata-based LLM estimate + correction rules
       b. Complex (new_logic >= 20%) → full per-file FD pipeline

    Args:
        diff: Full unified diff string (>60K chars expected)
        message: Commit message
        language: Programming language
        fc, la, ld: Files changed, lines added, lines deleted
        call_ollama_fn: LLM wrapper (system, prompt, schema=None, max_tokens=1024) -> dict|str

    Returns:
        dict with keys: estimated_hours, analysis, method, routed_to, rule_applied, etc.
    """
    call_fn = _robust_wrap(call_ollama_fn)

    # --- Step 0: Cheap signal checks (no LLM) ---
    cheap_est, cheap_tag = _check_cheap_signals(message, fc, la, ld)
    if cheap_est is not None:
        print(f" [{cheap_tag}]", end='', flush=True)
        return {
            'estimated_hours': cheap_est,
            'raw_estimate': cheap_est,
            'method': 'FD_cheap',
            'routed_to': cheap_tag,
            'analysis': {
                'change_type': 'mechanical changes',
                'new_logic_percent': 0,
                'moved_or_copied_percent': 0,
                'boilerplate_percent': 100,
                'architectural_scope': 'none',
                'cognitive_complexity': 'low',
                'summary': f'Cheap signal: {cheap_tag}',
            },
            'rule_applied': cheap_tag,
        }

    # --- Step 1: Split diff, regex classify, detect patterns ---
    file_diffs = split_diff_by_file(diff)
    file_info = []
    for filename, fdiff in file_diffs:
        fa, fd_stat = parse_file_stat(fdiff)
        tags = classify_file_regex(filename, fdiff, fa, fd_stat)
        file_info.append({
            "filename": filename, "diff": fdiff,
            "added": fa, "deleted": fd_stat, "tags": tags,
        })

    move_info = classify_move_commit(message, file_info)
    bulk_info = detect_bulk_refactoring(file_info)

    # --- Step 2: Metadata-only v15 classification (1 LLM call, small prompt) ---
    metadata_prompt = _build_metadata_prompt(message, fc, la, ld, file_info, language)
    analysis = call_fn(
        PROMPT_CLASSIFY.format(lang=language),
        f"{metadata_prompt}\n\nClassify this commit:",
        schema=ANALYSIS_SCHEMA,
        max_tokens=1024,
    )

    if not analysis or not isinstance(analysis, dict):
        # Classification failed — fall back to full FD
        print(" [classify-fail→FD]", end='', flush=True)
        return run_file_decomposition(diff, message, language, fc, la, ld, call_ollama_fn)

    new_logic = analysis.get('new_logic_percent', 50)
    scope = analysis.get('architectural_scope', 'none')

    # Enrich analysis with move/bulk detection
    if move_info.get("is_move") and analysis.get('moved_or_copied_percent', 0) < 30:
        # Regex detected move but LLM didn't — trust regex more for metadata-only
        analysis['moved_or_copied_percent'] = max(
            analysis.get('moved_or_copied_percent', 0), 60
        )
        new_logic = max(0, 100 - analysis['moved_or_copied_percent'] - analysis.get('boilerplate_percent', 0))
        analysis['new_logic_percent'] = new_logic

    if bulk_info.get("is_bulk") and analysis.get('boilerplate_percent', 0) < 30:
        analysis['boilerplate_percent'] = max(
            analysis.get('boilerplate_percent', 0),
            int(bulk_info['bulk_ratio'] * 100)
        )
        new_logic = max(0, 100 - analysis.get('moved_or_copied_percent', 0) - analysis['boilerplate_percent'])
        analysis['new_logic_percent'] = new_logic

    # --- Step 2b: Force complex path for version releases / breaking changes ---
    # These have high invisible work (migration planning, API design decisions)
    # that metadata-only estimation systematically underestimates.
    force_complex = False
    msg_lower = message.lower()
    if re.match(r'^v\d+\b', msg_lower):
        force_complex = True  # "v5 (#2138)", "v2.0", etc.
    elif 'breaking' in msg_lower and fc >= 10:
        force_complex = True  # "breaking(types): ..." with many files
    # Also check for migration guides in file list — strong signal of deliberate breaking change
    if not force_complex:
        for f in file_info:
            if 'migrat' in f['filename'].lower():
                force_complex = True
                break

    # --- Step 3: Route ---
    if force_complex:
        print(f" [version-release→FD]", end='', flush=True)
        return run_file_decomposition(diff, message, language, fc, la, ld, call_ollama_fn)
    elif new_logic < 20:
        # MECHANICAL PATH: metadata-based estimate (no per-file FD needed)
        print(f" [mechanical:{new_logic}%]", end='', flush=True)
        return _estimate_mechanical(
            message, metadata_prompt, analysis, language, fc, la, ld,
            scope, call_fn, move_info, bulk_info
        )
    else:
        # COMPLEX PATH: full per-file FD
        print(f" [complex:{new_logic}%→FD]", end='', flush=True)
        return run_file_decomposition(diff, message, language, fc, la, ld, call_ollama_fn)


def _estimate_mechanical(message, metadata_prompt, analysis, language, fc, la, ld,
                         scope, call_fn, move_info, bulk_info):
    """Estimate effort for mechanical/low-logic commits using metadata + v15 scope-aware prompts.

    No per-file FD — just one LLM estimation call on metadata + classification.
    """
    analysis_text = (
        f"Change type: {analysis.get('change_type', '?')}\n"
        f"New logic: {analysis.get('new_logic_percent', '?')}%, "
        f"Moved: {analysis.get('moved_or_copied_percent', '?')}%, "
        f"Boilerplate: {analysis.get('boilerplate_percent', '?')}%\n"
        f"Scope: {scope}, Complexity: {analysis.get('cognitive_complexity', '?')}\n"
        f"Summary: {analysis.get('summary', '?')}"
    )

    # Add move/bulk context
    context_lines = []
    if move_info and move_info.get("is_move"):
        context_lines.append(f"Move detected: {move_info.get('move_type', '?')}, "
                             f"{len(move_info.get('pairs', []))} file pairs, "
                             f"avg overlap {move_info.get('avg_overlap', 0):.0%}")
    if bulk_info and bulk_info.get("is_bulk"):
        context_lines.append(f"Bulk edit: {len(bulk_info.get('patterned_files', set()))} patterned files "
                             f"out of {fc} total")
    context = "\n".join(context_lines)

    # Route estimation prompt by scope (v15 cascading logic)
    if scope == 'none':
        est_prompt = PROMPT_EST_SIMPLE.format(lang=language)
        schema = ESTIMATE_SCHEMA
    elif scope == 'module':
        est_prompt = PROMPT_EST_TASK_DECOMP.format(lang=language)
        schema = DECOMP_SCHEMA
    else:
        est_prompt = PROMPT_EST_ARCHITECTURAL.format(lang=language)
        schema = ESTIMATE_SCHEMA

    user_prompt = (
        f"{metadata_prompt}\n\n"
        f"Analysis:\n{analysis_text}\n"
    )
    if context:
        user_prompt += f"\nDetected patterns:\n{context}\n"
    user_prompt += "\nEstimate:"

    result = call_fn(est_prompt, user_prompt, schema=schema, max_tokens=1024)

    raw_estimate = 5.0
    if isinstance(result, dict):
        raw_estimate = result.get('estimated_hours', 5.0)

    return {
        'estimated_hours': raw_estimate,
        'raw_estimate': raw_estimate,
        'method': f'FD_hybrid_mechanical_{scope}',
        'routed_to': scope,
        'analysis': analysis,
        'rule_applied': None,
        'reasoning': result.get('reasoning', '') if isinstance(result, dict) else '',
        'fd_details': {
            'routing': 'mechanical',
            'new_logic_percent': analysis.get('new_logic_percent', 0),
            'move_detected': move_info.get('is_move', False),
            'bulk_detected': bulk_info.get('is_bulk', False),
        },
    }
