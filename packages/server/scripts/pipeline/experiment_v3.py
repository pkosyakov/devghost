"""
FD v3 Holistic Estimation Experiment.

Evaluates holistic (metadata-only, no diff sent to LLM) commit effort estimation
across multiple models using production pipeline signal extraction.

Usage:
    python experiment_v3.py --repo /path/to/repo --dry-run
    python experiment_v3.py --repo /path/to/repo --models opus sonnet --commit 188c43e
    python experiment_v3.py --repo /path/to/repo --no-cache

Tasks implemented here: 1-7 (skeleton, git extraction, v3 metadata, prompt formatting, API call,
experiment runner, report generation).
"""

import re
import os
import sys
import math
import json
import time
import random
import hashlib
import argparse
import subprocess
from collections import Counter
import statistics
from datetime import datetime

import requests

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from file_decomposition import (
    classify_file_regex,
    classify_file_tier,
    adaptive_filter,
    build_clusters,
    classify_move_commit,
    detect_bulk_refactoring,
    split_diff_by_file,
    parse_file_stat,
)


# ===== CONSTANTS =====

MODELS = {
    "opus":   "anthropic/claude-opus-4.6",
    "sonnet": "anthropic/claude-sonnet-4.6",
    "haiku":  "anthropic/claude-haiku-4.5",
    "qwen":   "qwen/qwen3-coder-plus",
    "gpt":    "openai/gpt-5.3-codex",
}

GT_CASES = [
    {"sha": "188c43e", "label": "Refactor/monorepo (#597) — 870 files, cross-repo copy",          "gt_low": 15, "gt_high": 30},
    {"sha": "1d02576", "label": "Feat/dialer v1 (#968) — 272 files, real feature",                 "gt_low": 40, "gt_high": 60},
    {"sha": "0237e3a", "label": "Feat/workos auth (#751) — 388 files, auth+RBAC+billing",          "gt_low": 30, "gt_high": 50},
    {"sha": "47252d6", "label": "Feat/magic campaigns (#842) — 391 files, AI campaigns",           "gt_low": 40, "gt_high": 60},
    {"sha": "4ccdf71", "label": "Feat/leads lists (#1297) — 265 files, unified API+UI",            "gt_low": 30, "gt_high": 50},
    {"sha": "16dc74e", "label": "Feat/pnpm vitest migration (#974) — 1036 files, tooling",         "gt_low": 8,  "gt_high": 16},
    {"sha": "9c2a0ed", "label": "Feat/web visitors (#1048) — 159 files, feature",                  "gt_low": 25, "gt_high": 40},
    {"sha": "b4bb3f0", "label": "Adhoc: leadsdb rework (#782) — 145 files, protobuf+refactor",     "gt_low": 20, "gt_high": 35},
    {"sha": "18156d0", "label": "Temporal scheduler (#939) — 123 files, feature",                   "gt_low": 20, "gt_high": 35},
    {"sha": "c8269d0", "label": "UI library setup — 107 files, scaffold",                           "gt_low": 4,  "gt_high": 8},
]

V3_SCHEMA = {
    "type": "object",
    "properties": {
        "low":        {"type": "number", "description": "Low estimate in hours"},
        "mid":        {"type": "number", "description": "Best estimate in hours"},
        "high":       {"type": "number", "description": "High estimate in hours"},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "reasoning":  {"type": "string", "description": "2-3 sentences: change type, effective size, complexity"},
    },
    "required": ["low", "mid", "high", "confidence", "reasoning"],
}

CALIBRATION = {
    "lines_per_hour": "50-100",
    "generated_hours": "0",
    "rename_hours_per_50": "0.5",
    "test_effort_ratio": "50-75%",
    "config_hours_each": "0.1-0.5",
    "docs_hours_per_100_lines": "0.3",
    "bulk_refactor_hours": "2-4",
}

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/chat/completions"

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache", "experiment_v3")
RESULTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "experiment_v3_results")

# Extension to language mapping for language detection
EXT_TO_LANG = {
    ".ts": "TypeScript", ".tsx": "TypeScript",
    ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".py": "Python",
    ".go": "Go",
    ".rs": "Rust",
    ".java": "Java",
    ".kt": "Kotlin",
    ".scala": "Scala",
    ".cs": "C#",
    ".cpp": "C++", ".cc": "C++", ".cxx": "C++",
    ".c": "C",
    ".swift": "Swift",
    ".rb": "Ruby",
    ".php": "PHP",
    ".sh": "Shell", ".bash": "Shell",
    ".sql": "SQL",
    ".html": "HTML", ".htm": "HTML",
    ".css": "CSS", ".scss": "CSS", ".sass": "CSS", ".less": "CSS",
    ".proto": "Protobuf",
    ".tf": "Terraform",
    ".yaml": "YAML", ".yml": "YAML",
    ".json": "JSON",
    ".md": "Markdown", ".mdx": "Markdown",
    ".toml": "TOML",
}

