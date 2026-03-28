# FD v2: Large Commit Estimation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-file FD summation with cluster-based + holistic estimation for commits with 50+ files, targeting MAPE < 50% on ground-truth data.

**Architecture:** Adaptive filter classifies files into SKIP/HEURISTIC/LLM tiers. LLM files go through Branch B (cluster-based, current model) or Branch A (single-call, powerful model). An independent holistic estimate is averaged with the branch estimate. Heuristic totals are added after averaging.

**Tech Stack:** Python 3.11, OpenRouter API, existing `file_decomposition.py` + `run_v16_pipeline.py` pipeline.

**Spec:** `docs/superpowers/specs/2026-03-25-fd-v2-large-commit-estimation-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/server/scripts/pipeline/file_decomposition.py` | Add adaptive filter, clustering, v2 orchestrator, holistic/branch estimators. Insert v2 gate in `run_fd_hybrid()`. |
| Modify | `packages/server/scripts/pipeline/run_v16_pipeline.py` | Add `call_openrouter_large()` for Branch A model. Read new env vars. |
| Modify | `packages/modal/worker.py` | Add FD v2 env vars to `setup_llm_env()`. |
| Create | `packages/server/scripts/pipeline/test_fd_v2_unit.py` | Unit tests for adaptive filter, clustering, combine logic. No git repo needed. |
| Modify | `packages/server/scripts/pipeline/test_fd_regression.py` | Add v2 routing smoke tests (real commits, mock LLM). |

All new functions go into `file_decomposition.py` in a new `# ===== FD V2 =====` section after the existing `_estimate_mechanical()` function (~line 1635). This keeps all FD logic in one module, following the existing pattern.

---

## Conventions

- **LLM call signature**: All LLM-dependent functions accept `call_ollama_fn(system, prompt, schema=None, max_tokens=1024) -> dict | str`. This is the existing contract in `file_decomposition.py`.
- **Env vars**: Read at module import time via `os.environ.get()`. New v2 vars follow existing naming (`FD_V2_*`, `FD_LARGE_*`).
- **Testing**: Unit tests in `test_fd_v2_unit.py` use no external dependencies (no git repo, no API). Routing tests in `test_fd_regression.py` need `artisan-private` clone.
- **Cache**: v2 LLM calls go through the same `call_ollama_fn` wrapper, which in `run_v16_pipeline.py` routes through `call_llm_timed()` → `_read_llm_cache`/`_write_llm_cache`. No cache changes needed.
- **Token estimation**: `_CHARS_PER_TOKEN = 2.0` (code denser than prose). Already defined in `run_v16_pipeline.py:126`.

---

## Task 1: Adaptive Filter — Pure Classification

**Files:**
- Create: `packages/server/scripts/pipeline/test_fd_v2_unit.py`
- Modify: `packages/server/scripts/pipeline/file_decomposition.py` (append after `_estimate_mechanical`)

This task implements the file classification tier function — given a file's tags and stats, return SKIP / HEURISTIC / LLM_REQUIRED with an optional heuristic estimate.

- [ ] **Step 1: Write failing tests for file tier classification**

Create `test_fd_v2_unit.py` with tests for `classify_file_tier()`:

```python
#!/usr/bin/env python3
"""Unit tests for FD v2 functions. No git repo or API needed."""
import os
import sys
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from file_decomposition import classify_file_tier


class TestClassifyFileTier(unittest.TestCase):
    """Test adaptive filter tier classification."""

    def test_generated_file_is_skip(self):
        tier, est = classify_file_tier("package-lock.json", ["generated"], 5000, 0, "")
        self.assertEqual(tier, "SKIP")
        self.assertEqual(est, 0.0)

    def test_snap_file_is_skip(self):
        tier, est = classify_file_tier("Button.test.tsx.snap", ["generated"], 200, 0, "")
        self.assertEqual(tier, "SKIP")
        self.assertEqual(est, 0.0)

    def test_svg_is_skip(self):
        tier, est = classify_file_tier("icon.svg", [], 100, 0, "")
        self.assertEqual(tier, "SKIP")
        self.assertEqual(est, 0.0)

    def test_binary_is_skip(self):
        tier, est = classify_file_tier("logo.png", [], 0, 0, "")
        self.assertEqual(tier, "SKIP")
        self.assertEqual(est, 0.0)

    def test_locale_json_is_skip(self):
        # Note: classify_file_regex() does not tag messages/ as locale.
        # Task 1 also adds r'messages/' to LOCALE_PATTERNS in file_decomposition.py
        tier, est = classify_file_tier("messages/en.json", ["locale"], 300, 0, "")
        self.assertEqual(tier, "SKIP")
        self.assertEqual(est, 0.0)

    def test_docs_is_heuristic(self):
        tier, est = classify_file_tier("README.md", ["docs"], 200, 0, "")
        self.assertEqual(tier, "HEURISTIC")
        self.assertAlmostEqual(est, min(0.5, 200 * 0.003))

    def test_config_is_heuristic(self):
        tier, est = classify_file_tier("tsconfig.json", ["config"], 50, 0, "")
        self.assertEqual(tier, "HEURISTIC")
        self.assertAlmostEqual(est, 50 * 0.01)

    def test_test_file_is_heuristic(self):
        tier, est = classify_file_tier("auth.test.ts", ["test"], 400, 0, "")
        self.assertEqual(tier, "HEURISTIC")
        self.assertAlmostEqual(est, 400 * 0.002)

    def test_ddl_migration_is_heuristic(self):
        diff = "+CREATE TABLE users (\n+  id SERIAL PRIMARY KEY\n+);\n+ALTER TABLE orders ADD COLUMN status TEXT;"
        # Detected by path pattern (migrations/) not by tag
        tier, est = classify_file_tier("migrations/001_create_users.sql", [], 4, 0, diff)
        self.assertEqual(tier, "HEURISTIC")
        # 2 DDL operations (CREATE + ALTER) * 0.1h = 0.2h
        self.assertAlmostEqual(est, 0.2)

    def test_data_migration_is_llm(self):
        diff = "+INSERT INTO users SELECT * FROM old_users;\n+UPDATE orders SET status = 'active';"
        tier, est = classify_file_tier("migrations/002_migrate_data.sql", [], 2, 0, diff)
        self.assertEqual(tier, "LLM_REQUIRED")
        self.assertEqual(est, 0.0)

    def test_code_file_is_llm(self):
        tier, est = classify_file_tier("auth.service.ts", [], 500, 10, "")
        self.assertEqual(tier, "LLM_REQUIRED")
        self.assertEqual(est, 0.0)

    def test_untagged_code_is_llm(self):
        tier, est = classify_file_tier("utils.py", [], 100, 50, "")
        self.assertEqual(tier, "LLM_REQUIRED")
        self.assertEqual(est, 0.0)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py -v`
Expected: ImportError — `classify_file_tier` does not exist yet.

- [ ] **Step 3: Implement classify_file_tier()**

First, add `messages/` to `LOCALE_PATTERNS` (line ~231 in `file_decomposition.py`) so the existing `classify_file_regex()` correctly tags locale files:

```python
LOCALE_PATTERNS = [r'locale[s]?/', r'i18n/', r'l10n/', r'lang/', r'translations?/', r'messages/']
```

Then add to `file_decomposition.py` after `_estimate_mechanical()` (~line 1635), in a new section:

