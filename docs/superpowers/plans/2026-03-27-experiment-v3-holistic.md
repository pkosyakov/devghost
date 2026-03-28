# FD v3 Holistic Estimation Experiment Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an experiment script that tests the v3 rich-metadata holistic prompt across 5 LLM models on 10 GT commits, producing a comparison report with per-model accuracy metrics.

**Architecture:** Python script (`experiment_v3.py`) that reuses the production pipeline's preprocessing functions (`classify_file_regex`, `classify_file_tier`, `adaptive_filter`, `build_clusters`, `classify_move_commit`, `detect_bulk_refactoring`) to build the same metadata that production v3 will use. The script adds v3-specific features (entropy, effective churn, file size distribution) and the v3 prompt on top. Diffs are read for preprocessing/classification but NOT sent to the LLM — only the metadata block goes to the model. OpenRouter API call and caching are self-contained (not imported from `run_v16_pipeline.py` to avoid global state coupling).

**Tech Stack:** Python 3.10+, `requests` for OpenRouter API (`pip install requests`), git CLI for diff extraction, `math`/`statistics` for metrics.

---

## File Structure

- **Create:** `packages/server/scripts/pipeline/experiment_v3.py` — the experiment script (~600 lines)
- **Create:** `packages/server/scripts/pipeline/results/` — output directory for reports (gitignored)
- **Modify:** `.gitignore` — add `packages/server/scripts/pipeline/results/`

No pipeline code is modified.

---

## Reference: Key Constants

**Models (OpenRouter IDs):**
```python
MODELS = {
    "opus":   "anthropic/claude-opus-4.6",
    "sonnet": "anthropic/claude-sonnet-4.6",
    "haiku":  "anthropic/claude-haiku-4.5",
    "qwen":   "qwen/qwen3-coder-plus",
    "gpt":    "openai/gpt-5.3-codex",
}
```

**GT Cases (10 commits from `docs/ground-truth-request.md`):**
```python
GT_CASES = [
    {"sha": "188c43e", "label": "Refactor/monorepo (#597) — 870 files",           "gt_low": 15, "gt_high": 30},
    {"sha": "1d02576", "label": "Feat/dialer v1 (#968) — 272 files",              "gt_low": 40, "gt_high": 60},
    {"sha": "0237e3a", "label": "Feat/workos auth (#751) — 388 files",             "gt_low": 30, "gt_high": 50},
    {"sha": "47252d6", "label": "Feat/magic campaigns (#842) — 391 files",         "gt_low": 40, "gt_high": 60},
    {"sha": "4ccdf71", "label": "Feat/leads lists (#1297) — 265 files",            "gt_low": 30, "gt_high": 50},
    {"sha": "16dc74e", "label": "Feat/pnpm vitest migration (#974) — 1036 files",  "gt_low": 8,  "gt_high": 16},
    {"sha": "9c2a0ed", "label": "Feat/web visitors (#1048) — 159 files",           "gt_low": 25, "gt_high": 40},
    {"sha": "b4bb3f0", "label": "Adhoc: leadsdb rework (#782) — 145 files",        "gt_low": 20, "gt_high": 35},
    {"sha": "18156d0", "label": "Temporal scheduler (#939) — 123 files",            "gt_low": 20, "gt_high": 35},
    {"sha": "c8269d0", "label": "UI library setup — 107 files",                    "gt_low": 4,  "gt_high": 8},
]
```

**V3 Response Schema:**
```python
V3_SCHEMA = {
    "type": "object",
    "properties": {
        "low":        {"type": "number", "description": "Low estimate in hours"},
        "mid":        {"type": "number", "description": "Best estimate in hours"},
        "high":       {"type": "number", "description": "High estimate in hours"},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "reasoning":  {"type": "string", "description": "2-3 sentences: change type, effective size, complexity"}
    },
    "required": ["low", "mid", "high", "confidence", "reasoning"]
}
```