# Scaffold detection patterns (replicated from file_decomposition.py lines 1434-1448)
_SCAFFOLD_KEYWORDS = re.compile(
    r'\b(monorepo|mono[- ]?repo|scaffold|boilerplate|template|seed|'
    r'vendor|copy\s+(from|into|over)|bootstrap|initial\s+(commit|import|setup))\b',
    re.IGNORECASE,
)
_SCAFFOLD_SETUP = re.compile(
    r'\b(wip|init)\b.*\b(setup|library|scaffold|skeleton)\b',
    re.IGNORECASE,
)


# ===== TASK 2: GIT METADATA EXTRACTION =====

def _run_git(repo, args, encoding="utf-8"):
    """Run a git command in repo dir, return stdout string."""
    result = subprocess.run(
        ["git"] + args,
        cwd=repo,
        capture_output=True,
        encoding=encoding,
        errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"git {' '.join(args)} failed (rc={result.returncode}): {result.stderr.strip()}"
        )
    return result.stdout


def extract_commit_data(repo, sha):
    """Extract all commit metadata needed for v3 estimation.

    Args:
        repo: Absolute path to git repository.
        sha: Commit SHA (full or abbreviated).

    Returns:
        dict with keys:
            sha, message, parent, file_info, move_info, bulk_info,
            filter_result, clusters, new_file_ratio,
            total_files, total_la, total_ld
    """
    # Commit message (subject line only)
    message = _run_git(repo, ["log", "--format=%s", "-1", sha]).strip()

    # Parent SHA (first parent for merge commits)
    parent_raw = _run_git(repo, ["log", "--format=%P", "-1", sha]).strip()
    parent = parent_raw.split()[0] if parent_raw else None

    if not parent:
        # Initial commit — diff against empty tree
        empty_tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
        diff_base = empty_tree
    else:
        diff_base = parent

    # Full diff (used for classification, NOT sent to LLM)
    diff = _run_git(repo, ["diff", f"{diff_base}..{sha}"])

    # Numstat for aggregate counts
    numstat_raw = _run_git(repo, ["diff", "--numstat", f"{diff_base}..{sha}"])
    total_la = 0
    total_ld = 0
    for line in numstat_raw.strip().splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            try:
                la = int(parts[0]) if parts[0] != "-" else 0
                ld = int(parts[1]) if parts[1] != "-" else 0
                total_la += la
                total_ld += ld
            except ValueError:
                pass

    # Split diff by file, classify each file
    file_diffs = split_diff_by_file(diff)
    file_info = []
    for filename, fdiff in file_diffs:
        fa, fd_stat = parse_file_stat(fdiff)
        tags = classify_file_regex(filename, fdiff, fa, fd_stat)
        file_info.append({
            "filename": filename,
            "diff": fdiff,
            "added": fa,
            "deleted": fd_stat,
            "tags": tags,
        })

    total_files = len(file_info)

    # Move/rename and bulk refactor detection
    move_info = classify_move_commit(message, file_info)
    bulk_info = detect_bulk_refactoring(file_info)

    # Adaptive filter: split into SKIP / HEURISTIC / LLM tiers
    filter_result = adaptive_filter(file_info)

    # Cluster LLM-required files
    clusters = build_clusters(filter_result["llm_files"])

    # New-file ratio (files with additions but zero deletions)
    new_files = [f for f in file_info if f["added"] > 0 and f["deleted"] == 0]
    new_file_ratio = len(new_files) / total_files if total_files > 0 else 0.0

    return {
        "sha": sha,
        "message": message,
        "parent": parent,
        "file_info": file_info,
        "move_info": move_info,
        "bulk_info": bulk_info,
        "filter_result": filter_result,
        "clusters": clusters,
        "new_file_ratio": new_file_ratio,
        "total_files": total_files,
        "total_la": total_la,
        "total_ld": total_ld,
    }


# ===== TASK 3: V3 METADATA COMPUTATION =====