```python
# ===== FD V2: ADAPTIVE FILTER + CLUSTERING =====

# --- V2 env config (read lazily to support Modal warm containers) ---
def _fd_v2_config():
    """Read FD v2 config from env on each call (not cached at import time)."""
    return {
        "branch": os.environ.get("FD_V2_BRANCH", "B").upper(),
        "min_files": int(os.environ.get("FD_V2_MIN_FILES", "50")),
        "holistic": os.environ.get("FD_V2_HOLISTIC", "true").lower() in ("1", "true", "yes"),
    }

_SKIP_EXTENSIONS = {'.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp',
                    '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.wav'}
_DDL_RE = re.compile(r'\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|VIEW|TYPE|SEQUENCE|FUNCTION|TRIGGER)\b', re.IGNORECASE)
_DML_RE = re.compile(r'\b(SELECT|INSERT|UPDATE|DELETE)\b', re.IGNORECASE)


def classify_file_tier(filename, tags, lines_added, lines_deleted, file_diff=""):
    """Classify a file into SKIP / HEURISTIC / LLM_REQUIRED tier for FD v2.

    Args:
        filename: File path from diff
        tags: Tags from classify_file_regex()
        lines_added: Lines added in diff
        lines_deleted: Lines deleted in diff
        file_diff: Raw diff text (needed for migration DDL/DML detection)

    Returns:
        (tier, heuristic_estimate): tier is "SKIP"|"HEURISTIC"|"LLM_REQUIRED",
        heuristic_estimate is float (0.0 for SKIP and LLM_REQUIRED)
    """
    ext = os.path.splitext(filename)[1].lower()

    # --- SKIP tier: zero effort ---
    if "generated" in tags or "locale" in tags:
        return "SKIP", 0.0
    if ext in _SKIP_EXTENSIONS or (lines_added == 0 and lines_deleted == 0):
        return "SKIP", 0.0

    # --- HEURISTIC tier: formula-based ---
    if "docs" in tags:
        return "HEURISTIC", min(0.5, lines_added * 0.003)
    if "config" in tags:
        return "HEURISTIC", lines_added * 0.01
    if "test" in tags or "test_data" in tags:
        return "HEURISTIC", lines_added * 0.002

    # Migration: DDL-only → heuristic, data migration → LLM
    # Note: classify_file_regex() does not produce "migration" tag — detect by path
    is_migration = "migration" in tags or bool(re.search(
        r'migrations?/', filename, re.IGNORECASE
    )) or filename.endswith('.sql')
    if is_migration:
        if file_diff:
            added_lines = [l for l in file_diff.split('\n') if l.startswith('+') and not l.startswith('+++')]
            added_text = '\n'.join(added_lines)
            has_dml = bool(_DML_RE.search(added_text))
            if has_dml:
                return "LLM_REQUIRED", 0.0
            ddl_count = len(_DDL_RE.findall(added_text))
            if ddl_count > 0:
                return "HEURISTIC", ddl_count * 0.1
        return "HEURISTIC", 0.1  # migration file, no diff available

    # --- LLM_REQUIRED: everything else ---
    return "LLM_REQUIRED", 0.0
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py::TestClassifyFileTier -v`
Expected: All 12 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/scripts/pipeline/test_fd_v2_unit.py packages/server/scripts/pipeline/file_decomposition.py
git commit -m "feat(pipeline): add FD v2 adaptive filter tier classification"
```

---

## Task 2: Adaptive Filter — Full Filter Function

**Files:**
- Modify: `packages/server/scripts/pipeline/file_decomposition.py`
- Modify: `packages/server/scripts/pipeline/test_fd_v2_unit.py`

Build the full `adaptive_filter()` that takes the `file_info` list (as produced by Step 1 of `run_fd_hybrid()`) and returns a `FilterResult` dict.

- [ ] **Step 1: Write failing tests for adaptive_filter()**

Add to `test_fd_v2_unit.py`:

```python
from file_decomposition import adaptive_filter


class TestAdaptiveFilter(unittest.TestCase):
    """Test full adaptive filter pipeline."""

    def _make_file(self, name, tags, added=100, deleted=0, diff=""):
        return {"filename": name, "tags": tags, "added": added, "deleted": deleted, "diff": diff}

    def test_all_generated_returns_only_heuristic_total(self):
        files = [
            self._make_file("package-lock.json", ["generated"], added=5000),
            self._make_file("yarn.lock", ["generated"], added=3000),
        ]
        result = adaptive_filter(files)
        self.assertEqual(len(result["skip_files"]), 2)
        self.assertEqual(len(result["llm_files"]), 0)
        self.assertAlmostEqual(result["heuristic_total"], 0.0)

    def test_mixed_files_split_correctly(self):
        files = [
            self._make_file("bun.lock", ["generated"], added=10000),
            self._make_file("auth.test.ts", ["test"], added=400),
            self._make_file("README.md", ["docs"], added=200),
            self._make_file("auth.service.ts", [], added=500),
            self._make_file("db.service.ts", [], added=300),
        ]
        result = adaptive_filter(files)
        self.assertEqual(len(result["skip_files"]), 1)        # generated
        self.assertEqual(len(result["heuristic_files"]), 2)    # test + docs
        self.assertEqual(len(result["llm_files"]), 2)          # 2 code files
        # heuristic_total = test(400*0.002) + docs(min(0.5, 200*0.003))
        expected = 400 * 0.002 + min(0.5, 200 * 0.003)
        self.assertAlmostEqual(result["heuristic_total"], expected)

    def test_llm_diff_assembled(self):
        files = [
            self._make_file("a.ts", [], added=10, diff="diff --git a/a.ts\n+code"),
            self._make_file("b.ts", [], added=20, diff="diff --git a/b.ts\n+more code"),
        ]
        result = adaptive_filter(files)
        self.assertIn("a.ts", result["llm_diff"])
        self.assertIn("b.ts", result["llm_diff"])

    def test_token_estimate_uses_chars_per_token_2(self):
        diff_text = "x" * 10000
        files = [self._make_file("big.ts", [], added=500, diff=diff_text)]
        result = adaptive_filter(files)
        self.assertEqual(result["llm_token_estimate"], 10000 / 2.0)

    def test_filter_stats(self):
        files = [
            self._make_file("lock.json", ["generated"]),
            self._make_file("a.test.ts", ["test"]),
            self._make_file("code.ts", []),
        ]
        result = adaptive_filter(files)
        self.assertEqual(result["filter_stats"]["skip"], 1)
        self.assertEqual(result["filter_stats"]["heuristic"], 1)
        self.assertEqual(result["filter_stats"]["llm"], 1)
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py::TestAdaptiveFilter -v`
Expected: ImportError — `adaptive_filter` not found.

- [ ] **Step 3: Implement adaptive_filter()**

Add to `file_decomposition.py` after `classify_file_tier()`:

```python
def adaptive_filter(file_info):
    """Apply adaptive filter to classify files into SKIP/HEURISTIC/LLM tiers.

    Args:
        file_info: List of dicts from run_fd_hybrid Step 1, each with keys:
            filename, diff, added, deleted, tags

    Returns:
        dict with keys: skip_files, heuristic_files, heuristic_total,
                        llm_files, llm_diff, llm_token_estimate, filter_stats
    """
    skip_files = []
    heuristic_files = []
    llm_files = []
    heuristic_total = 0.0

    for f in file_info:
        tier, est = classify_file_tier(
            f["filename"], f.get("tags", []),
            f.get("added", 0), f.get("deleted", 0),
            f.get("diff", ""),
        )
        if tier == "SKIP":
            skip_files.append(f)
        elif tier == "HEURISTIC":
            heuristic_files.append({**f, "heuristic_estimate": est})
            heuristic_total += est
        else:
            llm_files.append(f)

    # Assemble diff for LLM files only
    llm_diff = "\n".join(f.get("diff", "") for f in llm_files)
    llm_token_estimate = len(llm_diff) / 2.0  # _CHARS_PER_TOKEN = 2.0

    return {
        "skip_files": skip_files,
        "heuristic_files": heuristic_files,
        "heuristic_total": round(heuristic_total, 2),
        "llm_files": llm_files,
        "llm_diff": llm_diff,
        "llm_token_estimate": llm_token_estimate,
        "filter_stats": {
            "skip": len(skip_files),
            "heuristic": len(heuristic_files),
            "llm": len(llm_files),
        },
    }
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py::TestAdaptiveFilter -v`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/scripts/pipeline/file_decomposition.py packages/server/scripts/pipeline/test_fd_v2_unit.py
git commit -m "feat(pipeline): add FD v2 adaptive_filter() function"
```

---

## Task 3: Clustering — build_clusters()

**Files:**
- Modify: `packages/server/scripts/pipeline/file_decomposition.py`
- Modify: `packages/server/scripts/pipeline/test_fd_v2_unit.py`

Build the clustering function that groups LLM files by directory + suffix pattern.

- [ ] **Step 1: Write failing tests for build_clusters()**

Add to `test_fd_v2_unit.py`:

```python
from file_decomposition import build_clusters


class TestBuildClusters(unittest.TestCase):
    """Test directory+suffix clustering."""

    def _make_file(self, name, added=100):
        return {"filename": name, "added": added, "deleted": 0, "diff": f"diff {name}", "tags": []}

    def test_single_directory_one_cluster(self):
        files = [
            self._make_file("src/components/Button.tsx"),
            self._make_file("src/components/Input.tsx"),
            self._make_file("src/components/Modal.tsx"),
        ]
        clusters = build_clusters(files)
        self.assertEqual(len(clusters), 1)
        self.assertEqual(len(clusters[0]["files"]), 3)

    def test_different_directories_separate_clusters(self):
        files = [
            self._make_file("src/components/Button.tsx"),
            self._make_file("src/lib/services/auth.ts"),
            self._make_file("src/lib/services/credit.ts"),
        ]
        clusters = build_clusters(files)
        self.assertEqual(len(clusters), 2)

    def test_suffix_split_within_directory(self):
        files = [
            self._make_file("src/dialer/call-task.service.ts"),
            self._make_file("src/dialer/compliance.service.ts"),
            self._make_file("src/dialer/call-task.repository.ts"),
            self._make_file("src/dialer/compliance.repository.ts"),
            self._make_file("src/dialer/DialerModal.tsx"),
            self._make_file("src/dialer/DialerSettings.tsx"),
        ]
        clusters = build_clusters(files)
        # Should produce subclusters: services, repositories, general
        self.assertGreaterEqual(len(clusters), 2)
        self.assertLessEqual(len(clusters), 4)

    def test_small_clusters_merged(self):
        files = [
            self._make_file("src/a/file1.ts"),
            self._make_file("src/a/file2.ts"),
            self._make_file("src/b/lonely.ts"),  # only 1 file — should merge
        ]
        clusters = build_clusters(files)
        # src/b has <3 files, should merge with nearest (src/a)
        total_files = sum(len(c["files"]) for c in clusters)
        self.assertEqual(total_files, 3)

    def test_max_15_clusters(self):
        # 20 different directories with 3 files each = 20 initial clusters
        files = []
        for i in range(20):
            for j in range(3):
                files.append(self._make_file(f"src/mod{i}/file{j}.ts"))
        clusters = build_clusters(files)
        self.assertLessEqual(len(clusters), 15)
        # All files preserved
        total_files = sum(len(c["files"]) for c in clusters)
        self.assertEqual(total_files, 60)

    def test_cluster_has_name_and_stats(self):
        files = [
            self._make_file("src/auth/login.ts", added=200),
            self._make_file("src/auth/register.ts", added=150),
        ]
        clusters = build_clusters(files)
        c = clusters[0]
        self.assertIn("name", c)
        self.assertIn("files", c)
        self.assertIn("total_added", c)
        self.assertEqual(c["total_added"], 350)

    def test_empty_input(self):
        clusters = build_clusters([])
        self.assertEqual(clusters, [])
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py::TestBuildClusters -v`
Expected: ImportError — `build_clusters` not found.