**Calibration config (externalized, not hardcoded in prompt):**
```python
CALIBRATION = {
    "lines_per_hour": "50-100",
    "generated_hours": "0",
    "rename_hours_per_50": "0.5",
    "test_effort_ratio": "50-75%",
    "config_hours_each": "0.1-0.5",
    "docs_hours_per_100_lines": "0.3",
    "bulk_refactor_hours": "2-4",
}
```

---

## Task 1: Script skeleton — imports, CLI, constants

**Files:**
- Create: `packages/server/scripts/pipeline/experiment_v3.py`

- [ ] **Step 1: Create script with imports and pipeline function imports**

```python
#!/usr/bin/env python3
"""
FD v3 Holistic Estimation Experiment.

Tests the v3 rich-metadata prompt across multiple LLM models
on 10 ground truth commits. Reuses production pipeline preprocessing
(classify_file_regex, adaptive_filter, build_clusters, etc.) to ensure
the experiment validates the same metadata that production v3 will use.

Usage:
  cd packages/server/scripts/pipeline
  python experiment_v3.py --repo <path-to-artisan-private>
  python experiment_v3.py --repo ... --models opus,sonnet
  python experiment_v3.py --repo ... --no-cache
  python experiment_v3.py --repo ... --commit 16dc74e
  python experiment_v3.py --repo ... --dry-run
"""
import argparse
import hashlib
import json
import math
import os
import random
import re
import statistics
import subprocess
import sys
import time
from datetime import datetime

# Import production pipeline functions for preprocessing
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

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

import requests

# --- Constants (MODELS, GT_CASES, V3_SCHEMA, CALIBRATION as defined above) ---
# ... (paste from Reference section)

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/chat/completions"
CACHE_DIR = os.path.join(SCRIPT_DIR, "..", ".cache", "experiment_v3")
RESULTS_DIR = os.path.join(SCRIPT_DIR, "results")


def parse_args():
    parser = argparse.ArgumentParser(description="FD v3 holistic estimation experiment")
    parser.add_argument("--repo", required=True, help="Path to artisan-private clone")
    parser.add_argument("--models", default=",".join(MODELS.keys()),
                        help=f"Comma-separated model aliases: {','.join(MODELS.keys())}")
    parser.add_argument("--no-cache", action="store_true", help="Disable LLM response cache")
    parser.add_argument("--commit", default=None, help="Run only one commit SHA (for debugging)")
    parser.add_argument("--dry-run", action="store_true", help="Print prompts without API calls")
    parser.add_argument("--calibration", default=None,
                        help="Path to JSON file overriding CALIBRATION anchors")
    return parser.parse_args()
```

- [ ] **Step 2: Verify imports work**

Run: `cd /c/Projects/devghost/packages/server/scripts/pipeline && python -c "from experiment_v3 import *; print('OK')"`
Expected: prints OK (pipeline imports resolve).

- [ ] **Step 3: Commit**

```bash
git add packages/server/scripts/pipeline/experiment_v3.py
git commit -m "feat(experiment): v3 holistic experiment skeleton with pipeline imports"
```

---

## Task 2: Git metadata extraction using real pipeline preprocessing

Extract full diff, split by file, apply production `classify_file_regex` for tags, `classify_file_tier` + `adaptive_filter` for tier classification, `build_clusters` for structure, `classify_move_commit` and `detect_bulk_refactoring` for pattern signals.

**Files:**
- Modify: `packages/server/scripts/pipeline/experiment_v3.py`

- [ ] **Step 1: Add git helpers**