def compute_v3_metadata(commit_data):
    """Compute additional metadata signals for v3 holistic estimation.

    Args:
        commit_data: Output of extract_commit_data().

    Returns:
        dict with keys:
            entropy, entropy_label,
            effective_la, effective_ld, effective_fc,
            file_size_p50, file_size_p90, file_size_max,
            module_boundary_count,
            ext_distribution (top 5),
            languages (list of detected language names),
            primary_language,
    """
    file_info = commit_data["file_info"]
    llm_files = commit_data["filter_result"]["llm_files"]

    # --- Shannon entropy of change distribution ---
    # p_i = (added + deleted) / total_changed for each file
    total_changed = sum(f["added"] + f["deleted"] for f in file_info)
    entropy = 0.0
    if total_changed > 0 and len(file_info) > 1:
        for f in file_info:
            churn = f["added"] + f["deleted"]
            if churn > 0:
                p = churn / total_changed
                entropy -= p * math.log2(p)

    # Entropy interpretation
    if file_info:
        max_entropy = math.log2(len(file_info))
        normalized = entropy / max_entropy if max_entropy > 0 else 0.0
        if normalized >= 0.8:
            entropy_label = "highly uniform"
        elif normalized >= 0.5:
            entropy_label = "moderately spread"
        else:
            entropy_label = "concentrated"
    else:
        entropy_label = "concentrated"

    # --- Effective churn from LLM files only ---
    effective_la = sum(f["added"] for f in llm_files)
    effective_ld = sum(f["deleted"] for f in llm_files)
    effective_fc = len(llm_files)

    # --- File size distribution (lines changed per file) from llm_files ---
    file_sizes = sorted(f["added"] + f["deleted"] for f in llm_files)
    if file_sizes:
        n = len(file_sizes)
        file_size_p50 = file_sizes[min(int(n * 0.5), n - 1)]
        file_size_p90 = file_sizes[min(int(n * 0.9), n - 1)]
        file_size_max = file_sizes[-1]
    else:
        file_size_p50 = file_size_p90 = file_size_max = 0

    # --- Module boundaries from ALL file_info (unique top-level dirs) ---
    top_dirs = set()
    for f in file_info:
        parts = f["filename"].replace("\\", "/").split("/")
        if len(parts) > 1:
            top_dirs.add(parts[0])
    module_boundary_count = len(top_dirs)
    modules = sorted(top_dirs)[:10]

    # --- Extension distribution (top 5) from llm_files ---
    ext_counter = Counter()
    for f in llm_files:
        _, ext = os.path.splitext(f["filename"])
        if ext:
            ext_counter[ext.lower()] += 1
    ext_distribution = ext_counter.most_common(5)

    # --- Language detection from file extensions (llm_files) ---
    lang_counter = Counter()
    for ext, count in ext_counter.items():
        lang = EXT_TO_LANG.get(ext)
        if lang:
            lang_counter[lang] += count
    languages = [lang for lang, _ in lang_counter.most_common()]
    primary_language = languages[0] if languages else "Unknown"

    return {
        "entropy": round(entropy, 3),
        "entropy_label": entropy_label,
        "effective_la": effective_la,
        "effective_ld": effective_ld,
        "effective_fc": effective_fc,
        "file_size_p50": file_size_p50,
        "file_size_p90": file_size_p90,
        "file_size_max": file_size_max,
        "module_boundary_count": module_boundary_count,
        "modules": modules,
        "ext_distribution": ext_distribution,
        "languages": languages,
        "primary_language": primary_language,
    }


# ===== TASK 4: PROMPT FORMATTING =====

def build_system_prompt(cal=None):
    """Build system prompt with calibration anchors.

    Args:
        cal: Optional calibration dict; falls back to module-level CALIBRATION.

    Returns:
        System prompt string.
    """
    c = cal or CALIBRATION
    lines = [
        "You are an expert software engineer estimating commit effort for a mid-level developer "
        "(3-4 years experience, familiar with the codebase, working without AI assistance).",
        "",
        "## CALIBRATION",
        f"- Manual code: {c['lines_per_hour']} lines/hour",
        f"- Auto-generated code: {c['generated_hours']} hours (zero effort)",
        f"- File rename/move (per 50 files): {c['rename_hours_per_50']}h",
        f"- Tests: {c['test_effort_ratio']} of equivalent production code effort",
        f"- Config changes: {c['config_hours_each']} each",
        f"- Docs: {c['docs_hours_per_100_lines']}h per 100 lines",
        f"- Bulk find-replace/refactor: {c['bulk_refactor_hours']}h total (not per file)",
        "",
        "## ANTI-OVERESTIMATION",
        "- SKIP files: generated, lock files, snapshots, locale files = 0h",
        "- Rename-only commits: effort is coordination overhead, NOT rewriting code",
        "- Bulk systematic edits (same pattern N files): count as 1 task, not N",
        "- Scaffold/copy commits: base setup time only, not full feature time",
        "- Tests that mirror implementation: 50-75% of production code effort, not 100%",
        "- Config files: quick edits; only complex new configs take >0.5h",
        "",
        "## RESPONSE FORMAT",
        "Respond with a JSON object matching the schema exactly.",
        "- low: conservative lower bound (everything goes fast)",
        "- mid: most likely estimate for a competent mid-level dev",
        "- high: upper bound (unfamiliar areas, unexpected complexity)",
        "- confidence: 'low' if you're uncertain about the change type, "
        "'medium' for typical commits, 'high' when signals are clear",
        "- reasoning: 2-3 sentences covering change type, effective size, and complexity drivers",
    ]
    return "\n".join(lines)