- [ ] **Step 3: Implement build_clusters()**

Add to `file_decomposition.py` after `adaptive_filter()`:

```python
_SUFFIX_ROLES = {
    '.service': 'services', '.repository': 'repositories', '.controller': 'controllers',
    '.resolver': 'resolvers', '.guard': 'guards', '.middleware': 'middleware',
    '.module': 'modules', '.dto': 'dtos', '.entity': 'entities', '.model': 'models',
    '.hook': 'hooks', '.util': 'utils', '.helper': 'helpers',
}

_MAX_CLUSTERS = 15
_MIN_CLUSTER_SIZE = 3
_MAX_CLUSTER_SIZE = 30


def _get_dir_key(filename):
    """Extract directory grouping key from filename.

    src/components/Button.tsx         → "components"
    src/lib/services/auth.ts          → "lib/services"
    apps/web/pages/index.tsx          → "apps/web/pages"
    file.ts (no directory)            → ""
    """
    parts = filename.replace('\\', '/').split('/')
    if len(parts) <= 1:
        return ""
    # Skip first segment if it's a common root (src, app, apps, lib, packages)
    start = 1 if parts[0] in ('src', 'app', 'apps', 'lib', 'packages') else 0
    dir_parts = parts[start:-1]  # exclude filename
    return '/'.join(dir_parts) if dir_parts else ""


def _get_suffix_role(filename):
    """Detect dotted suffix pattern like .service.ts, .repository.ts.

    Only works for dotted naming convention common in TypeScript/NestJS monorepos.
    PascalCase names (AuthService.ts) are NOT detected — grouped by directory instead.
    """
    lower = filename.lower()
    for suffix, role in _SUFFIX_ROLES.items():
        if suffix in lower:
            return role
    return None


def build_clusters(llm_files):
    """Group files into semantic clusters by directory + suffix pattern.

    Algorithm:
    1. Group by directory depth-1 within package
    2. Within each dir-group: split by suffix role (.service, .repository, etc.)
    3. Small clusters (<3 files) merge with nearest neighbor by directory path
    4. If >15 clusters: force-merge smallest until count <= 15

    Returns: list of cluster dicts, each with keys:
        name, files, total_added, total_deleted
    """
    if not llm_files:
        return []

    # Step 1+2: Group by dir_key, then by suffix_role
    dir_groups = defaultdict(lambda: defaultdict(list))
    for f in llm_files:
        dk = _get_dir_key(f["filename"])
        sr = _get_suffix_role(f["filename"])
        subkey = sr if sr else "_general"
        dir_groups[dk][subkey].append(f)

    # Flatten to cluster list
    clusters = []
    for dk, subgroups in dir_groups.items():
        for subkey, files in subgroups.items():
            name = f"{dk}/{subkey}" if dk and subkey != "_general" else dk or subkey
            clusters.append({
                "name": name.strip("/"),
                "files": files,
                "total_added": sum(f.get("added", 0) for f in files),
                "total_deleted": sum(f.get("deleted", 0) for f in files),
                "_dir_key": dk,
            })

    # Step 3: Merge small clusters (<3 files) with nearest by dir_key
    changed = True
    while changed:
        changed = False
        small = [c for c in clusters if len(c["files"]) < _MIN_CLUSTER_SIZE]
        if not small:
            break
        for s in small:
            # Find nearest neighbor (same parent dir prefix, not exceeding max size)
            best = None
            best_overlap = -1
            s_parts = s["_dir_key"].split('/')
            for c in clusters:
                if c is s:
                    continue
                if len(c["files"]) + len(s["files"]) > _MAX_CLUSTER_SIZE:
                    continue
                c_parts = c["_dir_key"].split('/')
                overlap = sum(1 for a, b in zip(s_parts, c_parts) if a == b)
                if overlap > best_overlap:
                    best_overlap = overlap
                    best = c
            if best is not None:
                best["files"].extend(s["files"])
                best["total_added"] += s["total_added"]
                best["total_deleted"] += s["total_deleted"]
                best["name"] = best["name"]  # keep target name
                clusters.remove(s)
                changed = True
                break  # restart loop after mutation

    # Step 4: Force-merge smallest until <= MAX_CLUSTERS
    while len(clusters) > _MAX_CLUSTERS:
        clusters.sort(key=lambda c: len(c["files"]))
        smallest = clusters.pop(0)
        # Merge into next smallest
        target = clusters[0]
        target["files"].extend(smallest["files"])
        target["total_added"] += smallest["total_added"]
        target["total_deleted"] += smallest["total_deleted"]

    # Clean up internal keys
    for c in clusters:
        c.pop("_dir_key", None)

    return clusters
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py::TestBuildClusters -v`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/scripts/pipeline/file_decomposition.py packages/server/scripts/pipeline/test_fd_v2_unit.py
git commit -m "feat(pipeline): add FD v2 build_clusters() directory+suffix clustering"
```

---

## Task 4: Combine Logic

**Files:**
- Modify: `packages/server/scripts/pipeline/file_decomposition.py`
- Modify: `packages/server/scripts/pipeline/test_fd_v2_unit.py`

Pure math function — no LLM, no IO.

- [ ] **Step 1: Write failing tests for combine_estimates()**

Add to `test_fd_v2_unit.py`:

```python
from file_decomposition import combine_estimates


class TestCombineEstimates(unittest.TestCase):
    """Test branch+holistic combining logic."""

    def test_normal_divergence_averages(self):
        # branch=40, holistic=50, heuristic=5 → (40+50)/2 + 5 = 50
        result = combine_estimates(40.0, 50.0, 5.0)
        self.assertAlmostEqual(result, 50.0)

    def test_strong_divergence_takes_min(self):
        # branch=20, holistic=50, divergence=2.5 → min(20,50) + 5 = 25
        result = combine_estimates(20.0, 50.0, 5.0)
        self.assertAlmostEqual(result, 25.0)

    def test_exactly_2x_divergence_averages(self):
        # branch=20, holistic=40, ratio=2.0 → average: (20+40)/2 + 3 = 33
        result = combine_estimates(20.0, 40.0, 3.0)
        self.assertAlmostEqual(result, 33.0)

    def test_zero_holistic_extreme_divergence(self):
        # holistic=0 → divergence extreme → min(30, 0) + 2 = 2
        # Note: orchestrator guards against this by checking holistic > 0
        result = combine_estimates(30.0, 0.0, 2.0)
        self.assertAlmostEqual(result, 2.0)

    def test_zero_branch_extreme_divergence(self):
        # branch=0 → divergence extreme → min(0, 40) + 5 = 5
        result = combine_estimates(0.0, 40.0, 5.0)
        self.assertAlmostEqual(result, 5.0)

    def test_heuristic_only(self):
        # Both zero → just heuristic
        result = combine_estimates(0.0, 0.0, 10.0)
        self.assertAlmostEqual(result, 10.0)

    def test_symmetric(self):
        # Same estimate from both → average = same
        result = combine_estimates(30.0, 30.0, 0.0)
        self.assertAlmostEqual(result, 30.0)
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py::TestCombineEstimates -v`
Expected: ImportError.

- [ ] **Step 3: Implement combine_estimates()**

Add to `file_decomposition.py` after `build_clusters()`:

```python
def combine_estimates(branch_est, holistic_est, heuristic_total):
    """Combine branch + holistic estimates with heuristic files.

    Normal divergence (<=2x): simple average.
    Strong divergence (>2x): conservative min.
    Heuristic total always added after combining (not averaged).

    Returns: final estimate (float)
    """
    min_est = min(branch_est, holistic_est)
    max_est = max(branch_est, holistic_est)
    divergence = max_est / max(min_est, 0.1)

    if divergence > 2.0:
        combined = min_est
    else:
        combined = (branch_est + holistic_est) / 2.0

    return combined + heuristic_total
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py::TestCombineEstimates -v`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/scripts/pipeline/file_decomposition.py packages/server/scripts/pipeline/test_fd_v2_unit.py
git commit -m "feat(pipeline): add FD v2 combine_estimates() logic"
```

---

## Task 5: Branch B — Cluster-based LLM Estimation

**Files:**
- Modify: `packages/server/scripts/pipeline/file_decomposition.py`
- Modify: `packages/server/scripts/pipeline/test_fd_v2_unit.py`

Per-cluster LLM prompt + aggregation. Uses the existing `call_ollama_fn` signature.