```python
def git_cmd(repo, *args):
    """Run git command and return stdout."""
    result = subprocess.run(
        ["git"] + list(args),
        cwd=repo, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout


def extract_commit_data(repo, sha):
    """Extract full commit data using production pipeline preprocessing.

    Reads the diff (for classification only — NOT sent to LLM),
    applies classify_file_regex, adaptive_filter, build_clusters,
    classify_move_commit, detect_bulk_refactoring.

    Returns dict with all pipeline-derived metadata.
    """
    message = git_cmd(repo, "log", "--format=%s", "-1", sha).strip()

    # Get parent for diff
    parents = git_cmd(repo, "log", "--format=%P", "-1", sha).strip().split()
    parent = parents[0] if parents else None
    if not parent:
        raise RuntimeError(f"No parent for {sha}")

    # Full diff (needed for classification, NOT sent to LLM)
    diff = git_cmd(repo, "diff", f"{parent}..{sha}")

    # Numstat for aggregate counts
    raw_numstat = git_cmd(repo, "diff", "--numstat", f"{parent}..{sha}")
    la_total, ld_total, fc = 0, 0, 0
    for line in raw_numstat.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) >= 3:
            a = int(parts[0]) if parts[0] != "-" else 0
            d = int(parts[1]) if parts[1] != "-" else 0
            la_total += a
            ld_total += d
            fc += 1

    # --- Production pipeline preprocessing ---
    # Step 1: Split diff, regex classify (same as run_fd_hybrid lines 1406-1414)
    file_diffs = split_diff_by_file(diff)
    file_info = []
    for filename, fdiff in file_diffs:
        fa, fd_stat = parse_file_stat(fdiff)
        tags = classify_file_regex(filename, fdiff, fa, fd_stat)
        file_info.append({
            "filename": filename, "diff": fdiff,
            "added": fa, "deleted": fd_stat, "tags": tags,
        })

    # Step 2: Pattern detection (same as run_fd_hybrid lines 1416-1417)
    move_info = classify_move_commit(message, file_info)
    bulk_info = detect_bulk_refactoring(file_info)

    # Step 3: Adaptive filter (same as run_fd_hybrid → _run_fd_v2 path)
    filter_result = adaptive_filter(file_info)

    # Step 4: Build clusters from LLM-required files
    clusters = build_clusters(filter_result["llm_files"])

    # Step 5: New file ratio
    new_files = [f for f in file_info if f["added"] > 0 and f["deleted"] == 0]
    new_file_ratio = len(new_files) / len(file_info) if file_info else 0

    return {
        "message": message,
        "fc": fc,
        "la": la_total,
        "ld": ld_total,
        "file_info": file_info,
        "filter_result": filter_result,
        "clusters": clusters,
        "move_info": move_info,
        "bulk_info": bulk_info,
        "new_file_ratio": new_file_ratio,
        "new_count": len(new_files),
    }
```

- [ ] **Step 2: Verify on GT commit**

Add to `if __name__` block:
```python
    data = extract_commit_data(args.repo, GT_CASES[0]["sha"])
    fs = data["filter_result"]["filter_stats"]
    print(f"188c43e: {data['fc']} files, skip={fs['skip']}, heur={fs['heuristic']}, llm={fs['llm']}")
    print(f"  Clusters: {len(data['clusters'])}")
    print(f"  Move: {data['move_info']}")
    print(f"  Bulk: {data['bulk_info'].get('is_bulk', False)}")
```

Run: `python experiment_v3.py --repo C:\Projects\_tmp_devghost_audit\artisan-private`
Expected: file counts match previous validation runs.

- [ ] **Step 3: Commit**

```bash
git add packages/server/scripts/pipeline/experiment_v3.py
git commit -m "feat(experiment): extract commit data using production pipeline preprocessing"
```

---

## Task 3: V3-specific metadata computation (entropy, effective churn, file sizes)

Features from v3 design doc sections 3.1-3.2 that don't exist in the current pipeline.

**Files:**
- Modify: `packages/server/scripts/pipeline/experiment_v3.py`

- [ ] **Step 1: Add v3 metadata computation function**