def build_v3_prompt(commit_data, v3_meta):
    """Build structured user prompt for v3 holistic estimation.

    Args:
        commit_data: Output of extract_commit_data().
        v3_meta: Output of compute_v3_metadata().

    Returns:
        User prompt string.
    """
    msg = commit_data["message"]
    sha = commit_data["sha"]
    total_files = commit_data["total_files"]
    total_la = commit_data["total_la"]
    total_ld = commit_data["total_ld"]
    new_file_ratio = commit_data["new_file_ratio"]
    move_info = commit_data["move_info"]
    bulk_info = commit_data["bulk_info"]
    filter_result = commit_data["filter_result"]
    clusters = commit_data["clusters"]

    skip_count = filter_result["filter_stats"]["skip"]
    heuristic_count = filter_result["filter_stats"]["heuristic"]
    llm_count = filter_result["filter_stats"]["llm"]

    lines = []

    # --- COMMIT section ---
    lines.append("## COMMIT")
    lines.append(f"SHA: {sha}")
    lines.append(f"Message: {msg}")
    lines.append("")

    # --- LANGUAGE section ---
    lines.append("## LANGUAGE")
    lines.append(f"Primary: {v3_meta['primary_language']}")
    if len(v3_meta["languages"]) > 1:
        lines.append(f"Also: {', '.join(v3_meta['languages'][1:5])}")
    lines.append("")

    # --- CHANGE VOLUME section ---
    lines.append("## CHANGE VOLUME")
    lines.append(f"Total files: {total_files}  (+{total_la} / -{total_ld} lines)")
    lines.append(f"New-file ratio: {new_file_ratio:.0%} of files are add-only")
    module_list = ", ".join(v3_meta["modules"][:8])
    if v3_meta["module_boundary_count"] > 8:
        module_list += f" (+{v3_meta['module_boundary_count'] - 8} more)"
    lines.append(f"Module boundaries touched: {v3_meta['module_boundary_count']} ({module_list})")
    lines.append("")

    # --- FILE TYPE BREAKDOWN section ---
    heur_total = commit_data["filter_result"]["heuristic_total"]

    lines.append("## FILE TYPE BREAKDOWN")
    lines.append(f"SKIP (generated/lock/locale): {skip_count} files — 0h")
    lines.append(f"HEURISTIC (docs/config/tests): {heuristic_count} files — ~{heur_total:.1f}h by formula")
    lines.append(f"LLM-required (substantive code): {llm_count} files — needs judgment")
    lines.append(
        f"Effective churn (LLM files only): +{v3_meta['effective_la']} / -{v3_meta['effective_ld']} lines"
    )
    lines.append("")

    # --- DISTRIBUTION section ---
    lines.append("## DISTRIBUTION")
    lines.append(f"Change entropy: {v3_meta['entropy']:.2f} bits ({v3_meta['entropy_label']})")
    lines.append(
        f"File size (lines changed) — p50: {v3_meta['file_size_p50']}, "
        f"p90: {v3_meta['file_size_p90']}, max: {v3_meta['file_size_max']}"
    )
    lines.append("")

    # --- EXTENSIONS section ---
    if v3_meta["ext_distribution"]:
        lines.append("## EXTENSIONS (LLM files, top 5)")
        for ext, count in v3_meta["ext_distribution"]:
            lines.append(f"  {ext}: {count} files")
        lines.append("")

    # --- PATTERN FLAGS section ---
    lines.append("## PATTERN FLAGS")

    flags_found = False

    # 1. Move/rename flags
    if move_info.get("is_move"):
        pair_count = len(move_info.get("pairs", []))
        avg_overlap = move_info.get("avg_overlap", 0.0)
        move_ratio = move_info.get("move_ratio", 0.0)
        move_type = move_info.get("move_type", "MOVE")
        lines.append(
            f"  {move_type}: {pair_count} file pairs matched, "
            f"avg_overlap={avg_overlap:.0%}, move_ratio={move_ratio:.0%}"
        )
        flags_found = True

    # 2. Bulk refactor flags
    if bulk_info.get("is_bulk"):
        bulk_ratio = bulk_info.get("bulk_ratio", 0.0)
        pattern_desc = bulk_info.get("pattern_description", "bulk edit detected")
        lines.append(f"  BULK_REFACTOR: ratio={bulk_ratio:.0%}")
        lines.append(f"  {pattern_desc}")
        flags_found = True

    # 3. Scaffold signals
    is_bulk_new = new_file_ratio > 0.8 and total_la > 10000 and total_files >= 50
    has_scaffold_signal = bool(
        _SCAFFOLD_KEYWORDS.search(msg) or _SCAFFOLD_SETUP.search(msg)
    )
    is_near_total_add = new_file_ratio > 0.95

    if is_bulk_new and has_scaffold_signal:
        lines.append("  SCAFFOLD (keyword): bulk-new + scaffold keyword detected")
        flags_found = True
    elif is_bulk_new and is_near_total_add:
        lines.append("  SCAFFOLD (>95%): >95% new files, treat as copy/scaffold")
        flags_found = True
    elif is_bulk_new:
        lines.append(
            f"  BULK_NEW (no keyword): {new_file_ratio:.0%} new files, {total_la:,} lines added, "
            f"{total_files} files — possible feature or scaffold"
        )
        flags_found = True
    elif is_near_total_add and total_files >= 20:
        lines.append(
            f"  NEAR_TOTAL_ADD: {new_file_ratio:.0%} new files — "
            f"verify if scaffold or genuine feature"
        )
        flags_found = True

    # 4. HIGH_GENERATED flag
    if total_files > 0 and skip_count / total_files > 0.3:
        skip_pct = skip_count / total_files
        lines.append(
            f"  HIGH_GENERATED: {skip_pct:.0%} of files are SKIP-tier (generated/lock/locale) — "
            f"actual effort concentrated in remaining {total_files - skip_count} files"
        )
        flags_found = True

    if not flags_found:
        lines.append("  (none)")
    lines.append("")

    # --- STRUCTURE section ---
    lines.append("## STRUCTURE")
    if clusters:
        for cluster in clusters:
            name = cluster.get("name", "(root)")
            n_files = len(cluster.get("files", []))
            added = cluster.get("total_added", 0)
            deleted = cluster.get("total_deleted", 0)
            lines.append(f"  {name}: {n_files} files (+{added}/-{deleted})")
    else:
        lines.append("  (no LLM-required files)")
    lines.append("")

    lines.append("Estimate effort for this commit:")

    return "\n".join(lines)