- [ ] **Step 1: Write failing tests**

Add to `test_fd_v2_unit.py`:

```python
from file_decomposition import estimate_branch_b


class TestBranchB(unittest.TestCase):
    """Test cluster-based estimation (Branch B)."""

    def _make_cluster(self, name, files, total_added=500):
        return {"name": name, "files": files, "total_added": total_added, "total_deleted": 0}

    def _make_file(self, name, added=100, diff="diff content"):
        return {"filename": name, "added": added, "deleted": 0, "diff": diff, "tags": []}

    def test_sums_cluster_estimates(self):
        """Mock LLM returns 10h per cluster → 2 clusters = 20h."""
        clusters = [
            self._make_cluster("auth", [self._make_file("auth.ts")]),
            self._make_cluster("billing", [self._make_file("billing.ts")]),
        ]
        call_count = [0]
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            call_count[0] += 1
            return {"estimated_hours": 10.0, "reasoning": "mock"}
        result = estimate_branch_b(clusters, "feat: add auth+billing", "typescript", 100, mock_llm)
        self.assertAlmostEqual(result, 20.0)
        self.assertEqual(call_count[0], 2)

    def test_llm_failure_uses_fallback(self):
        """If LLM returns None for a cluster, use heuristic fallback."""
        clusters = [
            self._make_cluster("auth", [self._make_file("auth.ts", added=300)], total_added=300),
        ]
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            return None  # LLM failed
        result = estimate_branch_b(clusters, "feat: auth", "typescript", 100, mock_llm)
        self.assertGreater(result, 0)  # should use heuristic fallback

    def test_prompt_includes_commit_message(self):
        """Verify prompt contains commit context."""
        captured = []
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            captured.append(prompt)
            return {"estimated_hours": 5.0, "reasoning": "mock"}
        clusters = [self._make_cluster("auth", [self._make_file("auth.ts")])]
        estimate_branch_b(clusters, "feat: add OAuth flow", "typescript", 100, mock_llm)
        self.assertIn("OAuth flow", captured[0])
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py::TestBranchB -v`
Expected: ImportError.

- [ ] **Step 3: Implement estimate_branch_b()**

Add to `file_decomposition.py`:

```python
_CLUSTER_SYSTEM_PROMPT = """Estimate development effort for this CODE CLUSTER \
(part of a larger commit with {total_fc} files).
Cluster: {cluster_name} ({n_files} files, {total_lines} lines).
Estimate hours for THIS CLUSTER ONLY, as a mid-level developer without AI assistance.
Include: writing code, manual testing, code review fixes.
Exclude: meetings, planning, waiting for review."""

_CLUSTER_TOKEN_LIMIT = 40000  # chars (~20K tokens at 2.0 chars/tok)


def _build_cluster_prompt(cluster, message, total_fc):
    """Build estimation prompt for a single cluster."""
    files = cluster["files"]
    file_list = "\n".join(
        f"  {f['filename']} (+{f.get('added', 0)}/-{f.get('deleted', 0)})"
        for f in files
    )

    # Include diffs if they fit
    total_diff_chars = sum(len(f.get("diff", "")) for f in files)
    if total_diff_chars <= _CLUSTER_TOKEN_LIMIT:
        diffs = "\n".join(f.get("diff", "") for f in files)
        diff_section = f"\n--- DIFFS ---\n{diffs}\n---"
    else:
        # Top 3 files by lines_added + metadata for rest
        sorted_files = sorted(files, key=lambda f: f.get("added", 0), reverse=True)
        top3 = sorted_files[:3]
        diffs = "\n".join(f.get("diff", "") for f in top3)
        rest_count = len(files) - 3
        rest_lines = sum(f.get("added", 0) for f in sorted_files[3:])
        diff_section = (
            f"\n--- DIFFS (top 3 of {len(files)} files) ---\n{diffs}\n---\n"
            f"[{rest_count} more files, +{rest_lines} lines — estimate from names and stats above]"
        )

    return (
        f"Commit: {message}\n\n"
        f"Files in this cluster:\n{file_list}\n"
        f"{diff_section}\n\n"
        f"Estimate hours for this cluster."
    )


def estimate_branch_b(clusters, message, language, total_fc, call_ollama_fn):
    """Branch B: estimate effort per-cluster, sum results.

    Args:
        clusters: list from build_clusters()
        message: commit message
        language: primary language
        total_fc: total file count in commit
        call_ollama_fn: LLM call function

    Returns: float — sum of per-cluster estimates
    """
    call_fn = _robust_wrap(call_ollama_fn)
    total = 0.0

    for cluster in clusters:
        system = _CLUSTER_SYSTEM_PROMPT.format(
            total_fc=total_fc,
            cluster_name=cluster["name"],
            n_files=len(cluster["files"]),
            total_lines=cluster["total_added"],
        )
        prompt = _build_cluster_prompt(cluster, message, total_fc)

        result = call_fn(system, prompt, schema=EVAL_SCHEMA, max_tokens=512)

        if isinstance(result, dict) and "estimated_hours" in result:
            est = float(result["estimated_hours"])
        else:
            # Fallback: rough heuristic per cluster
            est = max(1.0, cluster["total_added"] * 0.003)
            print(f" [cluster-fallback:{cluster['name']}={est:.1f}h]", end='', flush=True)

        total += est

    return total
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py::TestBranchB -v`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/scripts/pipeline/file_decomposition.py packages/server/scripts/pipeline/test_fd_v2_unit.py
git commit -m "feat(pipeline): add FD v2 Branch B cluster-based estimation"
```

---

## Task 6: Holistic Estimation

**Files:**
- Modify: `packages/server/scripts/pipeline/file_decomposition.py`
- Modify: `packages/server/scripts/pipeline/test_fd_v2_unit.py`

Independent metadata-only LLM call. Does NOT see the branch estimate (anti-anchoring).

- [ ] **Step 1: Write failing tests**

Add to `test_fd_v2_unit.py`:

```python
from file_decomposition import estimate_holistic


class TestHolistic(unittest.TestCase):
    """Test independent holistic estimation."""

    def test_returns_estimate(self):
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            return {"estimated_hours": 35.0, "reasoning": "mock holistic"}
        clusters = [{"name": "auth", "files": [{"filename": "auth.ts", "added": 500}], "total_added": 500}]
        result = estimate_holistic("feat: auth", "typescript", clusters,
                                   {"skip": 5, "heuristic": 3, "llm": 10},
                                   100, 5000, 200, 0.6, mock_llm)
        self.assertAlmostEqual(result, 35.0)

    def test_prompt_has_no_estimate_anchor(self):
        captured = []
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            captured.append({"system": system, "prompt": prompt})
            return {"estimated_hours": 25.0, "reasoning": "mock"}
        clusters = [{"name": "auth", "files": [{"filename": "auth.ts", "added": 500}], "total_added": 500}]
        estimate_holistic("feat: auth", "typescript", clusters,
                          {"skip": 0, "heuristic": 0, "llm": 5},
                          5, 1000, 0, 0.8, mock_llm)
        full_text = captured[0]["system"] + captured[0]["prompt"]
        # Must NOT contain any numeric hour estimate
        self.assertNotIn("branch", full_text.lower())
        self.assertNotIn("cluster estimate", full_text.lower())

    def test_prompt_includes_cluster_structure(self):
        captured = []
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            captured.append(prompt)
            return {"estimated_hours": 10.0, "reasoning": "mock"}
        clusters = [
            {"name": "auth", "files": [{"filename": "auth.ts", "added": 500}], "total_added": 500},
            {"name": "billing", "files": [{"filename": "billing.ts", "added": 300}], "total_added": 300},
        ]
        estimate_holistic("feat: add auth", "typescript", clusters,
                          {"skip": 0, "heuristic": 0, "llm": 2}, 2, 800, 0, 0.5, mock_llm)
        self.assertIn("auth", captured[0])
        self.assertIn("billing", captured[0])

    def test_llm_failure_returns_zero(self):
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            return None
        result = estimate_holistic("feat: x", "ts", [], {"skip": 0, "heuristic": 0, "llm": 0},
                                   0, 0, 0, 0, mock_llm)
        self.assertEqual(result, 0.0)
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py::TestHolistic -v`
Expected: ImportError.

- [ ] **Step 3: Implement estimate_holistic()**

Add to `file_decomposition.py`:

```python
_HOLISTIC_SYSTEM = """Estimate total development effort for this commit \
based on its structure and metadata. You do NOT see the full diff — \
estimate from the commit profile only.
Estimate hours for a mid-level developer without AI assistance.
Include: writing code, manual testing, code review fixes.
Exclude: meetings, planning, waiting for review.

IMPORTANT: Consider the NATURE of the work:
- Scaffold/copy commits have low effort despite high line count
- Generated/lock files require zero development effort
- Tests and configs are faster to write than core logic
- Large feature commits benefit from shared context between related files"""