```python
EXT_TO_LANG = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
    ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".rb": "Ruby",
    ".cs": "C#", ".cpp": "C++", ".c": "C", ".swift": "Swift", ".kt": "Kotlin",
}


def compute_v3_metadata(commit_data):
    """Compute v3-specific features on top of pipeline preprocessing results.

    These are the new P0 features from design doc section 3.2:
    - Entropy of change distribution
    - Effective churn (substantive files only)
    - File size distribution (p50, p90, max)
    - Module boundary count
    - Language detection
    """
    file_info = commit_data["file_info"]
    filter_result = commit_data["filter_result"]
    llm_files = filter_result["llm_files"]
    fc = commit_data["fc"]

    # --- Entropy of change distribution ---
    total_changed = sum(f["added"] + f["deleted"] for f in file_info)
    entropy = 0.0
    max_entropy = math.log2(fc) if fc > 1 else 1.0
    if total_changed > 0 and fc > 1:
        for f in file_info:
            p = (f["added"] + f["deleted"]) / total_changed
            if p > 0:
                entropy -= p * math.log2(p)

    # Entropy interpretation
    if fc <= 1:
        entropy_interp = "single file"
    elif entropy / max_entropy > 0.85:
        entropy_interp = "highly uniform — likely systematic refactor or bulk edit"
    elif entropy / max_entropy > 0.5:
        entropy_interp = "moderately spread — multi-area feature work"
    else:
        entropy_interp = "concentrated — targeted changes in few files"

    # --- Effective churn (substantive/LLM files only) ---
    effective_la = sum(f["added"] for f in llm_files)
    effective_ld = sum(f["deleted"] for f in llm_files)
    effective_fc = len(llm_files)

    # --- File size distribution (lines added, substantive only) ---
    sub_sizes = sorted([f["added"] for f in llm_files]) if llm_files else [0]
    p50 = sub_sizes[len(sub_sizes) // 2]
    p90 = sub_sizes[int(len(sub_sizes) * 0.9)]
    max_file_name, max_file_size = "", 0
    if llm_files:
        biggest = max(llm_files, key=lambda f: f["added"])
        max_file_name = os.path.basename(biggest["filename"])
        max_file_size = biggest["added"]

    # --- Module boundaries (all files, not just substantive — measures architectural breadth) ---
    modules = set()
    for f in file_info:
        parts = f["filename"].replace("\\", "/").split("/")
        if len(parts) > 1:
            modules.add(parts[0])
        else:
            modules.add("(root)")

    # --- Extension distribution (substantive) ---
    ext_counts = {}
    for f in llm_files:
        ext = os.path.splitext(f["filename"])[1] or "(no ext)"
        ext_counts[ext] = ext_counts.get(ext, 0) + 1
    ext_sorted = sorted(ext_counts.items(), key=lambda x: -x[1])[:5]

    # --- Language detection ---
    lang_counts = {}
    for f in file_info:
        ext = os.path.splitext(f["filename"])[1].lower()
        lang = EXT_TO_LANG.get(ext)
        if lang:
            lang_counts[lang] = lang_counts.get(lang, 0) + f.get("added", 0)
    language = max(lang_counts, key=lang_counts.get) if lang_counts else "mixed"

    return {
        "entropy": entropy,
        "max_entropy": max_entropy,
        "entropy_interp": entropy_interp,
        "effective_fc": effective_fc,
        "effective_la": effective_la,
        "effective_ld": effective_ld,
        "p50": p50,
        "p90": p90,
        "max_file_name": max_file_name,
        "max_file_size": max_file_size,
        "module_count": len(modules),
        "modules": sorted(modules)[:10],
        "ext_distribution": ext_sorted,
        "language": language,
    }
```

- [ ] **Step 2: Verify**

Run on 16dc74e (vitest migration) and c8269d0 (UI scaffold). Check entropy values make sense.

- [ ] **Step 3: Commit**

```bash
git add packages/server/scripts/pipeline/experiment_v3.py
git commit -m "feat(experiment): add v3-specific metadata (entropy, effective churn, file sizes)"
```

---

## Task 4: V3 prompt formatting with calibration config

Build system prompt (with externalized calibration anchors) and structured user prompt per design doc sections 4.1-4.2. Uses pipeline-derived data (clusters, move_info, bulk_info, filter_stats) and v3 metadata.

**Files:**
- Modify: `packages/server/scripts/pipeline/experiment_v3.py`

- [ ] **Step 1: Add calibration config and system prompt builder**