# ===== TASK 5: OPENROUTER API CALL WITH CACHING =====

def _cache_key(system, prompt, model, schema=None):
    """Deterministic cache key from prompt content + model + schema."""
    schema_str = json.dumps(schema, sort_keys=True) if schema else ""
    key_str = f"{model}\n---\n{system}\n---\n{prompt}\n---\n{schema_str}"
    return hashlib.sha256(key_str.encode()).hexdigest()


def _cache_path(model, key):
    model_slug = re.sub(r'[^\w\-.]', '_', model)
    return os.path.join(CACHE_DIR, model_slug, f"{key}.json")


def read_cache(system, prompt, model, schema=None):
    key = _cache_key(system, prompt, model, schema)
    path = _cache_path(model, key)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data["response"], data["meta"]
    except (json.JSONDecodeError, OSError, KeyError):
        return None


def write_cache(system, prompt, model, response, meta, schema=None):
    key = _cache_key(system, prompt, model, schema)
    path = _cache_path(model, key)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"model": model, "response": response, "meta": meta,
                        "cached_at": datetime.now().isoformat()}, f, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        pass
    finally:
        if os.path.exists(tmp):
            try: os.remove(tmp)
            except OSError: pass


def _extract_json(text):
    """Extract JSON from text that may contain markdown or extra text."""
    text = text.strip()
    try: return json.loads(text)
    except json.JSONDecodeError: pass
    m = re.search(r'```(?:json)?\s*\n?([\s\S]*?)```', text)
    if m:
        try: return json.loads(m.group(1).strip())
        except json.JSONDecodeError: pass
    start = text.find('{')
    if start >= 0:
        depth = 0
        for i in range(start, len(text)):
            if text[i] == '{': depth += 1
            elif text[i] == '}':
                depth -= 1
                if depth == 0:
                    try: return json.loads(text[start:i + 1])
                    except json.JSONDecodeError: break
    return None


def call_openrouter(system, prompt, model, api_key, schema=None, no_cache=False):
    """Call OpenRouter API with caching and retry. Returns (parsed, meta)."""
    if not no_cache:
        cached = read_cache(system, prompt, model, schema)
        if cached:
            resp, meta = cached
            meta["cache_hit"] = True
            return resp, meta

    system_content = system
    if schema:
        system_content += f"\n\nYou MUST respond with ONLY valid JSON (no markdown, no extra text) matching this schema:\n{json.dumps(schema)}"

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_content},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_tokens": 512,
        "seed": 42,
        "provider": {"allow_fallbacks": True, "require_parameters": False},
    }
    if schema:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "response", "strict": True, "schema": schema},
        }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    max_retries = 3
    last_error = None
    for attempt in range(max_retries + 1):
        start = time.time()
        try:
            resp = requests.post(OPENROUTER_BASE_URL, json=payload, headers=headers, timeout=(20, 120))
            elapsed_ms = (time.time() - start) * 1000

            if resp.status_code != 200:
                last_error = f"HTTP {resp.status_code}: {resp.text[:300]}"
                if resp.status_code in {429, 500, 502, 503, 504} and attempt < max_retries:
                    time.sleep(2 ** attempt + random.uniform(0, 1))
                    continue
                return None, {"error": last_error, "elapsed_ms": elapsed_ms}

            data = resp.json()
            if "error" in data:
                err = data["error"]
                last_error = err.get("message", str(err)) if isinstance(err, dict) else str(err)
                return None, {"error": last_error, "elapsed_ms": elapsed_ms}

            content = data["choices"][0]["message"]["content"]
            text = re.sub(r'<think>[\s\S]*?</think>', '', content).strip()
            parsed = _extract_json(text) if schema else text

            if schema and parsed is None:
                last_error = f"Invalid JSON: {text[:200]}"
                if attempt < max_retries:
                    time.sleep(1)
                    continue
                return None, {"error": last_error, "elapsed_ms": elapsed_ms}

            usage = data.get("usage", {})
            meta = {
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
                "elapsed_ms": elapsed_ms,
                "provider": data.get("provider", "?"),
                "cache_hit": False,
            }
            if not no_cache:
                write_cache(system, prompt, model, parsed, meta, schema)
            return parsed, meta

        except Exception as e:
            elapsed_ms = (time.time() - start) * 1000
            last_error = str(e)
            if attempt < max_retries:
                time.sleep(2 ** attempt)
                continue

    return None, {"error": last_error, "elapsed_ms": 0}