def estimate_holistic(message, language, clusters, filter_stats,
                      fc, la, ld, new_file_ratio, call_ollama_fn,
                      heuristic_total=0.0):
    """Independent holistic estimate from metadata + cluster structure.

    Does NOT see branch estimate — prevents anchoring bias.

    Returns: float (0.0 on failure)
    """
    call_fn = _robust_wrap(call_ollama_fn)

    cluster_lines = []
    for c in clusters:
        top3 = sorted(c["files"], key=lambda f: f.get("added", 0), reverse=True)[:3]
        top3_str = ", ".join(
            f"{os.path.basename(f['filename'])} (+{f.get('added', 0)})"
            for f in top3
        )
        cluster_lines.append(
            f"  {c['name']}: {len(c['files'])} files, {c['total_added']} lines — {top3_str}"
        )
    cluster_text = "\n".join(cluster_lines) if cluster_lines else "  (no clusters)"

    new_count = int(fc * new_file_ratio) if fc else 0
    prompt = (
        f"Commit: {message}\n"
        f"Language: {language}\n"
        f"Files changed: {fc}\n"
        f"Lines: +{la} / -{ld}\n"
        f"New files (add-only): {new_count} ({new_file_ratio:.0%})\n"
        f"Pre-filtered: {filter_stats.get('skip', 0)} auto-generated, "
        f"{filter_stats.get('heuristic', 0)} trivial ({heuristic_total:.1f}h)\n\n"
        f"Substantive files by cluster:\n{cluster_text}\n\n"
        f"Estimate total development hours for this entire commit."
    )

    result = call_fn(_HOLISTIC_SYSTEM, prompt, schema=EVAL_SCHEMA, max_tokens=512)

    if isinstance(result, dict) and "estimated_hours" in result:
        return float(result["estimated_hours"])
    return 0.0
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py::TestHolistic -v`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/scripts/pipeline/file_decomposition.py packages/server/scripts/pipeline/test_fd_v2_unit.py
git commit -m "feat(pipeline): add FD v2 independent holistic estimation"
```

---

## Task 7: Branch A — Single-call with Powerful Model

**Files:**
- Modify: `packages/server/scripts/pipeline/run_v16_pipeline.py` (new function + env vars)
- Modify: `packages/server/scripts/pipeline/file_decomposition.py` (Branch A entry point)
- Modify: `packages/server/scripts/pipeline/test_fd_v2_unit.py`

Branch A sends the full filtered diff to a powerful LLM (Claude Sonnet 4) if it fits within 30K tokens.

- [ ] **Step 1: Add large-model env vars and call_openrouter_large() to run_v16_pipeline.py**

After line 144 (`MAX_FD_HOURS = 80.0`), add:

```python
# --- FD v2: Large model for Branch A ---
FD_LARGE_LLM_PROVIDER = os.environ.get('FD_LARGE_LLM_PROVIDER', '').strip().lower()
FD_LARGE_LLM_MODEL = os.environ.get('FD_LARGE_LLM_MODEL', '').strip()
```

After the existing `call_openrouter()` function (~line 614), add:

```python
def call_openrouter_large(system, prompt, schema=None, max_tokens=1024):
    """Call the powerful LLM (Branch A) via OpenRouter.

    Uses FD_LARGE_LLM_MODEL instead of the default model.
    Does NOT mutate any global state — builds its own API request payload
    with the large model name. This is thread-safe and cache-correct
    (LLM cache key includes the model name via _llm_cache_dir()).

    Returns (parsed_result, meta_dict) — same as call_openrouter().
    Returns (None, meta) if FD_LARGE_LLM_MODEL is not configured.
    """
    if not FD_LARGE_LLM_MODEL:
        return None, {"error": "FD_LARGE_LLM_MODEL not configured"}

    # Build request directly instead of mutating OPENROUTER_MODEL global.
    # This avoids thread-safety issues and LLM cache key collisions.
    import requests as _req

    api_key = os.environ.get('OPENROUTER_API_KEY', '')
    if not api_key:
        return None, {"error": "OPENROUTER_API_KEY not set"}

    payload = {
        "model": FD_LARGE_LLM_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
        "seed": 42,
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

    connect_timeout = int(os.environ.get('OPENROUTER_CONNECT_TIMEOUT_SEC', '20'))
    read_timeout = int(os.environ.get('OPENROUTER_READ_TIMEOUT_SEC', '120'))

    import time as _time
    start = _time.time()
    try:
        resp = _req.post(
            "https://openrouter.ai/api/v1/chat/completions",
            json=payload, headers=headers,
            timeout=(connect_timeout, read_timeout),
        )
        elapsed_ms = (_time.time() - start) * 1000

        if resp.status_code != 200:
            return None, {"error": f"HTTP {resp.status_code}", "elapsed_ms": elapsed_ms}

        rdata = resp.json()
        if "error" in rdata:
            return None, {"error": str(rdata["error"])[:300], "elapsed_ms": elapsed_ms}

        usage = rdata.get("usage", {})
        content = rdata["choices"][0]["message"]["content"]

        # Strip <think>...</think> blocks (reasoning models)
        import re as _re
        text = content.strip()
        if "<think>" in text:
            text = _re.sub(r'<think>.*?</think>\s*', '', text, flags=_re.DOTALL).strip()

        parsed = json.loads(text)
        meta = {
            "model": FD_LARGE_LLM_MODEL,
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
            "total_duration_ms": elapsed_ms,
        }
        return parsed, meta

    except Exception as e:
        elapsed_ms = (_time.time() - start) * 1000
        return None, {"error": str(e)[:300], "elapsed_ms": elapsed_ms}
```

Also add `FD_LARGE_LLM_PROVIDER` and `FD_LARGE_LLM_MODEL` to `reload_config()` so Modal warm containers pick up updated values:

```python
# Inside reload_config(), after existing globals:
global FD_LARGE_LLM_PROVIDER, FD_LARGE_LLM_MODEL
FD_LARGE_LLM_PROVIDER = os.environ.get('FD_LARGE_LLM_PROVIDER', '').strip().lower()
FD_LARGE_LLM_MODEL = os.environ.get('FD_LARGE_LLM_MODEL', '').strip()
```

**Design note:** `call_openrouter_large()` builds its own HTTP request rather than mutating the shared `OPENROUTER_MODEL` global. This ensures (a) thread-safety (no race between standard and large model calls), (b) LLM cache correctness (`_llm_cache_dir()` uses `OPENROUTER_MODEL` to build cache paths — mutating it would mix cache entries between models), (c) no side effects if the call raises.

- [ ] **Step 2: Write failing tests for estimate_branch_a()**

Add to `test_fd_v2_unit.py`:

```python
from file_decomposition import estimate_branch_a


class TestBranchA(unittest.TestCase):
    """Test single-call estimation (Branch A)."""

    def test_returns_estimate_from_llm(self):
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            return {"estimated_hours": 45.0, "reasoning": "single-call estimate"}
        result = estimate_branch_a(
            "feat: dialer v1", "typescript",
            "diff content here" * 100,
            {"skip": 5, "heuristic": 3, "llm": 50},
            58, 5000, 200, mock_llm
        )
        self.assertAlmostEqual(result, 45.0)

    def test_prompt_mentions_prefiltered(self):
        captured = []
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            captured.append(prompt)
            return {"estimated_hours": 20.0, "reasoning": "mock"}
        estimate_branch_a(
            "feat: x", "ts", "diff", {"skip": 10, "heuristic": 5, "llm": 20},
            35, 3000, 100, mock_llm
        )
        self.assertIn("10", captured[0])  # skip count mentioned
        self.assertIn("5", captured[0])   # heuristic count mentioned

    def test_llm_failure_returns_zero(self):
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            return None
        result = estimate_branch_a("x", "ts", "diff", {"skip": 0, "heuristic": 0, "llm": 1},
                                   1, 100, 0, mock_llm)
        self.assertEqual(result, 0.0)
```

- [ ] **Step 3: Run tests — verify they fail**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py::TestBranchA -v`
Expected: ImportError.

- [ ] **Step 4: Implement estimate_branch_a()**

Add to `file_decomposition.py`:

```python
_BRANCH_A_SYSTEM = """You are a senior software engineer estimating development \
effort for a commit. You see the FULL diff of all substantive files \
(trivial files like configs, docs, generated code are pre-filtered \
and estimated separately).

Estimate total hours for a mid-level developer WITHOUT AI assistance.
Include: writing code, manual testing, code review fixes.
Exclude: meetings, planning, waiting for review.

IMPORTANT: Consider the NATURE of the work:
- Scaffold/copy commits have low effort despite high line count
- Generated/lock files require zero development effort (already filtered out)
- Large feature commits benefit from shared context — the developer builds understanding progressively
- Tests and configs are part of the work but faster than core logic"""

_BRANCH_A_TOKEN_LIMIT = 30000  # tokens — optimal zone, no context rot
_PROMPT_OVERHEAD_TOKENS = 2000  # system prompt + user prompt metadata + schema