```python
# Calibration anchors — externalized per design doc section 4.3
# These WILL be revised after first 10-20 GT validation runs.
CALIBRATION = {
    "lines_per_hour": "50-100",
    "generated_hours": "0",
    "rename_hours_per_50": "0.5",
    "test_effort_ratio": "50-75%",
    "config_hours_each": "0.1-0.5",
    "docs_hours_per_100_lines": "0.3",
    "bulk_refactor_hours": "2-4",
}


def build_system_prompt(cal=None):
    """Build v3 system prompt with calibration anchors from config."""
    c = cal or CALIBRATION
    return f"""You are an expert software effort estimator. Estimate how many hours a \
MID-LEVEL developer (3-5 years experience, NO AI copilot) would need to \
implement the described changes.

CALIBRATION (starting heuristics — subject to revision):
- 1 hour = approximately {c['lines_per_hour']} lines of non-trivial logic for a mid-level dev
- Generated files (lock, .d.ts, protobuf, snapshots) = {c['generated_hours']} hours
- Renamed/moved files = {c['rename_hours_per_50']}h per 50 files of restructuring
- Test code = approximately {c['test_effort_ratio']} effort of corresponding logic code
- Config files (tsconfig, eslint, docker) = {c['config_hours_each']}h each
- Documentation = {c['docs_hours_per_100_lines']}h per 100 lines
- Bulk same-edit refactors (import rename across 200 files) = {c['bulk_refactor_hours']}h total

ANTI-OVERESTIMATION:
- Large file counts DO NOT mean large effort. Most big commits are \
dominated by generated code, migrations, config, or bulk renames.
- A 500-file commit is often 8-20h, not 100h+
- New files that are boilerplate/scaffold are cheap (0.1h each)
- Only genuinely novel algorithm/business logic code is expensive

RESPONSE FORMAT (JSON):
{{"low": N, "mid": N, "high": N, "confidence": "low|medium|high", "reasoning": "..."}}

Where:
- low/mid/high = estimated hours range
- confidence = your certainty level
- reasoning = 2-3 sentences: (1) change type classification, (2) effective code size, (3) complexity adjustment"""
```

- [ ] **Step 2: Add user prompt builder**