# ===== TASK 6: EXPERIMENT RUNNER =====

def run_experiment(repo, model_aliases, api_key, no_cache=False, single_commit=None,
                   dry_run=False, calibration=None):
    """Run v3 experiment across GT cases x models. Returns (results, executed_cases)."""
    cases = GT_CASES
    if single_commit:
        cases = [c for c in GT_CASES if c["sha"].startswith(single_commit)]
        if not cases:
            print(f"ERROR: commit {single_commit} not found in GT_CASES")
            sys.exit(1)

    models = {alias: MODELS[alias] for alias in model_aliases}
    system_prompt = build_system_prompt(calibration)

    print(f"\n{'='*70}")
    print(f"FD V3 HOLISTIC ESTIMATION EXPERIMENT")
    print(f"Models: {', '.join(f'{a} ({m})' for a, m in models.items())}")
    print(f"Commits: {len(cases)}")
    print(f"Cache: {'disabled' if no_cache else 'enabled'}")
    print(f"{'='*70}\n")

    results = []

    for case in cases:
        sha = case["sha"]
        print(f"\n--- {sha[:7]} {case['label']} ---")
        print(f"    GT: {case['gt_low']}-{case['gt_high']}h")

        try:
            commit_data = extract_commit_data(repo, sha)
            v3_meta = compute_v3_metadata(commit_data)
            prompt = build_v3_prompt(commit_data, v3_meta)
        except Exception as e:
            print(f"    ERROR extracting data: {e}")
            for alias in models:
                results.append({"sha": sha, "label": case["label"],
                    "gt_low": case["gt_low"], "gt_high": case["gt_high"],
                    "model_alias": alias, "model_id": models[alias], "error": str(e)})
            continue

        fs = commit_data["filter_result"]["filter_stats"]
        heur_total = commit_data["filter_result"]["heuristic_total"]
        print(f"    Files: {commit_data['total_files']}, Substantive: {v3_meta['effective_fc']}, "
              f"Skip: {fs['skip']}, Heuristic: {fs['heuristic']} ({heur_total:.1f}h)")
        print(f"    Entropy: {v3_meta['entropy']:.2f} ({v3_meta['entropy_label']})")
        if commit_data["move_info"].get("is_move"):
            print(f"    Move: {commit_data['move_info'].get('move_type', '?')}")
        if commit_data["bulk_info"].get("is_bulk"):
            print(f"    Bulk: {commit_data['bulk_info'].get('bulk_ratio', 0):.0%} repetition")

        if dry_run:
            print(f"\n--- PROMPT ({len(prompt)} chars) ---")
            print(prompt)
            print(f"--- END PROMPT ---\n")
            continue

        gt_mid = (case["gt_low"] + case["gt_high"]) / 2

        for alias, model_id in models.items():
            t0 = time.time()
            parsed, meta = call_openrouter(
                system_prompt, prompt, model_id, api_key,
                schema=V3_SCHEMA, no_cache=no_cache,
            )
            wall_time = (time.time() - t0) * 1000

            if parsed is None:
                print(f"    [{alias}] ERROR: {meta.get('error', '?')}")
                results.append({"sha": sha, "label": case["label"],
                    "gt_low": case["gt_low"], "gt_high": case["gt_high"], "gt_mid": gt_mid,
                    "model_alias": alias, "model_id": model_id,
                    "error": meta.get("error", "unknown")})
                continue

            est_mid = parsed.get("mid", 0)
            est_low = parsed.get("low", 0)
            est_high = parsed.get("high", 0)
            confidence = parsed.get("confidence", "?")
            reasoning = parsed.get("reasoning", "")

            ape = abs(est_mid - gt_mid) / gt_mid * 100 if gt_mid > 0 else 0
            in_range = case["gt_low"] <= est_mid <= case["gt_high"]
            within_2x = est_mid <= case["gt_high"] * 2 and est_mid >= case["gt_low"] * 0.5

            cache_str = " [cached]" if meta.get("cache_hit") else ""
            status = "OK" if in_range else ("~2x" if within_2x else "MISS")

            print(f"    [{alias}] {est_low:.0f}-{est_mid:.0f}-{est_high:.0f}h "
                  f"conf={confidence} APE={ape:.0f}% [{status}]{cache_str}")

            results.append({
                "sha": sha, "label": case["label"],
                "gt_low": case["gt_low"], "gt_high": case["gt_high"], "gt_mid": gt_mid,
                "model_alias": alias, "model_id": model_id,
                "estimate_low": est_low, "estimate_mid": est_mid, "estimate_high": est_high,
                "confidence": confidence, "reasoning": reasoning,
                "ape": ape, "in_range": in_range, "within_2x": within_2x,
                "prompt_tokens": meta.get("prompt_tokens", 0),
                "completion_tokens": meta.get("completion_tokens", 0),
                "elapsed_ms": meta.get("elapsed_ms", 0),
                "wall_time_ms": wall_time,
                "cache_hit": meta.get("cache_hit", False),
                "provider": meta.get("provider", "?"),
                "heuristic_hours": heur_total,
            })

    return results, cases