def estimate_branch_a(message, language, llm_diff, filter_stats,
                      total_fc, la, ld, call_ollama_fn,
                      heuristic_total=0.0):
    """Branch A: single-call estimation with full filtered diff.

    Args:
        llm_diff: assembled diff of LLM-required files only
        filter_stats: dict with skip/heuristic/llm counts
        call_ollama_fn: LLM call function (should route to powerful model)
        heuristic_total: hours estimated for filtered files

    Returns: float (0.0 on failure)
    """
    call_fn = _robust_wrap(call_ollama_fn)

    llm_fc = filter_stats.get("llm", 0)
    skip_count = filter_stats.get("skip", 0)
    heur_count = filter_stats.get("heuristic", 0)

    prompt = (
        f"Commit: {message}\n"
        f"Language: {language}\n"
        f"Total files in commit: {total_fc} (showing {llm_fc} substantive files)\n"
        f"Pre-filtered: {skip_count} auto-generated (0h), {heur_count} trivial ({heuristic_total:.1f}h)\n\n"
        f"--- FULL DIFF OF SUBSTANTIVE FILES ---\n"
        f"{llm_diff}\n"
        f"---\n\n"
        f"Estimate development effort for the substantive code above."
    )

    result = call_fn(_BRANCH_A_SYSTEM, prompt, schema=EVAL_SCHEMA, max_tokens=1024)

    if isinstance(result, dict) and "estimated_hours" in result:
        return float(result["estimated_hours"])
    return 0.0
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py::TestBranchA -v`
Expected: All 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/scripts/pipeline/file_decomposition.py packages/server/scripts/pipeline/run_v16_pipeline.py packages/server/scripts/pipeline/test_fd_v2_unit.py
git commit -m "feat(pipeline): add FD v2 Branch A single-call estimation + large model support"
```

---

## Task 8: V2 Orchestrator + Gate in run_fd_hybrid()

**Files:**
- Modify: `packages/server/scripts/pipeline/file_decomposition.py`
- Modify: `packages/server/scripts/pipeline/test_fd_v2_unit.py`

Wire everything together: `_run_fd_v2()` orchestrator + gate in `run_fd_hybrid()`.

- [ ] **Step 1: Write failing test for v2 orchestrator**

Add to `test_fd_v2_unit.py`:

```python
from file_decomposition import _run_fd_v2


class TestFdV2Orchestrator(unittest.TestCase):
    """Test the full v2 pipeline orchestration."""

    def _make_file_info(self, name, tags, added=100, diff="diff content"):
        return {"filename": name, "diff": diff, "added": added, "deleted": 0, "tags": tags}

    def test_all_generated_returns_heuristic_only(self):
        file_info = [
            self._make_file_info("lock.json", ["generated"], added=5000),
            self._make_file_info("types.d.ts", ["generated"], added=1000),
        ]
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            self.fail("LLM should not be called for all-generated files")
        result = _run_fd_v2("diff", "feat: gen", "ts", 2, 6000, 0,
                            file_info, 1.0, mock_llm)
        self.assertEqual(result["method"], "FD_v2_heuristic_only")
        self.assertAlmostEqual(result["estimated_hours"], 0.0)

    def test_mixed_files_calls_llm_for_clusters(self):
        file_info = [
            self._make_file_info("lock.json", ["generated"], added=5000),
            self._make_file_info("auth.ts", [], added=500),
            self._make_file_info("billing.ts", [], added=300),
            self._make_file_info("auth.test.ts", ["test"], added=200),
        ]
        llm_calls = []
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            llm_calls.append(prompt[:50])
            return {"estimated_hours": 10.0, "reasoning": "mock"}
        result = _run_fd_v2("diff", "feat: auth+billing", "typescript", 4, 6000, 0,
                            file_info, 0.75, mock_llm)
        self.assertIn("FD_v2", result["method"])
        self.assertGreater(result["estimated_hours"], 0)
        self.assertIn("fd_details", result)
        self.assertIn("filter_stats", result["fd_details"])

    def test_return_format_compatible_with_v1(self):
        file_info = [self._make_file_info("code.ts", [], added=200)]
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            return {"estimated_hours": 15.0, "reasoning": "mock"}
        result = _run_fd_v2("diff", "feat: x", "ts", 1, 200, 0,
                            file_info, 0.5, mock_llm)
        # Must have all keys expected by run_commit()
        self.assertIn("estimated_hours", result)
        self.assertIn("raw_estimate", result)
        self.assertIn("method", result)
        self.assertIn("routed_to", result)
        self.assertIn("analysis", result)
        self.assertIn("rule_applied", result)
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py::TestFdV2Orchestrator -v`
Expected: ImportError.

- [ ] **Step 3: Implement _run_fd_v2()**

Add to `file_decomposition.py`:

```python
def _run_fd_v2(diff, message, language, fc, la, ld,
               file_info, new_file_ratio, call_ollama_fn):
    """FD v2 orchestrator: filter → branch → holistic → combine.

    Args:
        file_info: list of file dicts from run_fd_hybrid Step 1
        new_file_ratio: float from Step 1b
        call_ollama_fn: LLM call function (standard model)

    Returns: dict compatible with run_commit() expectations
    """
    # --- Step 2: Adaptive filter ---
    filt = adaptive_filter(file_info)
    heuristic_total = filt["heuristic_total"]
    llm_files = filt["llm_files"]
    filter_stats = filt["filter_stats"]

    print(f" [v2:skip={filter_stats['skip']},heur={filter_stats['heuristic']},llm={filter_stats['llm']}]",
          end='', flush=True)

    # Edge case: all files filtered
    if not llm_files:
        print(f" [v2:heuristic_only={heuristic_total:.1f}h]", end='', flush=True)
        return {
            'estimated_hours': heuristic_total,
            'raw_estimate': heuristic_total,
            'method': 'FD_v2_heuristic_only',
            'routed_to': 'v2_heuristic',
            'analysis': {
                'change_type': 'automated/trivial',
                'new_logic_percent': 0,
                'summary': f'All {fc} files filtered: {filter_stats["skip"]} skip, {filter_stats["heuristic"]} heuristic',
            },
            'rule_applied': None,
            'fd_details': {
                'branch': None,
                'branch_estimate': 0.0,
                'holistic_estimate': 0.0,
                'heuristic_total': heuristic_total,
                'filter_stats': filter_stats,
                'clusters': [],
            },
        }

    # --- Step 3.5: Build clusters (always, used by holistic prompt) ---
    clusters = build_clusters(llm_files)
    print(f" [v2:clusters={len(clusters)}]", end='', flush=True)

    # --- Step 3: Branch routing ---
    v2_cfg = _fd_v2_config()
    branch_name = v2_cfg["branch"]
    llm_token_estimate = filt["llm_token_estimate"] + _PROMPT_OVERHEAD_TOKENS
    branch_a_possible = (branch_name == "A" and llm_token_estimate <= _BRANCH_A_TOKEN_LIMIT)

    if branch_a_possible:
        print(f" [v2:branch-A,{llm_token_estimate:.0f}tok]", end='', flush=True)
        branch_est = estimate_branch_a(
            message, language, filt["llm_diff"], filter_stats,
            fc, la, ld, call_ollama_fn
        )
        branch_label = "A"
        # If Branch A fails, fall back to Branch B
        if branch_est <= 0:
            print(f" [v2:A-fail→B]", end='', flush=True)
            branch_est = estimate_branch_b(clusters, message, language, fc, call_ollama_fn)
            branch_label = "B_fallback"
    else:
        if branch_name == "A":
            print(f" [v2:A-overflow({llm_token_estimate:.0f}tok)→B]", end='', flush=True)
        else:
            print(f" [v2:branch-B]", end='', flush=True)
        branch_est = estimate_branch_b(clusters, message, language, fc, call_ollama_fn)
        branch_label = "B"

    # --- Step 4: Independent holistic estimate ---
    holistic_est = 0.0
    if v2_cfg["holistic"]:
        holistic_est = estimate_holistic(
            message, language, clusters, filter_stats,
            fc, la, ld, new_file_ratio, call_ollama_fn,
            heuristic_total=heuristic_total
        )
        print(f" [v2:holistic={holistic_est:.1f}h]", end='', flush=True)

    # --- Step 5: Combine ---
    if v2_cfg["holistic"] and holistic_est > 0 and branch_est > 0:
        final = combine_estimates(branch_est, holistic_est, heuristic_total)
        method_suffix = "holistic"
    else:
        final = branch_est + heuristic_total
        method_suffix = ""

    # Method name (must match spec: FD_v2_single_holistic, FD_v2_single_call, etc.)
    if branch_label.startswith("A"):
        method = "FD_v2_single_holistic" if method_suffix == "holistic" else "FD_v2_single_call"
    else:
        method = "FD_v2_cluster_holistic" if method_suffix == "holistic" else "FD_v2_cluster"

    routed_to = f"v2_{branch_label.lower()}"

    print(f" [v2:branch={branch_est:.1f}h,final={final:.1f}h]", end='', flush=True)

    cluster_info = [
        {"name": c["name"], "files": len(c["files"]), "total_added": c["total_added"]}
        for c in clusters
    ]

    return {
        'estimated_hours': final,
        'raw_estimate': branch_est,
        'method': method,
        'routed_to': routed_to,
        'analysis': {
            'change_type': 'feature' if new_file_ratio > 0.5 else 'refactor',
            'new_logic_percent': int(new_file_ratio * 100),
            'summary': f'FD v2 {branch_label}: {len(clusters)} clusters, '
                       f'{filter_stats["llm"]} LLM files, '
                       f'{filter_stats["skip"]+filter_stats["heuristic"]} filtered',
        },
        'rule_applied': None,
        'fd_details': {
            'branch': branch_label,
            'branch_estimate': branch_est,
            'holistic_estimate': holistic_est,
            'heuristic_total': heuristic_total,
            'filter_stats': filter_stats,
            'clusters': cluster_info,
        },
    }
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py::TestFdV2Orchestrator -v`
Expected: All 3 tests PASS.