```python
def build_v3_prompt(commit_data, v3_meta):
    """Build structured v3 user prompt from pipeline data + v3 metadata.

    Uses:
    - commit_data: from extract_commit_data() — pipeline-derived
    - v3_meta: from compute_v3_metadata() — v3-specific features
    """
    msg = commit_data["message"]
    fc = commit_data["fc"]
    la = commit_data["la"]
    ld = commit_data["ld"]
    fs = commit_data["filter_result"]["filter_stats"]
    heur_total = commit_data["filter_result"]["heuristic_total"]
    clusters = commit_data["clusters"]
    move = commit_data["move_info"]
    bulk = commit_data["bulk_info"]
    m = v3_meta

    # Extension distribution line
    ext_line = ", ".join(f"{ext}: {cnt}" for ext, cnt in m["ext_distribution"])

    # Module list
    module_list = ", ".join(m["modules"][:8])
    if m["module_count"] > 8:
        module_list += f" (+{m['module_count'] - 8} more)"

    # Pattern flags (from pipeline preprocessing)
    flags = []
    if move.get("is_move"):
        n_pairs = len(move.get("pairs", []))
        flags.append(f"MOVE/RENAME: {move.get('move_type', '?')} — {n_pairs} file pairs, "
                     f"overlap={move.get('avg_overlap', 0):.0%}, ratio={move.get('move_ratio', 0):.0%}")
    if bulk.get("is_bulk"):
        flags.append(f"BULK_REFACTOR: {bulk.get('bulk_ratio', 0):.0%} repetition — {bulk.get('pattern_description', '?')}")
    # Scaffold signals (from pipeline's bulk scaffold detector logic)
    _SCAFFOLD_KEYWORDS = re.compile(
        r'\b(monorepo|mono[- ]?repo|scaffold|boilerplate|template|seed|'
        r'vendor|copy\s+(from|into|over)|bootstrap|initial\s+(commit|import|setup))\b', re.IGNORECASE)
    _SCAFFOLD_SETUP = re.compile(
        r'\b(wip|init)\b.*\b(setup|library|scaffold|skeleton)\b', re.IGNORECASE)
    nfr = commit_data["new_file_ratio"]
    is_bulk_new = nfr > 0.8 and la > 10000 and fc >= 50
    has_scaffold_signal = bool(_SCAFFOLD_KEYWORDS.search(msg) or _SCAFFOLD_SETUP.search(msg))
    is_near_total_add = nfr > 0.95

    if is_bulk_new and has_scaffold_signal:
        flags.append(f"SCAFFOLD: keyword match in commit message + {nfr:.0%} new files")
    elif is_bulk_new and is_near_total_add:
        flags.append(f"SCAFFOLD: {nfr:.0%} new files (>95%), likely copy/scaffold")
    elif is_bulk_new:
        flags.append(f"BULK_NEW: {nfr:.0%} new files, high volume, but no scaffold keyword — could be real feature")
    elif nfr > 0.9:
        flags.append(f"NEAR_TOTAL_ADD: {nfr:.0%} files are new")

    if fs["skip"] / fc > 0.3 if fc > 0 else False:
        flags.append(f"HIGH_GENERATED: {fs['skip']}/{fc} files auto-generated/trivial")

    flags_text = "\n".join(f"- {f}" for f in flags) if flags else "- (none detected)"

    # Structure: clusters from build_clusters() (design doc section 4.3)
    structure_lines = []
    for c in clusters:
        n_files = len(c["files"])
        structure_lines.append(f"  {c['name']}: {n_files} files, +{c['total_added']} lines")
    structure_text = "\n".join(structure_lines) if structure_lines else "  (flat structure)"

    prompt = f"""COMMIT: {msg}
LANGUAGE: {m['language']}

CHANGE VOLUME:
- Raw: {fc} files, +{la}/-{ld} lines
- After filtering generated/trivial: {m['effective_fc']} substantive files, +{m['effective_la']}/-{m['effective_ld']}
- Generated/auto (0h): {fs['skip']} files
- Trivial (config/test/docs): {fs['heuristic']} files (~{heur_total:.1f}h by formula)

FILE TYPE BREAKDOWN:
- Logic (substantive): {m['effective_fc']} files, +{m['effective_la']} lines
- Tests: {sum(1 for f in commit_data['file_info'] if 'test' in f.get('tags', []))} files
- Config/infra: {sum(1 for f in commit_data['file_info'] if 'config' in f.get('tags', []))} files
- Documentation: {sum(1 for f in commit_data['file_info'] if 'docs' in f.get('tags', []))} files
- New files (from scratch): {commit_data['new_count']} ({commit_data['new_file_ratio']:.0%} of total)

DISTRIBUTION:
- Entropy: {m['entropy']:.2f} (max={m['max_entropy']:.2f}; {m['entropy_interp']})
- Largest file: {m['max_file_name']} (+{m['max_file_size']} lines)
- File sizes: p50={m['p50']} lines, p90={m['p90']} lines
- Modules touched: {m['module_count']} ({module_list})

EXTENSIONS: {ext_line}

PATTERN FLAGS:
{flags_text}

STRUCTURE (substantive files grouped by cluster):
{structure_text}

Estimate total hours for implementing this entire commit."""

    return prompt
```

- [ ] **Step 3: Verify prompt for 16dc74e (vitest migration)**

Add to main: print `build_v3_prompt(data, v3_meta)` for 16dc74e and check:
- PATTERN FLAGS contains BULK_REFACTOR or HIGH_GENERATED
- STRUCTURE shows real cluster names from `build_clusters()`
- Heuristic total matches what pipeline computes

- [ ] **Step 4: Commit**

```bash
git add packages/server/scripts/pipeline/experiment_v3.py
git commit -m "feat(experiment): add v3 prompt with externalized calibration and pipeline signals"
```

---

## Task 5: OpenRouter API call with caching

Self-contained API call (not imported from pipeline to avoid global state). Cache keyed on model + system + prompt + schema.

**Files:**
- Modify: `packages/server/scripts/pipeline/experiment_v3.py`

- [ ] **Step 1: Add cache and API call functions**

```python
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
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/scripts/pipeline/experiment_v3.py
git commit -m "feat(experiment): add OpenRouter API call with caching and retry"
```

---

## Task 6: Experiment runner — main loop