# ===== TASK 7: REPORT GENERATION =====

def compute_aggregate(results, model_alias):
    """Compute aggregate metrics for one model."""
    mr = [r for r in results if r.get("model_alias") == model_alias and "error" not in r]
    if not mr:
        return None
    apes = [r["ape"] for r in mr]
    n = len(mr)
    signed = [r["estimate_mid"] - r["gt_mid"] for r in mr]
    return {
        "model_alias": model_alias,
        "model_id": mr[0]["model_id"],
        "n": n,
        "mape": round(sum(apes) / n, 1),
        "mdape": round(statistics.median(apes), 1),
        "in_range": sum(1 for r in mr if r["in_range"]),
        "within_2x": sum(1 for r in mr if r["within_2x"]),
        "mean_signed_error": round(sum(signed) / n, 1),
        "n_over": sum(1 for e in signed if e > 0),
        "n_under": sum(1 for e in signed if e < 0),
        "avg_tokens_in": int(sum(r["prompt_tokens"] for r in mr) / n),
        "avg_tokens_out": int(sum(r["completion_tokens"] for r in mr) / n),
        "avg_elapsed_ms": int(sum(r["elapsed_ms"] for r in mr) / n),
    }


def generate_reports(results, model_aliases, executed_cases):
    """Generate JSON + Markdown reports. Only includes executed_cases."""
    timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    os.makedirs(RESULTS_DIR, exist_ok=True)

    aggregates = {}
    for alias in model_aliases:
        agg = compute_aggregate(results, alias)
        if agg:
            aggregates[alias] = agg

    # --- JSON ---
    json_path = os.path.join(RESULTS_DIR, f"experiment_v3_{timestamp}.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"timestamp": timestamp,
                    "models": {a: MODELS[a] for a in model_aliases},
                    "gt_cases": len(executed_cases),
                    "aggregates": aggregates, "results": results},
                   f, ensure_ascii=False, indent=2)

    # --- Markdown ---
    md_path = os.path.join(RESULTS_DIR, f"experiment_v3_{timestamp}.md")
    lines = [
        f"# FD v3 Holistic Experiment Results",
        f"",
        f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"**Commits:** {len(executed_cases)}",
        f"**Models:** {', '.join(model_aliases)}",
        f"",
        f"## Summary — Models x Metrics",
        f"",
        f"| Model | MAPE | MdAPE | In-Range | Within 2x | Bias (avg) | Over/Under | Avg Latency |",
        f"|-------|------|-------|----------|-----------|-----------|------------|-------------|",
    ]

    # Heuristic baseline (from executed cases only)
    heur_by_commit = {}
    for r in results:
        if "heuristic_hours" in r and r["sha"] not in heur_by_commit:
            heur_by_commit[r["sha"]] = r["heuristic_hours"]
    if heur_by_commit:
        heur_apes, heur_in = [], 0
        for case in executed_cases:
            h = heur_by_commit.get(case["sha"])
            if h is not None:
                gt_mid = (case["gt_low"] + case["gt_high"]) / 2
                heur_apes.append(abs(h - gt_mid) / gt_mid * 100)
                if case["gt_low"] <= h <= case["gt_high"]:
                    heur_in += 1
        if heur_apes:
            lines.append(f"| **baseline (heuristic)** | {sum(heur_apes)/len(heur_apes):.1f}% | — "
                         f"| {heur_in}/{len(heur_apes)} | — | — | — | 0ms |")

    for alias in model_aliases:
        agg = aggregates.get(alias)
        if agg:
            bias = f"+{agg['mean_signed_error']}h" if agg['mean_signed_error'] >= 0 else f"{agg['mean_signed_error']}h"
            lines.append(f"| {alias} | {agg['mape']}% | {agg['mdape']}% "
                         f"| {agg['in_range']}/{agg['n']} | {agg['within_2x']}/{agg['n']} "
                         f"| {bias} | {agg['n_over']}O/{agg['n_under']}U | {agg['avg_elapsed_ms']}ms |")
        else:
            lines.append(f"| {alias} | ERROR | — | — | — | — | — | — |")

    # Per-commit table (only executed cases)
    lines += ["", "## Per-Commit Results", ""]
    header = "| Commit | GT Range |"
    sep = "|--------|----------|"
    for alias in model_aliases:
        header += f" {alias} |"
        sep += "------|"
    lines += [header, sep]

    by_commit = {}
    for r in results:
        by_commit.setdefault(r["sha"], {})[r.get("model_alias", "?")] = r

    for case in executed_cases:
        sha = case["sha"]
        row = f"| {sha[:7]} | {case['gt_low']}-{case['gt_high']}h |"
        cr = by_commit.get(sha, {})
        for alias in model_aliases:
            r = cr.get(alias)
            if not r or "error" in r:
                row += " ERR |"
            else:
                status = "**OK**" if r["in_range"] else ("~2x" if r["within_2x"] else "MISS")
                row += f" {r['estimate_mid']:.0f}h ({status}) |"
        lines.append(row)

    # Reasoning details
    lines += ["", "## Model Reasoning (per commit)", ""]
    for case in executed_cases:
        sha = case["sha"]
        lines.append(f"### {sha[:7]} — {case['label']}")
        lines.append(f"GT: {case['gt_low']}-{case['gt_high']}h")
        lines.append("")
        cr = by_commit.get(sha, {})
        for alias in model_aliases:
            r = cr.get(alias)
            if not r or "error" in r:
                lines.append(f"**{alias}:** ERROR")
            else:
                lines.append(f"**{alias}:** {r['estimate_low']:.0f}-{r['estimate_mid']:.0f}-"
                             f"{r['estimate_high']:.0f}h (conf={r['confidence']}, APE={r['ape']:.0f}%)")
                lines.append(f"> {r['reasoning']}")
            lines.append("")

    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    return json_path, md_path