- [ ] **Step 5: Insert v2 gate in run_fd_hybrid()**

In `run_fd_hybrid()`, after the scaffold detector return (line ~1484) and before Step 2 (metadata classify, line ~1486), insert the v2 gate:

```python
    # --- FD V2 GATE: route large commits to cluster-based estimation ---
    _v2_cfg = _fd_v2_config()
    if fc >= _v2_cfg["min_files"]:
        print(f" [→v2:{fc}files]", end='', flush=True)
        return _run_fd_v2(diff, message, language, fc, la, ld,
                          file_info, new_file_ratio, call_ollama_fn)

    # --- Step 2: Metadata-only v15 classification (1 LLM call, small prompt) ---
```

This goes between the scaffold detector `return` (line ~1484) and the existing `# --- Step 2:` comment (line ~1486).

- [ ] **Step 6: Update existing feature regression tests**

The v2 gate now intercepts commits with 50+ files BEFORE the classify step. Existing FEATURE_CASES in `test_fd_regression.py` expect `_ClassifyDone` to fire (which requires reaching classify). Fix: set `FD_V2_MIN_FILES=999999` in the feature test section to preserve v1 routing for those tests:

In `test_fd_regression.py`, before the feature test loop (`for case in FEATURE_CASES:`), add:

```python
    # Disable v2 for feature routing tests — they validate v1 classify routing
    os.environ["FD_V2_MIN_FILES"] = "999999"
```

And after the feature test loop, restore:

```python
    os.environ.pop("FD_V2_MIN_FILES", None)
```

- [ ] **Step 7: Run all unit tests**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py -v`
Expected: All 44 unit tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/server/scripts/pipeline/file_decomposition.py packages/server/scripts/pipeline/test_fd_v2_unit.py packages/server/scripts/pipeline/test_fd_regression.py
git commit -m "feat(pipeline): wire FD v2 orchestrator + gate in run_fd_hybrid()"
```

---

## Task 9: Modal Integration

**Files:**
- Modify: `packages/modal/worker.py`

Add new FD v2 env vars to `setup_llm_env()`. Since the server-side `llmConfigSnapshot` schema (Prisma `SystemSettings`) does not currently include `fdV2` fields, we read these from Modal environment variables (Modal Secrets) rather than from the config snapshot. This avoids requiring a Prisma schema migration and admin UI changes.

- [ ] **Step 1: Add v2 env vars to setup_llm_env()**

In `worker.py`, after line 1421 (`os.makedirs(PIPELINE_CACHE_DIR, exist_ok=True)`), add:

```python
    # FD v2 configuration — read from Modal env vars (not from llm_config snapshot,
    # because server-side SystemSettings schema doesn't include fdV2 fields yet).
    # Set these via Modal Secret 'devghost-llm' or Modal environment variables.
    # If not set, defaults apply: Branch B, 50 files, holistic enabled, no large model.
    for env_key, default in [
        ("FD_V2_BRANCH", "B"),
        ("FD_V2_MIN_FILES", "50"),
        ("FD_V2_HOLISTIC", "true"),
        ("FD_LARGE_LLM_PROVIDER", ""),
        ("FD_LARGE_LLM_MODEL", ""),
    ]:
        if env_key not in os.environ:
            os.environ[env_key] = default
```

- [ ] **Step 2: Verify no syntax errors**

Run: `cd packages/modal && python -c "import worker; print('OK')"`
Expected: `OK` (no import errors).

- [ ] **Step 3: Commit**

```bash
git add packages/modal/worker.py
git commit -m "feat(modal): add FD v2 env vars to setup_llm_env()"
```

---

## Task 10: Routing Smoke Tests (Real Commits)

**Files:**
- Modify: `packages/server/scripts/pipeline/test_fd_regression.py`

Extend existing regression tests to verify v2 routing on real commits with mock LLM.

- [ ] **Step 1: Add v2 routing test cases to test_fd_regression.py**

After existing `FORCE_COMPLEX_GUARD_CASES` (line ~174), add:

```python
# --- FD V2 test cases ---
# These commits have 50+ files and should enter the v2 path.
# Mock LLM is used to verify routing, not estimate accuracy.

V2_ROUTING_CASES = [
    {
        "sha": "188c43e",
        "label": "monorepo migration (870 files, scaffold → should still scaffold-exit before v2)",
        "expect_method": "FD_bulk_scaffold",
        "min_files": 50,
    },
    {
        "sha": "1d02576",
        "label": "Feat/dialer v1 (272 files, feature → should enter v2)",
        "expect_v2": True,
        "min_files": 50,
    },
    {
        "sha": "16dc74e",
        "label": "pnpm vitest migration (1036 files → should enter v2)",
        "expect_v2": True,
        "min_files": 50,
    },
    {
        "sha": "9c2a0ed",
        "label": "Web visitors rehaul (159 files → should enter v2)",
        "expect_v2": True,
        "min_files": 50,
    },
]
```

Add test runner section after existing test sections (before `# --- Summary ---`):

```python
    # --- V2 routing tests ---
    print("\n=== FD V2 ROUTING (50+ files → v2 path, mock LLM) ===\n")

    # Set FD_V2_MIN_FILES for tests
    original_min_files = os.environ.get("FD_V2_MIN_FILES", "")
    original_v2_holistic = os.environ.get("FD_V2_HOLISTIC", "")

    for case in V2_ROUTING_CASES:
        sha = case["sha"]
        os.environ["FD_V2_MIN_FILES"] = str(case.get("min_files", 50))
        os.environ["FD_V2_HOLISTIC"] = "true"  # test with holistic enabled

        try:
            diff, fc, la, ld = get_diff_and_stats(repo, sha)
            msg = get_message(repo, sha)
            mock_llm, calls = make_mock_llm(new_logic_pct=45)

            sys.stdout = open(os.devnull, "w", encoding="utf-8")
            try:
                result = run_fd_hybrid(diff, msg, "typescript", fc, la, ld, mock_llm)
            finally:
                sys.stdout.close()
                sys.stdout = original_stdout

            method = result.get("method", "")
            fd_details = result.get("fd_details")

            if case.get("expect_method"):
                # Scaffold commits should still be caught before v2
                ok = method == case["expect_method"]
                status = "PASS" if ok else "FAIL"
                print(f"  [{status}] {sha:.7s} {case['label']}")
                print(f"         method={method} (expected {case['expect_method']})")
            elif case.get("expect_v2"):
                ok = "v2" in method.lower()
                status = "PASS" if ok else "FAIL"
                details = []
                if fd_details:
                    fs = fd_details.get("filter_stats", {})
                    details.append(f"skip={fs.get('skip', '?')}")
                    details.append(f"heur={fs.get('heuristic', '?')}")
                    details.append(f"llm={fs.get('llm', '?')}")
                    details.append(f"clusters={len(fd_details.get('clusters', []))}")
                detail_str = ", ".join(details) if details else ""
                print(f"  [{status}] {sha:.7s} {case['label']}")
                print(f"         method={method}, fc={fc}, {detail_str}")
                if not ok:
                    print(f"         EXPECTED v2 method, got {method}")

            if ok:
                passed += 1
            else:
                failed += 1
                errors.append(f"V2 {sha}: method={method}")

        except Exception as e:
            sys.stdout = original_stdout
            print(f"  [FAIL] {sha:.7s} {case['label']}: {e}")
            failed += 1
            errors.append(f"V2 {sha}: exception {e}")

    # Restore env
    if original_min_files:
        os.environ["FD_V2_MIN_FILES"] = original_min_files
    else:
        os.environ.pop("FD_V2_MIN_FILES", None)
    if original_v2_holistic:
        os.environ["FD_V2_HOLISTIC"] = original_v2_holistic
    else:
        os.environ.pop("FD_V2_HOLISTIC", None)
```

- [ ] **Step 2: Run routing tests**

Run: `cd packages/server/scripts/pipeline && python test_fd_regression.py`
Expected: All original tests pass + v2 routing tests show:
- `188c43e` → `FD_bulk_scaffold` (scaffold detector fires before v2 gate)
- `1d02576` → `FD_v2_cluster_holistic` (enters v2)
- `16dc74e` → `FD_v2_cluster_holistic` (enters v2)
- `9c2a0ed` → `FD_v2_cluster_holistic` (enters v2)

- [ ] **Step 3: Fix any issues found during routing tests**

Common issues to watch for:
- Scaffold detector fires on commits that should go to v2 → adjust test expectations
- `_ClassifyDone` exception leaking from feature tests → ensure v2 path catches it
- `_robust_wrap` interfering with mock LLM → verify mock compatibility
- `estimate` calls on mock returning wrong format → adjust mock

- [ ] **Step 4: Commit**

```bash
git add packages/server/scripts/pipeline/test_fd_regression.py
git commit -m "test(pipeline): add FD v2 routing smoke tests"
```

---

## Task 11: Branch A Integration in run_v16_pipeline.py

**Files:**
- Modify: `packages/server/scripts/pipeline/run_v16_pipeline.py`