Iterate GT cases x models, collect results. Uses pipeline preprocessing + v3 metadata + v3 prompt.

**Files:**
- Modify: `packages/server/scripts/pipeline/experiment_v3.py`

- [ ] **Step 1: Add experiment runner**

```python
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
        print(f"    Files: {commit_data['fc']}, Substantive: {v3_meta['effective_fc']}, "
              f"Skip: {fs['skip']}, Heuristic: {fs['heuristic']} ({heur_total:.1f}h)")
        print(f"    Entropy: {v3_meta['entropy']:.2f}/{v3_meta['max_entropy']:.2f} "
              f"({v3_meta['entropy_interp']})")
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
```

- [ ] **Step 2: Dry-run test on 1 commit**

Run: `python experiment_v3.py --repo ... --commit c8269d0 --dry-run`
Expected: prints full metadata, prompt, no API calls.

- [ ] **Step 3: Live test on 1 commit, 1 model (cheapest)**

Run: `python experiment_v3.py --repo ... --models haiku --commit c8269d0`
Expected: one API call, estimate printed.

- [ ] **Step 4: Commit**

```bash
git add packages/server/scripts/pipeline/experiment_v3.py
git commit -m "feat(experiment): add main experiment loop with dry-run support"
```

---

## Task 7: Report generation — JSON + Markdown

Aggregate metrics per model, heuristic baseline, bias direction. Reports iterate only over executed cases (fixes `--commit` subset bug).

**Files:**
- Modify: `packages/server/scripts/pipeline/experiment_v3.py`

- [ ] **Step 1: Add aggregate and report functions**

```python
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
    """Generate JSON + Markdown reports. Only includes executed_cases (not full GT_CASES)."""
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
```

- [ ] **Step 2: Wire main block**

```python
if __name__ == "__main__":
    args = parse_args()

    if not os.path.isdir(args.repo):
        print(f"ERROR: repo not found at {args.repo}")
        sys.exit(1)

    # Load API key
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        env_path = os.path.join(SCRIPT_DIR, "..", "..", ".env")
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

    model_aliases = [m.strip() for m in args.models.split(",")]
    for alias in model_aliases:
        if alias not in MODELS:
            print(f"ERROR: unknown model '{alias}'. Available: {', '.join(MODELS.keys())}")
            sys.exit(1)

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
```

- [ ] **Step 3: Add `results/` to .gitignore**

Add to root `.gitignore` (line 18 area, after existing `.cache/` entry):
```
packages/server/scripts/pipeline/results/
```

- [ ] **Step 4: Commit**

```bash
git add packages/server/scripts/pipeline/experiment_v3.py .gitignore
git commit -m "feat(experiment): add report generation with heuristic baseline and bias metrics"
```

---

## Task 8: End-to-end verification

- [ ] **Step 1: Dry-run all 10 commits**

Run: `python experiment_v3.py --repo ... --dry-run`
Verify: all 10 prompts print, move/bulk signals appear where expected, cluster names match production pipeline output.

- [ ] **Step 2: Test 1 commit, 1 model**

Run: `python experiment_v3.py --repo ... --models haiku --commit c8269d0`
Verify: API call succeeds, reports generated, `--commit` subset report contains only 1 row.

- [ ] **Step 3: Test 2 models, all 10 commits**

Run: `python experiment_v3.py --repo ... --models haiku,qwen`
Verify: both models produce results, summary has 2 lines + heuristic baseline.

- [ ] **Step 4: Cache test**

Run same command again. Verify all results show `[cached]`, run completes <2s.

---

## Task 9: Full experiment run

- [ ] **Step 1: Run all 5 models x 10 commits**

Run: `python experiment_v3.py --repo C:\Projects\_tmp_devghost_audit\artisan-private`

50 API calls. Expected cost: $1-3 total.

- [ ] **Step 2: Review results**

Read `.md` report. Analyze:
- Which model has lowest MAPE?
- Which model has most in-range estimates?
- Bias direction — systematic overestimation or underestimation?
- Any models that fail on specific commit types?

- [ ] **Step 3: Share results with user**

Print summary table and full report path.