# ===== CLI =====

def parse_args():
    parser = argparse.ArgumentParser(
        description="FD v3 Holistic Estimation Experiment"
    )
    parser.add_argument(
        "--repo",
        required=True,
        help="Path to git repository to analyze",
    )
    parser.add_argument(
        "--models",
        nargs="+",
        choices=list(MODELS.keys()),
        default=list(MODELS.keys()),
        help="Models to evaluate (default: all)",
    )
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="Disable response caching",
    )
    parser.add_argument(
        "--commit",
        help="Run only this commit SHA instead of all GT cases",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Extract data and print prompts without calling LLM",
    )
    parser.add_argument(
        "--calibration",
        help="Path to JSON file with custom calibration overrides",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()

    if not os.path.isdir(args.repo):
        print(f"ERROR: repo not found at {args.repo}")
        sys.exit(1)

    # Load API key
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env")
        if os.path.exists(env_path):
            with open(env_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("OPENROUTER_API_KEY=") and not line.startswith("#"):
                        api_key = line.split("=", 1)[1].strip().strip('"').strip("'")
                        break
    if not api_key and not args.dry_run:
        print("ERROR: OPENROUTER_API_KEY not set")
        sys.exit(1)

    model_aliases = args.models  # already a list from nargs="+"

    # Load calibration overrides
    calibration = dict(CALIBRATION)
    if args.calibration:
        with open(args.calibration, "r", encoding="utf-8") as f:
            overrides = json.load(f)
        calibration.update(overrides)
        print(f"Calibration overrides loaded from {args.calibration}")

    results, executed_cases = run_experiment(
        args.repo, model_aliases, api_key,
        no_cache=args.no_cache, single_commit=args.commit, dry_run=args.dry_run,
        calibration=calibration,
    )

    if args.dry_run:
        print("Dry run complete — no API calls made.")
        sys.exit(0)

    json_path, md_path = generate_reports(results, model_aliases, executed_cases)

    print(f"\n{'='*70}")
    print(f"SUMMARY")
    print(f"{'='*70}")
    for alias in model_aliases:
        agg = compute_aggregate(results, alias)
        if agg:
            bias = f"+{agg['mean_signed_error']}" if agg['mean_signed_error'] >= 0 else f"{agg['mean_signed_error']}"
            print(f"  {alias:8s} MAPE={agg['mape']:5.1f}%  MdAPE={agg['mdape']:5.1f}%  "
                  f"InRange={agg['in_range']}/{agg['n']}  Within2x={agg['within_2x']}/{agg['n']}  "
                  f"Bias={bias}h  Over/Under={agg['n_over']}/{agg['n_under']}")

    print(f"\nJSON: {json_path}")
    print(f"MD:   {md_path}")