When Branch A is selected, `run_fd_hybrid()` currently calls `call_ollama_fn` which routes to the default model. For Branch A, we need to pass a wrapper that calls the powerful model instead.

- [ ] **Step 1: Modify run_commit() to provide large-model wrapper**

In `run_commit()`, after the `call_llm_fd` wrapper definition (line ~842), add:

```python
            # FD v2 Branch A: provide large-model wrapper if configured
            call_llm_fd_large = None
            if FD_LARGE_LLM_MODEL:
                def call_llm_fd_large(system, prompt, schema=None, max_tokens=1024):
                    parsed, meta = call_openrouter_large(system, prompt, schema, max_tokens)
                    fd_llm_calls.append({**meta, 'step': 'fd_v2_large'})
                    return parsed
```

- [ ] **Step 2: Pass large-model callable to run_fd_hybrid()**

Update the `run_fd_hybrid()` call in `run_commit()` to pass the large-model wrapper:

```python
            fd_result = run_fd_hybrid(diff, msg, lang, fc, la, ld, call_llm_fd,
                                      call_large_fn=call_llm_fd_large)
```

Update `run_fd_hybrid()` signature in `file_decomposition.py` to accept optional `call_large_fn`:

```python
def run_fd_hybrid(diff, message, language, fc, la, ld, call_ollama_fn, call_large_fn=None):
```

And pass it through to `_run_fd_v2()`:

```python
        return _run_fd_v2(diff, message, language, fc, la, ld,
                          file_info, new_file_ratio, call_ollama_fn,
                          call_large_fn=call_large_fn)
```

Update `_run_fd_v2()` signature:

```python
def _run_fd_v2(diff, message, language, fc, la, ld,
               file_info, new_file_ratio, call_ollama_fn, call_large_fn=None):
```

In Branch A routing inside `_run_fd_v2()`, use `call_large_fn` if available:

```python
    if branch_a_possible:
        branch_call = call_large_fn if call_large_fn else call_ollama_fn
        branch_est = estimate_branch_a(
            message, language, filt["llm_diff"], filter_stats,
            fc, la, ld, branch_call,
            heuristic_total=heuristic_total
        )
```

This is thread-safe and doesn't persist state between calls.

- [ ] **Step 3: Commit**

```bash
git add packages/server/scripts/pipeline/run_v16_pipeline.py packages/server/scripts/pipeline/file_decomposition.py
git commit -m "feat(pipeline): wire Branch A large model through run_commit()"
```

---

## Task 12: End-to-End Verification

**Files:**
- All modified files

Run full test suite + manual verification.

- [ ] **Step 1: Run all unit tests**

Run: `cd packages/server/scripts/pipeline && python -m pytest test_fd_v2_unit.py -v`
Expected: All ~44 tests PASS.

- [ ] **Step 2: Run regression + routing tests**

Run: `cd packages/server/scripts/pipeline && python test_fd_regression.py`
Expected: All tests PASS (6 original + 4 v2 routing).

- [ ] **Step 3: Verify v2 gate respects MIN_FILES threshold**

Run a targeted check: call `run_fd_hybrid()` with a commit that has fewer files than `FD_V2_MIN_FILES` and confirm it falls through to v1 classify (not v2). This validates that the gate condition works independently of test-level env overrides.

```python
# In python REPL or a quick script:
import os
os.environ["FD_V2_MIN_FILES"] = "999999"
# Re-import to pick up new threshold
import importlib, file_decomposition as fd
importlib.reload(fd)
# Verify the config reads the new value
cfg = fd._fd_v2_config()
assert cfg["min_files"] == 999999, f"Expected 999999, got {cfg['min_files']}"
print("v2 gate threshold correctly reads env override")
```
Expected: Assertion passes — confirms `_fd_v2_config()` respects the env var, so any commit with fewer than 999999 files will skip v2.

- [ ] **Step 4: Verify no import errors in production paths**

```bash
cd packages/server/scripts/pipeline && python -c "from file_decomposition import run_fd_hybrid; print('FD OK')"
cd packages/server/scripts/pipeline && python -c "from run_v16_pipeline import run_commit; print('Pipeline OK')"
cd packages/modal && python -c "import worker; print('Worker OK')"
```
Expected: All three print OK.

- [ ] **Step 5: Commit any fixes from verification**

```bash
git add -A
git commit -m "fix(pipeline): address issues from FD v2 end-to-end verification"
```

---

## Task 13: Real LLM Validation (OpenRouter)

**Files:**
- Modify: `packages/server/scripts/pipeline/test_model_comparison.py` (optional — extend to test v2 pipeline)

This task is run manually after all code is deployed. Uses real OpenRouter API calls on GT commits.

- [ ] **Step 1: Run v2 pipeline on scaffold commit (188c43e)**

The scaffold commit should be caught by scaffold detector BEFORE v2 gate (870 files, 95% new, "monorepo" keyword). Verify this still works.

```bash
cd packages/server/scripts/pipeline
FD_V2_MIN_FILES=50 FD_V2_BRANCH=B FD_V2_HOLISTIC=true \
OPENROUTER_API_KEY=<key> LLM_PROVIDER=openrouter \
OPENROUTER_MODEL=qwen/qwen3-coder-30b-a3b-instruct \
python -c "
from test_fd_regression import get_diff_and_stats, get_message
from file_decomposition import run_fd_hybrid
from run_v16_pipeline import call_openrouter
diff, fc, la, ld = get_diff_and_stats('C:/Projects/_tmp_devghost_audit/artisan-private', '188c43e')
msg = get_message('C:/Projects/_tmp_devghost_audit/artisan-private', '188c43e')
def call_fn(s, p, schema=None, max_tokens=1024):
    r, _ = call_openrouter(s, p, schema, max_tokens)
    return r
result = run_fd_hybrid(diff, msg, 'typescript', fc, la, ld, call_fn)
print(f'method={result[\"method\"]}, est={result[\"estimated_hours\"]:.1f}h')
"
```
Expected: `method=FD_bulk_scaffold, est=30.5h` (unchanged from v1).

- [ ] **Step 2: Run v2 Branch B on feature commit (1d02576, GT 40-60h)**

```bash
# Same setup but with the feature commit
# Expected: enters v2, clusters code files, runs cluster + holistic LLM calls
```

Record: cluster count, branch_estimate, holistic_estimate, final, cost.

- [ ] **Step 3: Run v2 Branch A on feature commit (1d02576)**

```bash
FD_V2_BRANCH=A FD_LARGE_LLM_MODEL=anthropic/claude-sonnet-4 ...
```

Record: estimate, cost. Compare with Branch B result.

- [ ] **Step 4: Calculate MAPE across all 3 GT commits**

Record results in a table and compare with spec target (MAPE < 50%):

| Commit | GT | Branch B | Branch A | Combined |
|--------|----|----------|----------|----------|
| 188c43e | 15-30h | scaffold(30.5h) | scaffold(30.5h) | 30.5h |
| 1d02576 | 40-60h | ? | ? | ? |
| 16dc74e | 8-16h | ? | ? | ? |

- [ ] **Step 5: Document results in spec**

Update `docs/superpowers/specs/2026-03-25-fd-v2-large-commit-estimation-design.md` validation section with actual v2 pipeline results.

---

## Summary

| Task | What | Tests | LLM |
|------|------|-------|-----|
| 1 | classify_file_tier() | 12 unit | no |
| 2 | adaptive_filter() | 5 unit | no |
| 3 | build_clusters() | 7 unit | no |
| 4 | combine_estimates() | 7 unit | no |
| 5 | estimate_branch_b() | 3 unit (mock) | mock |
| 6 | estimate_holistic() | 4 unit (mock) | mock |
| 7 | estimate_branch_a() | 3 unit (mock) | mock |
| 8 | _run_fd_v2() + gate | 3 unit (mock) | mock |
| 9 | Modal worker.py | import check | no |
| 10 | Routing smoke tests | 4 real commits | mock |
| 11 | Branch A wiring | — | no |
| 12 | E2E verification | full suite | no |
| 13 | Real LLM validation | 3 GT commits | real |

**Total: ~44 unit tests + 10 routing tests + 3 real LLM validations.**

Dependencies: Task 2 depends on Task 1. Tasks 1, 3, 4 are independent of each other (pure functions). Tasks 5-7 depend on 1-4. Task 8 depends on 5-7. Task 11 depends on Task 8 (both modify `run_fd_hybrid()` signature and `run_commit()`). Tasks 9-10 can run in parallel with 8. Task 12 requires all prior. Task 13 requires 12.

```
Task 1 (filter tier) ──→ Task 2 (full filter) ──┐
Task 3 (clustering) ─────────────────────────────┤
Task 4 (combine) ────────────────────────────────┤
                                                  ├──→ Task 8 (orchestrator + gate)
Task 5 (Branch B) ────────────────────────────────┤        │
Task 6 (holistic) ────────────────────────────────┤        ├──→ Task 11 (Branch A wiring)
Task 7 (Branch A) ────────────────────────────────┘        │           │
                                                           ├───────────┤
Task 9 (Modal) ────────────────────────────────────────────┤           ├──→ Task 12 (E2E) → Task 13 (real LLM)
Task 10 (routing tests) ──────────────────────────────────┘           │
```
