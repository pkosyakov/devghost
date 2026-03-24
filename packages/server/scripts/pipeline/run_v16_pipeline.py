"""
Run v18/v19 pipeline on any repo.
Usage: python scripts/run_v16_pipeline.py <repo_name> <repo_path> <language>
       python scripts/run_v16_pipeline.py chi C:/repos/chi Go
       python scripts/run_v16_pipeline.py chi C:/repos/chi Go --residual-model
       python scripts/run_v16_pipeline.py chi C:/repos/chi Go --isotonic
"""
import hashlib, json, requests, re, sys, os, subprocess, pickle, time, random
import numpy as np
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# LLM provider config (set by pipeline-bridge or env)
LLM_PROVIDER = os.environ.get('LLM_PROVIDER', 'ollama')
OLLAMA_URL = os.environ.get('OLLAMA_URL', 'http://localhost:11434').rstrip('/') + '/api/generate'
OPENROUTER_API_KEY = os.environ.get('OPENROUTER_API_KEY', '')
OPENROUTER_MODEL = os.environ.get('OPENROUTER_MODEL', 'qwen/qwen-2.5-coder-32b-instruct')
OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions'

# OpenRouter routing preferences.
# Defaults are tuned for stable JSON schema output with qwen2.5-coder-32b-instruct.
def _env_bool(name, default):
    val = os.environ.get(name)
    if val is None or val.strip() == '':
        return default
    return val.strip().lower() in ('1', 'true', 'yes', 'on')


def _env_csv(name, default_csv):
    raw = os.environ.get(name, default_csv)
    return [x.strip() for x in raw.split(',') if x.strip()]


def _env_positive_int(name, default):
    raw = os.environ.get(name)
    if raw is None or raw.strip() == '':
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _env_positive_float(name, default):
    raw = os.environ.get(name)
    if raw is None or raw.strip() == '':
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


OPENROUTER_PROVIDER_ORDER = _env_csv('OPENROUTER_PROVIDER_ORDER', 'Chutes')
OPENROUTER_PROVIDER_IGNORE = _env_csv('OPENROUTER_PROVIDER_IGNORE', 'Cloudflare')
OPENROUTER_ALLOW_FALLBACKS = _env_bool('OPENROUTER_ALLOW_FALLBACKS', True)
OPENROUTER_REQUIRE_PARAMETERS = _env_bool('OPENROUTER_REQUIRE_PARAMETERS', True)
OPENROUTER_MAX_RETRIES = _env_positive_int('OPENROUTER_MAX_RETRIES', 4)
OPENROUTER_CONNECT_TIMEOUT_SEC = _env_positive_float('OPENROUTER_CONNECT_TIMEOUT_SEC', 20.0)
OPENROUTER_READ_TIMEOUT_SEC = _env_positive_float('OPENROUTER_READ_TIMEOUT_SEC', 120.0)
OPENROUTER_RETRY_BACKOFF_BASE_SEC = _env_positive_float('OPENROUTER_RETRY_BACKOFF_BASE_SEC', 1.0)
OPENROUTER_RETRY_BACKOFF_MAX_SEC = _env_positive_float('OPENROUTER_RETRY_BACKOFF_MAX_SEC', 20.0)

# --- Cache config ---
CACHE_VERSION = 1
PIPELINE_CACHE_DIR = os.environ.get('PIPELINE_CACHE_DIR', os.path.join(os.path.dirname(__file__), '..', '.cache'))
PIPELINE_CACHE_NAMESPACE = os.environ.get('PIPELINE_CACHE_NAMESPACE', '').strip()
NO_CACHE = os.environ.get('NO_CACHE', '').lower() in ('1', 'true', 'yes')
NO_LLM_CACHE = os.environ.get('NO_LLM_CACHE', '').lower() in ('1', 'true', 'yes')
PROMPT_REPEAT = os.environ.get('PROMPT_REPEAT', '').lower() in ('1', 'true', 'yes')

# Dynamic context — computed from model metadata passed via env var
_SYSTEM_PROMPT_RESERVE = 2048   # tokens for system prompt + overhead
_MAX_OUTPUT_TOKENS = 1024       # our max_tokens setting
_CHARS_PER_TOKEN = 2.0          # worst-case for code (lockfiles, JSON)
_MIN_CONTEXT = 4096             # absolute floor
_MAX_CONTEXT = 262144           # cap — prevents extreme latency
_MIN_FD_THRESHOLD = 10000       # chars — below this, any diff triggers FD
_MAX_FD_THRESHOLD = 500000      # chars — upper bound

try:
    _raw_ctx = int(os.environ.get('MODEL_CONTEXT_LENGTH', '32768'))
except (ValueError, TypeError):
    _raw_ctx = 32768
MODEL_CTX = max(_MIN_CONTEXT, min(_MAX_CONTEXT, _raw_ctx))
_available_tokens = MODEL_CTX - _SYSTEM_PROMPT_RESERVE - _MAX_OUTPUT_TOKENS
FD_THRESHOLD = max(_MIN_FD_THRESHOLD, min(_MAX_FD_THRESHOLD, int(_available_tokens * _CHARS_PER_TOKEN)))

sys.stderr.write(f"[pipeline] context={MODEL_CTX} fd_threshold={FD_THRESHOLD} chars_per_tok={_CHARS_PER_TOKEN} prompt_repeat={PROMPT_REPEAT}\n")
sys.stderr.flush()


def _cache_root():
    if PIPELINE_CACHE_NAMESPACE:
        return os.path.join(PIPELINE_CACHE_DIR, PIPELINE_CACHE_NAMESPACE)
    return PIPELINE_CACHE_DIR


def _diff_cache_path(repo_slug, sha):
    return os.path.join(_cache_root(), 'diffs', repo_slug, f'{sha}.json')


def _read_diff_cache(repo_slug, sha):
    """Read cached diff data. Returns dict or None."""
    if NO_CACHE:
        return None
    path = _diff_cache_path(repo_slug, sha)
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        try:
            os.remove(path)
        except OSError:
            pass
        return None


def _write_diff_cache(repo_slug, sha, data):
    """Write diff data to cache. Silently ignores write failures."""
    if NO_CACHE:
        return
    path = _diff_cache_path(repo_slug, sha)
    try:
        _write_json_atomic(path, data)
    except OSError:
        pass


def _llm_cache_dir():
    """Build LLM cache directory path including version and runtime fingerprint."""
    model_slug = f'{LLM_PROVIDER}_{OPENROUTER_MODEL if LLM_PROVIDER == "openrouter" else os.environ.get("OLLAMA_MODEL", "qwen2.5-coder:32b")}'
    model_slug = re.sub(r'[^\w\-.]', '_', model_slug)
    # Runtime fingerprint: params that affect LLM output beyond model identity
    fp_parts = [
        f'seed=42',
        f'temp=0',
    ]
    if LLM_PROVIDER == 'openrouter':
        fp_parts += [
            f'order={",".join(OPENROUTER_PROVIDER_ORDER)}',
            f'ignore={",".join(OPENROUTER_PROVIDER_IGNORE)}',
            f'fallbacks={OPENROUTER_ALLOW_FALLBACKS}',
            f'require_params={OPENROUTER_REQUIRE_PARAMETERS}',
        ]
    else:
        fp_parts.append(f'num_ctx={MODEL_CTX}')
    runtime_fp = hashlib.sha256('|'.join(fp_parts).encode()).hexdigest()[:12]
    return os.path.join(_cache_root(), 'llm', f'v{CACHE_VERSION}', model_slug, runtime_fp)


def _llm_cache_key(system, prompt, schema, max_tokens):
    """Generate deterministic cache key from LLM inputs."""
    key_str = f'{system}\n---\n{prompt}\n---\n{json.dumps(schema, sort_keys=True) if schema else ""}\n---\n{max_tokens}'
    return hashlib.sha256(key_str.encode()).hexdigest()


def _read_llm_cache(system, prompt, schema, max_tokens):
    """Read cached LLM response. Returns (parsed, meta) or None."""
    if NO_CACHE or NO_LLM_CACHE:
        return None
    key = _llm_cache_key(system, prompt, schema, max_tokens)
    path = os.path.join(_llm_cache_dir(), f'{key}.json')
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data['response'], data['meta']
    except (json.JSONDecodeError, OSError, KeyError):
        try:
            os.remove(path)
        except OSError:
            pass
        return None


def _write_llm_cache(system, prompt, schema, max_tokens, response, meta):
    """Write LLM response to cache."""
    if NO_CACHE or NO_LLM_CACHE:
        return
    key = _llm_cache_key(system, prompt, schema, max_tokens)
    cache_dir = _llm_cache_dir()
    path = os.path.join(cache_dir, f'{key}.json')
    try:
        _write_json_atomic(path, {
            'cache_version': CACHE_VERSION,
            'model': OPENROUTER_MODEL if LLM_PROVIDER == 'openrouter' else os.environ.get('OLLAMA_MODEL', 'qwen2.5-coder:32b'),
            'provider': LLM_PROVIDER,
            'response': response,
            'meta': meta,
            'cached_at': datetime.now().isoformat(),
        })
    except OSError:
        pass


def _write_json_atomic(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f'{path}.tmp.{os.getpid()}.{int(time.time() * 1000)}'
    try:
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


# Module bias: average from LORO across 5 repos
MODULE_BIAS = 1.5

# OpenRouter pricing for Qwen2.5 Coder 32B Instruct ($ per million tokens)
OPENROUTER_INPUT_PRICE = 0.03   # $/M input tokens
OPENROUTER_OUTPUT_PRICE = 0.11  # $/M output tokens

# --- B: Config file extensions for rule2 whitelist ---
CONFIG_EXTENSIONS = {'.json', '.toml', '.yaml', '.yml', '.lock', '.csproj', '.sln',
                     '.xml', '.props', '.targets', '.config', '.ini', '.cfg',
                     '.npmrc', '.editorconfig', '.prettierrc', '.eslintrc'}

# Lockfile/dependency patterns — auto-generated, near-zero effort
GENERATED_FILE_PATTERNS = [
    r'go\.sum$', r'go\.mod$',
    r'package-lock\.json$', r'pnpm-lock\.yaml$', r'yarn\.lock$',
    r'Cargo\.lock$', r'poetry\.lock$', r'Pipfile\.lock$',
    r'\.gradle\.lockfile$',
]

# Test file patterns — discounted effort vs implementation
TEST_FILE_PATTERNS = [
    r'_test\.go$',
    r'Test\.java$', r'Test\.kt$', r'Tests\.java$', r'Spec\.java$',
    r'test_\w+\.py$', r'_test\.py$',
    r'\.test\.\w+$', r'\.spec\.\w+$',
    r'__tests__/', r'src/test/', r'testdata/', r'__fixtures__/',
]

# --- E: Change types that skip complexity_floor ---
FLOOR_SKIP_TYPES = {'mechanical changes', 'test', 'test_only', 'chore', 'config', 'tooling'}

# --- Schemas ---
ANALYSIS_SCHEMA = {
    'type': 'object',
    'properties': {
        'change_type': {'type': 'string'},
        'new_logic_percent': {'type': 'number'},
        'moved_or_copied_percent': {'type': 'number'},
        'boilerplate_percent': {'type': 'number'},
        'architectural_scope': {'type': 'string'},
        'cognitive_complexity': {'type': 'string'},
        'summary': {'type': 'string'},
    },
    'required': ['change_type', 'new_logic_percent', 'moved_or_copied_percent',
                 'boilerplate_percent', 'architectural_scope', 'cognitive_complexity', 'summary'],
}

ESTIMATE_SCHEMA = {
    'type': 'object',
    'properties': {
        'estimated_hours': {'type': 'number'},
        'reasoning': {'type': 'string'},
    },
    'required': ['estimated_hours', 'reasoning'],
}

DECOMP_SCHEMA = {
    'type': 'object',
    'properties': {
        'coding_hours': {'type': 'number'},
        'integration_hours': {'type': 'number'},
        'testing_hours': {'type': 'number'},
        'estimated_hours': {'type': 'number'},
        'reasoning': {'type': 'string'},
    },
    'required': ['coding_hours', 'integration_hours', 'testing_hours', 'estimated_hours', 'reasoning'],
}

# --- Prompts (frozen from v15) ---
PROMPT_PASS1 = """Classify this {lang} commit objectively. Be precise with percentages.

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

PROMPT_2PASS_V2 = """Estimate total hours for this {lang} commit as a middle dev (3-4yr experience, knows codebase)."""

PROMPT_HYBRID_C = """Estimate total hours for this {lang} commit as a middle dev (3-4yr experience, knows codebase).

IMPORTANT: For commits with architectural_scope "package", "multi_package", or "system",
the effort is dominated by architectural overhead, NOT by the percentage of moved code.

REFERENCE POINTS:
- Simple refactor (scope: none, 90%+ moved code) -> 0.1-1h
- Module extraction (scope: module, 80%+ moved code) -> 3-6h
- Package creation (scope: package, 90%+ moved code) -> 10-20h
- Workspace restructure (scope: multi_package) -> 15-30h"""

PROMPT_TASK_DECOMP = """Estimate effort for this {lang} commit as a middle dev (3-4yr experience, knows codebase).

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


def call_ollama(system, prompt, schema=None, max_tokens=1024):
    """Returns (parsed_result, meta_dict). meta_dict has token counts and timing."""
    effective_prompt = f'{system}\n\n---\n\n{prompt}' if PROMPT_REPEAT else prompt
    payload = {
        'model': os.environ.get('OLLAMA_MODEL', 'qwen2.5-coder:32b'), 'prompt': effective_prompt, 'system': system, 'stream': False,
        'options': {'temperature': 0, 'num_predict': max_tokens, 'num_ctx': MODEL_CTX, 'seed': 42},
    }
    if schema:
        payload['format'] = schema
    try:
        resp = requests.post(OLLAMA_URL, json=payload, timeout=600)
        resp.raise_for_status()
        data = resp.json()
        raw = data.get('response', '')
        text = re.sub(r'<think>[\s\S]*?</think>', '', raw).strip()
        parsed = json.loads(text) if schema else text
        meta = {
            'prompt_tokens': data.get('prompt_eval_count', 0),
            'completion_tokens': data.get('eval_count', 0),
            'total_duration_ms': data.get('total_duration', 0) / 1e6,
            'prompt_eval_ms': data.get('prompt_eval_duration', 0) / 1e6,
            'eval_ms': data.get('eval_duration', 0) / 1e6,
        }
        return parsed, meta
    except Exception as e:
        print(f"    ERROR: {e}")
        return None, {'prompt_tokens': 0, 'completion_tokens': 0,
                      'total_duration_ms': 0, 'prompt_eval_ms': 0, 'eval_ms': 0}


def _extract_json(text):
    """Extract JSON from text that may contain markdown code blocks or extra text."""
    # Try raw text first
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try extracting from ```json ... ``` blocks
    m = re.search(r'```(?:json)?\s*\n?([\s\S]*?)```', text)
    if m:
        try:
            return json.loads(m.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Try finding first { ... } block (naive brace matching — does not handle
    # braces inside JSON string values, but json.loads validates the result)
    start = text.find('{')
    if start >= 0:
        # Find matching closing brace
        depth = 0
        for i in range(start, len(text)):
            if text[i] == '{':
                depth += 1
            elif text[i] == '}':
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:i + 1])
                    except json.JSONDecodeError:
                        break

    return None


def call_openrouter(system, prompt, schema=None, max_tokens=1024):
    """Call OpenRouter API (OpenAI-compatible). Returns (parsed_result, meta_dict)."""
    if not OPENROUTER_API_KEY:
        print("    ERROR: OPENROUTER_API_KEY is empty", file=sys.stderr, flush=True)
        return None, {'prompt_tokens': 0, 'completion_tokens': 0,
                      'total_duration_ms': 0, 'error': 'OPENROUTER_API_KEY is empty'}

    system_content = system
    if schema:
        system_content += f'\n\nYou MUST respond with ONLY valid JSON (no markdown, no extra text) matching this schema:\n{json.dumps(schema)}'

    provider_prefs = {
        'allow_fallbacks': OPENROUTER_ALLOW_FALLBACKS,
        'require_parameters': OPENROUTER_REQUIRE_PARAMETERS,
    }
    if OPENROUTER_PROVIDER_ORDER:
        provider_prefs['order'] = OPENROUTER_PROVIDER_ORDER
    if OPENROUTER_PROVIDER_IGNORE:
        provider_prefs['ignore'] = OPENROUTER_PROVIDER_IGNORE

    effective_prompt = f'{system_content}\n\n---\n\n{prompt}' if PROMPT_REPEAT else prompt
    payload = {
        'model': OPENROUTER_MODEL,
        'messages': [
            {'role': 'system', 'content': system_content},
            {'role': 'user', 'content': effective_prompt},
        ],
        'temperature': 0,
        'max_tokens': max_tokens,
        'seed': 42,
        'provider': provider_prefs,
    }
    if schema:
        payload['response_format'] = {
            'type': 'json_schema',
            'json_schema': {
                'name': 'response',
                'strict': True,
                'schema': schema,
            },
        }

    headers = {
        'Authorization': f'Bearer {OPENROUTER_API_KEY}',
        'Content-Type': 'application/json',
    }

    max_retries = OPENROUTER_MAX_RETRIES
    total_attempts = max_retries + 1
    last_error = None
    total_elapsed = 0
    retriable_statuses = {408, 409, 425, 429, 500, 502, 503, 504}

    def retry_sleep(attempt_idx):
        # Exponential backoff with bounded jitter for transient network/provider faults.
        exp = OPENROUTER_RETRY_BACKOFF_BASE_SEC * (2 ** attempt_idx)
        jitter = random.uniform(0, OPENROUTER_RETRY_BACKOFF_BASE_SEC)
        return min(OPENROUTER_RETRY_BACKOFF_MAX_SEC, exp + jitter)

    for attempt in range(total_attempts):
        attempt_no = attempt + 1
        start = time.time()
        try:
            resp = requests.post(
                OPENROUTER_BASE_URL,
                json=payload,
                headers=headers,
                timeout=(OPENROUTER_CONNECT_TIMEOUT_SEC, OPENROUTER_READ_TIMEOUT_SEC),
            )
            elapsed_ms = (time.time() - start) * 1000
            total_elapsed += elapsed_ms

            if resp.status_code != 200:
                err_body = resp.text[:500]
                last_error = f'HTTP {resp.status_code}: {err_body}'
                print(
                    f"    ERROR: OpenRouter {last_error} (attempt {attempt_no}/{total_attempts})",
                    file=sys.stderr,
                    flush=True,
                )
                if resp.status_code in retriable_statuses and attempt < max_retries:
                    time.sleep(retry_sleep(attempt))
                    continue
                return None, {'prompt_tokens': 0, 'completion_tokens': 0,
                              'total_duration_ms': total_elapsed, 'error': last_error}

            data = resp.json()

            # Check for API-level error in response body
            if 'error' in data:
                err_msg = data['error'].get('message', str(data['error'])) if isinstance(data['error'], dict) else str(data['error'])
                last_error = f'API error: {err_msg}'
                print(f"    ERROR: OpenRouter {last_error}", file=sys.stderr, flush=True)
                return None, {'prompt_tokens': 0, 'completion_tokens': 0,
                              'total_duration_ms': total_elapsed, 'error': last_error}

            provider_name = data.get('provider', '?')
            content = data['choices'][0]['message']['content']
            text = re.sub(r'<think>[\s\S]*?</think>', '', content).strip()

            if schema:
                parsed = _extract_json(text)
                if parsed is None:
                    last_error = f'Invalid JSON from {provider_name}: {text[:200]}'
                    print(
                        f"    WARN: {last_error} (attempt {attempt_no}/{total_attempts})",
                        file=sys.stderr,
                        flush=True,
                    )
                    if attempt < max_retries:
                        time.sleep(retry_sleep(attempt))
                        continue
                    return None, {'prompt_tokens': 0, 'completion_tokens': 0,
                                  'total_duration_ms': total_elapsed, 'error': last_error}
            else:
                parsed = text

            usage = data.get('usage', {})
            meta = {
                'prompt_tokens': usage.get('prompt_tokens', 0),
                'completion_tokens': usage.get('completion_tokens', 0),
                'total_duration_ms': total_elapsed,
                'prompt_eval_ms': 0,
                'eval_ms': elapsed_ms,
                'provider': provider_name,
            }
            return parsed, meta

        except requests.exceptions.RequestException as e:
            elapsed_ms = (time.time() - start) * 1000
            total_elapsed += elapsed_ms
            last_error = f'Network error: {e}'
            print(
                f"    ERROR: {last_error} (attempt {attempt_no}/{total_attempts})",
                file=sys.stderr,
                flush=True,
            )
            if attempt < max_retries:
                time.sleep(retry_sleep(attempt))
                continue
        except Exception as e:
            elapsed_ms = (time.time() - start) * 1000
            total_elapsed += elapsed_ms
            last_error = f'Unexpected error: {e}'
            print(
                f"    ERROR: {last_error} (attempt {attempt_no}/{total_attempts})",
                file=sys.stderr,
                flush=True,
            )
            if attempt < max_retries:
                time.sleep(retry_sleep(attempt))
                continue

    return None, {'prompt_tokens': 0, 'completion_tokens': 0,
                  'total_duration_ms': total_elapsed, 'error': last_error}


def call_llm(system, prompt, schema=None, max_tokens=1024):
    """Dispatch to Ollama or OpenRouter based on LLM_PROVIDER. Uses LLM cache if available."""
    # Check cache first
    cached = _read_llm_cache(system, prompt, schema, max_tokens)
    if cached is not None:
        parsed, meta = cached
        meta['cache_hit'] = True
        return parsed, meta

    if LLM_PROVIDER == 'openrouter':
        parsed, meta = call_openrouter(system, prompt, schema, max_tokens)
    else:
        parsed, meta = call_ollama(system, prompt, schema, max_tokens)

    # Write to cache on success
    if parsed is not None:
        _write_llm_cache(system, prompt, schema, max_tokens, parsed, meta)

    meta['cache_hit'] = False
    return parsed, meta


def get_changed_files(repo_dir, sha):
    """Get list of changed file paths for a commit."""
    result = subprocess.run(
        ['git', '-C', repo_dir, 'diff', '--name-only', f'{sha}~1..{sha}'],
        capture_output=True, text=True, encoding='utf-8', errors='replace')
    if result.returncode != 0:
        return []
    return [f.strip() for f in result.stdout.strip().split('\n') if f.strip()]


def classify_changed_files(changed_files):
    """Classify files as generated, test, or implementation. Returns (gen_count, test_count, impl_count)."""
    gen = test = impl = 0
    for f in changed_files:
        if any(re.search(p, f) for p in GENERATED_FILE_PATTERNS):
            gen += 1
        elif any(re.search(p, f) for p in TEST_FILE_PATTERNS):
            test += 1
        else:
            impl += 1
    return gen, test, impl


def get_commit_diff(repo_dir, sha, repo_slug=None):
    """Returns (diff, files_changed, lines_added, lines_deleted, changed_files)."""
    # Check diff cache
    if repo_slug:
        cached = _read_diff_cache(repo_slug, sha)
        if cached:
            return (cached['diff'], cached['stat']['files_changed'],
                    cached['stat']['lines_added'], cached['stat']['lines_deleted'],
                    cached['changed_files'])

    diff = subprocess.run(['git', '-c', 'gc.auto=0', '-C', repo_dir, 'diff', f'{sha}~1..{sha}'],
                          capture_output=True, text=True, encoding='utf-8', errors='replace').stdout
    stat = subprocess.run(['git', '-c', 'gc.auto=0', '-C', repo_dir, 'diff', '--stat', f'{sha}~1..{sha}'],
                          capture_output=True, text=True, encoding='utf-8', errors='replace').stdout
    stat_line = stat.strip().split('\n')[-1] if stat else ''
    fc = la = ld = 0
    m = re.search(r'(\d+) files? changed', stat_line)
    if m: fc = int(m.group(1))
    m = re.search(r'(\d+) insertions?', stat_line)
    if m: la = int(m.group(1))
    m = re.search(r'(\d+) deletions?', stat_line)
    if m: ld = int(m.group(1))

    changed_files = get_changed_files(repo_dir, sha)

    # Write to cache
    if repo_slug:
        _write_diff_cache(repo_slug, sha, {
            'sha': sha,
            'diff': diff,
            'stat': {'files_changed': fc, 'lines_added': la, 'lines_deleted': ld},
            'changed_files': changed_files,
            'diff_length': len(diff),
            'cached_at': datetime.now().isoformat(),
        })

    return diff, fc, la, ld, changed_files


def estimate_fd_fallback(msg, fc, la, ld):
    msg_lower = msg.lower()
    total_lines = la + ld
    if 'test' in msg_lower and total_lines > 3000:
        return 5.0, 'fd_test_heuristic'
    if 'locale' in msg_lower or 'translation' in msg_lower:
        return 5.0, 'fd_locale_heuristic'
    if fc > 200:
        return 8.0, 'fd_bulk_heuristic'
    est = min(16.0, max(4.0, fc * 0.5))
    return est, 'fd_size_heuristic'



# --- H: Complexity guard ---
def compute_complexity_score(diff):
    """Compute a complexity score from added lines in the diff."""
    added = [l[1:] for l in diff.split('\n') if l.startswith('+') and not l.startswith('+++')]
    func_defs = sum(1 for l in added if re.search(
        r'\b(func|def|fn|function|public\s+\w+\s+\w+\s*\(|private\s+\w+\s+\w+\s*\(|protected\s+\w+\s+\w+\s*\()\b', l))
    control_flow = sum(1 for l in added if re.search(
        r'\b(if|else|for|while|match|switch|case|try|catch|except)\b', l))
    deep_nesting = sum(1 for l in added if re.match(r'^(\t{3,}|\s{12,})', l))
    return func_defs * 2 + control_flow + deep_nesting * 0.5


def apply_complexity_guard(estimate, score, analysis=None):
    """Cap simple diffs, floor complex diffs.
    E: skip floor for mechanical/test/chore change types."""
    if score < 10 and estimate > 5.0:
        return 5.0, 'complexity_cap'
    if score > 50 and estimate < 5.0:
        # E: skip floor if change_type indicates low-effort work
        if analysis:
            change_type = (analysis.get('change_type') or '').lower()
            if change_type in FLOOR_SKIP_TYPES:
                return estimate, None
        return 5.0, 'complexity_floor'
    return estimate, None


# --- B: File-type whitelist for rule2 ---
def apply_correction_rules(commit_msg, estimate, analysis, insertions, deletions=0, changed_files=None):
    if not analysis:
        return estimate, None

    scope = analysis.get('architectural_scope', 'none')
    moved_pct = analysis.get('moved_or_copied_percent', 0)
    new_logic_pct = analysis.get('new_logic_percent', 100)
    boilerplate_pct = analysis.get('boilerplate_percent', 0)
    change_type = analysis.get('change_type', '').lower()
    summary = analysis.get('summary', '').lower()
    commit_msg_lower = commit_msg.lower()

    # Rule 5: Dependency-only commits (go.mod+go.sum, package-lock, etc.)
    if changed_files:
        gen, test, impl = classify_changed_files(changed_files)
        total = len(changed_files)
        # All files are generated or config — this is a single tooling command
        if impl == 0 and test == 0 and total > 0:
            if estimate > 0.5:
                return 0.5, 'rule5_deps_only'

    # Rule 1: Pure code moves
    is_pure_move_pattern = (
        ('move' in commit_msg_lower and 'to its own module' in commit_msg_lower) or
        ('generator' in summary and 'move' in summary and 'module' in summary)
    )
    if (scope == 'module' and moved_pct > 85 and new_logic_pct < 10 and is_pure_move_pattern):
        if estimate > 2.5:
            return 2.5, 'rule1_pure_move'

    # Rule 2: Mechanical/config changes — with file-type whitelist (B)
    is_mechanical = (moved_pct + boilerplate_pct > 80) and new_logic_pct < 15
    is_config_keyword = (
        change_type in ['config', 'chore', 'tooling', 'mechanical changes'] or
        'edition' in summary or 'upgrade' in summary or 'bump' in summary or
        'edition' in commit_msg_lower
    )
    if is_config_keyword and is_mechanical:
        if changed_files:
            config_count = sum(1 for f in changed_files
                               if os.path.splitext(f)[1].lower() in CONFIG_EXTENSIONS)
            if config_count / len(changed_files) >= 0.5:
                if estimate > 1.5:
                    return 1.5, 'rule2_config_bump'
            # else: skip rule2 — less than 50% config files
        else:
            if estimate > 1.5:
                return 1.5, 'rule2_config_bump'

    # Rule 3: Large test additions
    if (change_type in ['test', 'test_only'] and insertions > 1000 and new_logic_pct < 30):
        return estimate * 0.6, 'rule3_large_tests'

    # Rule 4: Generator moves
    if (scope == 'module' and moved_pct > 80 and 'generator' in summary):
        if estimate > 2.0:
            return 2.0, 'rule4_generator_move'

    # Rule 6: Test-heavy commits — test code requires less effort per line
    if changed_files:
        gen, test, impl = classify_changed_files(changed_files)
        total = len(changed_files)
        if total > 1 and test / total > 0.6 and impl > 0:
            if estimate > 2.0:
                return estimate * 0.6, 'rule6_test_heavy'

    # Rule 7: Net-deletion simplification (removing > adding = simplification)
    la, ld = insertions, deletions
    if la > 0 and ld > la * 3 and estimate > 1.0:
        return min(estimate, max(0.5, estimate * 0.5)), 'rule7_net_deletion'

    return estimate, None


def run_commit(repo_dir, lang, sha, msg, repo_slug=None):
    # Step 1: get diff + changed_files
    diff, fc, la, ld, changed_files = get_commit_diff(repo_dir, sha, repo_slug)

    # Step 2: File decomposition for large diffs (>60K chars)
    if len(diff) > FD_THRESHOLD:
        try:
            from file_decomposition import run_fd_hybrid
            print(f" [FD:{len(diff)//1000}K]", end='', flush=True)

            # FD expects old call_ollama signature (returns parsed only).
            # Wrap to collect meta from each LLM call.
            fd_llm_calls = []
            def call_llm_fd(system, prompt, schema=None, max_tokens=1024):
                parsed, meta = call_llm(system, prompt, schema, max_tokens)
                fd_llm_calls.append({**meta, 'step': 'fd'})
                return parsed

            fd_result = run_fd_hybrid(diff, msg, lang, fc, la, ld, call_llm_fd)
            raw_estimate = fd_result['estimated_hours']
            analysis = fd_result.get('analysis')

            corrected, rule = apply_correction_rules(msg, raw_estimate, analysis, la, ld, changed_files)
            if rule:
                fd_result['rule_applied'] = rule

            scope = (analysis or {}).get('architectural_scope', 'none')
            final = corrected
            module_corrected = False
            # v18: MODULE_BIAS removed for all paths (including FD)

            # H+E: complexity guard (skip floor for mechanical/test/chore)
            complexity_score = compute_complexity_score(diff)
            cg_result, cg_rule = apply_complexity_guard(final, complexity_score, analysis)
            if cg_rule:
                final = cg_result

            return {
                'estimated_hours': final, 'raw_estimate': raw_estimate,
                'post_rules': corrected, 'module_corrected': module_corrected,
                'method': fd_result.get('method', 'FD'), 'routed_to': scope,
                'analysis': analysis, 'rule_applied': rule or fd_result.get('rule_applied'),
                'fd_details': fd_result.get('fd_details'),
                'complexity_score': complexity_score,
                'complexity_guard': cg_rule,
                'llm_calls': fd_llm_calls,
            }
        except Exception as e:
            print(f" [FD-ERROR:{e}]", end='', flush=True)
            est, rule = estimate_fd_fallback(msg, fc, la, ld)
            return {
                'estimated_hours': est, 'raw_estimate': est,
                'method': 'FD_fallback', 'routed_to': '?',
                'analysis': None, 'rule_applied': rule,
                'complexity_score': 0, 'complexity_guard': None,
                'llm_calls': [],
            }

    user_base = f'Commit: {msg}\nFiles: {fc}, +{la}/-{ld}\n\n{diff}'

    # Step 3: Pass 1 — Classification
    llm_calls = []
    analysis, meta = call_llm(PROMPT_PASS1.format(lang=lang),
                                  f'{user_base}\n\nClassify this commit:',
                                  schema=ANALYSIS_SCHEMA)
    llm_calls.append({**meta, 'step': 'pass1_classify'})
    if not analysis:
        return {
            'estimated_hours': 5.0, 'raw_estimate': 5.0,
            'method': 'error', 'routed_to': 'error',
            'analysis': None, 'rule_applied': None,
            'complexity_score': 0, 'complexity_guard': None,
            'llm_calls': llm_calls,
        }

    scope = analysis.get('architectural_scope', 'none')
    analysis_text = f"""Change type: {analysis.get('change_type', '?')}
New logic: {analysis.get('new_logic_percent', '?')}%, Moved: {analysis.get('moved_or_copied_percent', '?')}%
Scope: {scope}, Complexity: {analysis.get('cognitive_complexity', '?')}"""

    estimate_input = f'{user_base}\n\nAnalysis:\n{analysis_text}\n\nEstimate:'

    # Step 4: Route by scope
    if scope in ('none', 'module'):
        # v18: module uses simple estimate only (no decomp ensemble, no MODULE_BIAS)
        # Experiment showed: simple-only MAE=1.11 vs ensemble+bias MAE=1.40 on 51 module commits
        result, meta = call_llm(PROMPT_2PASS_V2.format(lang=lang), estimate_input, schema=ESTIMATE_SCHEMA)
        llm_calls.append({**meta, 'step': 'pass2_estimate'})
        raw_estimate = result.get('estimated_hours', 5.0) if result else 5.0
    else:
        result, meta = call_llm(PROMPT_HYBRID_C.format(lang=lang), estimate_input, schema=ESTIMATE_SCHEMA)
        llm_calls.append({**meta, 'step': 'pass2_hybrid'})
        raw_estimate = result.get('estimated_hours', 5.0) if result else 5.0

    # Step 5: Correction rules (B: with changed_files)
    corrected, rule = apply_correction_rules(msg, raw_estimate, analysis, la, ld, changed_files)

    # Step 6: Module bias — REMOVED in v18
    # Experiment showed simple-only without bias beats ensemble+bias (MAE 1.11 vs 1.40)
    final = corrected
    module_corrected = False

    # Step 8: H+E — Complexity guard (skip floor for mechanical/test/chore)
    complexity_score = compute_complexity_score(diff)
    cg_result, cg_rule = apply_complexity_guard(final, complexity_score, analysis)
    if cg_rule:
        final = cg_result

    result_dict = {
        'estimated_hours': final,
        'raw_estimate': raw_estimate,
        'post_rules': corrected,
        'module_corrected': module_corrected,
        'method': f'cascading_{scope}',
        'routed_to': scope,
        'analysis': analysis,
        'rule_applied': rule,
        'complexity_score': complexity_score,
        'complexity_guard': cg_rule,
        'llm_calls': llm_calls,
    }

    return result_dict


# --- N: Residual GBR model ---
def train_residual_model(eval_dir, repos):
    """Train GBR on existing v15+opus data. Returns fitted model or None."""
    try:
        from sklearn.ensemble import GradientBoostingRegressor
    except ImportError:
        print("  [residual-model] scikit-learn not installed, skipping")
        return None

    X, y = [], []
    base_eval_dir = os.path.dirname(eval_dir)

    for repo in repos:
        repo_dir = os.path.join(base_eval_dir, repo)
        v15_path = os.path.join(repo_dir, 'qwen2.5-coder-32b-v15-frozen-pipeline.json')
        opus_path = os.path.join(repo_dir, 'opus-4.5.json')

        if not os.path.exists(v15_path) or not os.path.exists(opus_path):
            continue

        with open(v15_path, 'r', encoding='utf-8') as f:
            v15_data = json.load(f)
        with open(opus_path, 'r', encoding='utf-8') as f:
            opus_data = json.load(f)

        # Build opus lookup by sha
        opus_by_sha = {}
        for c in opus_data.get('commits', []):
            opus_by_sha[c['sha']] = c.get('estimated_hours', c.get('hours'))

        for c in v15_data.get('commits', []):
            sha = c['sha']
            if sha not in opus_by_sha:
                continue
            opus_hours = opus_by_sha[sha]
            if opus_hours is None:
                continue

            v15_hours = c.get('estimated_hours', 5.0)
            residual = v15_hours - opus_hours  # positive = overestimate

            # Features
            fc = c.get('files_changed', 0)
            la = c.get('lines_added', 0)
            ld = c.get('lines_deleted', 0)
            scope_map = {'none': 0, 'module': 1, 'package': 2, 'multi_package': 3, 'system': 4}
            scope_val = scope_map.get(c.get('routed_to', 'none'), 0)
            raw = c.get('raw_estimate', v15_hours)
            post_rules = c.get('post_rules', v15_hours)
            module_corr = 1 if c.get('module_corrected', False) else 0

            X.append([fc, la, ld, scope_val, raw, post_rules, module_corr, v15_hours])
            y.append(residual)

    if len(X) < 20:
        print(f"  [residual-model] Only {len(X)} training samples, need >= 20, skipping")
        return None

    print(f"  [residual-model] Training GBR on {len(X)} samples from {len(repos)} repos...")
    model = GradientBoostingRegressor(
        n_estimators=100, max_depth=3, learning_rate=0.1,
        subsample=0.8, random_state=42)
    model.fit(X, y)

    train_preds = model.predict(X)
    train_mae = np.mean(np.abs(np.array(y) - train_preds))
    print(f"  [residual-model] Train MAE on residuals: {train_mae:.3f}h")

    return model


def apply_residual_corrections(commits, model):
    """Apply residual corrections to commit estimates."""
    scope_map = {'none': 0, 'module': 1, 'package': 2, 'multi_package': 3, 'system': 4}
    corrected = 0

    for c in commits:
        fc = c.get('files_changed', 0)
        la = c.get('lines_added', 0)
        ld = c.get('lines_deleted', 0)
        scope_val = scope_map.get(c.get('routed_to', 'none'), 0)
        raw = c.get('raw_estimate', c['estimated_hours'])
        post_rules = c.get('post_rules', c['estimated_hours'])
        module_corr = 1 if c.get('module_corrected', False) else 0
        est = c['estimated_hours']

        features = [fc, la, ld, scope_val, raw, post_rules, module_corr, est]
        predicted_residual = model.predict([features])[0]

        c['pre_residual_hours'] = c['estimated_hours']
        c['estimated_hours'] = max(0.1, c['estimated_hours'] - predicted_residual)
        c['residual_correction'] = round(predicted_residual, 3)
        corrected += 1

    return corrected


def load_isotonic_models(eval_dir):
    """Load pre-trained isotonic calibration models from pickle."""
    base_eval_dir = os.path.dirname(eval_dir)
    pkl_path = os.path.join(base_eval_dir, 'isotonic_models.pkl')

    if not os.path.exists(pkl_path):
        print(f"  [isotonic] Model file not found: {pkl_path}")
        print(f"  [isotonic] Run: python scripts/train_isotonic_models.py")
        return None

    with open(pkl_path, 'rb') as f:
        models = pickle.load(f)

    meta = models.get('metadata', {})
    print(f"  [isotonic] Loaded models: scopes={meta.get('scopes_trained')}, "
          f"samples={meta.get('total_samples')}, global_MAE={meta.get('global_train_mae')}h")
    return models


def get_calibration_scope(commit):
    """Determine calibration scope from commit data. Must match train_isotonic_models.normalize_scope."""
    method = commit.get('method', '')
    if 'FD' in method or 'fd' in method.lower():
        return 'fd'
    if commit.get('routed_to') == 'module':
        return 'module'
    return 'none'


def apply_isotonic_calibration(commits, models):
    """Apply per-scope isotonic calibration to commit estimates. Returns count of calibrated commits."""
    scope_models = models['scope_models']
    global_model = models['global_model']
    calibrated = 0

    for c in commits:
        scope = get_calibration_scope(c)
        x = np.array([c['estimated_hours']])

        if scope in scope_models:
            cal = float(scope_models[scope].predict(x)[0])
            model_used = scope
        else:
            cal = float(global_model.predict(x)[0])
            model_used = 'global_fallback'

        c['pre_isotonic_hours'] = c['estimated_hours']
        c['estimated_hours'] = cal
        c['isotonic_scope'] = scope
        c['isotonic_model_used'] = model_used
        c['isotonic_calibrated'] = True
        calibrated += 1

    return calibrated


def main():
    if len(sys.argv) < 4:
        print("Usage: python scripts/run_v16_pipeline.py <repo_name> <repo_path> <language> [--residual-model] [--isotonic]")
        print("Example: python scripts/run_v16_pipeline.py chi C:/repos/chi Go")
        print("         python scripts/run_v16_pipeline.py chi C:/repos/chi Go --residual-model")
        print("         python scripts/run_v16_pipeline.py chi C:/repos/chi Go --isotonic")
        sys.exit(1)

    repo_name = sys.argv[1]
    repo_dir = sys.argv[2]
    lang = sys.argv[3]
    use_residual = '--residual-model' in sys.argv
    use_isotonic = '--isotonic' in sys.argv
    eval_dir = os.path.join(r'C:\Projects\AI-Code Audit\docs\research\benchmark\evaluations', repo_name)

    pipeline_version = 'v19-isotonic' if use_isotonic else 'v18'
    print("=" * 70)
    print(f"{pipeline_version.upper()} PIPELINE: {repo_name} ({lang})")
    print(f"Pipeline: {pipeline_version} (v17 + module: simple-only, no decomp, no bias{' + isotonic calibration' if use_isotonic else ''})")
    print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    llm_label = f"OpenRouter ({OPENROUTER_MODEL})" if LLM_PROVIDER == 'openrouter' else f"Ollama ({os.environ.get('OLLAMA_MODEL', 'qwen2.5-coder:32b')})"
    print(f"LLM provider: {llm_label}")
    print(f"Residual model: {'enabled' if use_residual else 'disabled'}")
    print(f"Isotonic calibration: {'enabled' if use_isotonic else 'disabled'}")
    if use_residual and use_isotonic:
        print("WARNING: Both --residual-model and --isotonic enabled. Isotonic models")
        print("  were trained on v18 estimates WITHOUT residual correction.")
    print("=" * 70)

    commits_file = os.path.join(eval_dir, 'selected_commits.json')
    with open(commits_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    commits = data['commits']
    print(f"Commits to evaluate: {len(commits)}")

    output_commits = []
    rules_applied = {}
    methods_used = {}
    complexity_guards_applied = {}
    total_llm_stats = {'calls': 0, 'prompt_tokens': 0, 'completion_tokens': 0, 'total_duration_ms': 0}

    for i, commit in enumerate(commits):
        sha = commit['sha']
        msg = commit['message']

        print(f"  [{i+1}/{len(commits)}] {sha[:8]} {msg[:50]}...", end='', flush=True)

        try:
            result = run_commit(repo_dir, lang, sha, msg, repo_slug=repo_name)
            est = result['estimated_hours']
            raw = result.get('raw_estimate', est)
            rule = result.get('rule_applied')
            method = result.get('method', '?')
            cg = result.get('complexity_guard')

            methods_used[method] = methods_used.get(method, 0) + 1
            if rule:
                rules_applied[rule] = rules_applied.get(rule, 0) + 1
            if cg:
                complexity_guards_applied[cg] = complexity_guards_applied.get(cg, 0) + 1

            # Accumulate LLM stats + per-commit cost
            llm_calls = result.get('llm_calls', [])
            cache_hits = sum(1 for c in llm_calls if c.get('cache_hit'))
            commit_prompt_tokens = sum(c['prompt_tokens'] for c in llm_calls)
            commit_completion_tokens = sum(c['completion_tokens'] for c in llm_calls)
            commit_duration_ms = sum(c['total_duration_ms'] for c in llm_calls)
            commit_cost = (commit_prompt_tokens / 1e6 * OPENROUTER_INPUT_PRICE
                           + commit_completion_tokens / 1e6 * OPENROUTER_OUTPUT_PRICE)
            total_llm_stats['calls'] += len(llm_calls)
            total_llm_stats['prompt_tokens'] += commit_prompt_tokens
            total_llm_stats['completion_tokens'] += commit_completion_tokens
            total_llm_stats['total_duration_ms'] += commit_duration_ms

            mc = ' [module-1.5h]' if result.get('module_corrected') else ''
            rule_tag = f' [{rule}]' if rule else ''
            cg_tag = f' [{cg}]' if cg else ''
            cscore = result.get('complexity_score', 0)
            cache_tag = f' cache={cache_hits}/{len(llm_calls)}' if cache_hits else ''

            print(f" est={est:.1f}h (raw={raw:.1f}) {result.get('routed_to','?')}"
                  f"{rule_tag}{mc}{cg_tag} cx={cscore:.0f}"
                  f" [{len(llm_calls)} calls, {commit_prompt_tokens}+{commit_completion_tokens} tok,"
                  f" {commit_duration_ms/1000:.1f}s, ${commit_cost:.4f}]{cache_tag}")

            commit_output = {
                'sha': sha,
                'message': msg,
                'estimated_hours': est,
                'raw_estimate': raw,
                'post_rules': result.get('post_rules', est),
                'method': method,
                'routed_to': result.get('routed_to', '?'),
                'rule_applied': rule,
                'module_corrected': result.get('module_corrected', False),
                'analysis': result.get('analysis'),
                'files_changed': commit.get('files_changed', 0),
                'lines_added': commit.get('lines_added', 0),
                'lines_deleted': commit.get('lines_deleted', 0),
                'complexity_score': result.get('complexity_score', 0),
                'complexity_guard': result.get('complexity_guard'),
                'llm_calls': llm_calls,
                'prompt_tokens': commit_prompt_tokens,
                'completion_tokens': commit_completion_tokens,
                'duration_ms': round(commit_duration_ms, 1),
                'openrouter_cost_usd': round(commit_cost, 6),
            }

            # J: ensemble fields
            if result.get('ensemble_raw_decomp') is not None:
                commit_output['ensemble_raw_decomp'] = result['ensemble_raw_decomp']
                commit_output['ensemble_raw_simple'] = result['ensemble_raw_simple']

            output_commits.append(commit_output)

        except Exception as e:
            print(f" ERROR: {e}")
            output_commits.append({
                'sha': sha, 'message': msg,
                'estimated_hours': 5.0, 'raw_estimate': 5.0,
                'method': 'error', 'routed_to': 'error',
                'complexity_score': 0, 'complexity_guard': None,
                'llm_calls': [],
            })

    # Step 10: N — Optional residual model correction
    if use_residual:
        print(f"\n{'='*70}")
        print("RESIDUAL MODEL CORRECTION")
        print(f"{'='*70}")

        # Discover all repos with v15 + opus data
        base_eval_dir = os.path.dirname(eval_dir)
        all_repos = [d for d in os.listdir(base_eval_dir)
                     if os.path.isdir(os.path.join(base_eval_dir, d))
                     and d != repo_name]  # exclude current repo to avoid leakage

        model = train_residual_model(eval_dir, all_repos)
        if model is not None:
            n_corrected = apply_residual_corrections(output_commits, model)
            print(f"  Applied residual corrections to {n_corrected} commits")

            # Show correction stats
            corrections = [c.get('residual_correction', 0) for c in output_commits
                           if 'residual_correction' in c]
            if corrections:
                print(f"  Residual stats: mean={np.mean(corrections):.3f}h, "
                      f"std={np.std(corrections):.3f}h, "
                      f"min={min(corrections):.3f}h, max={max(corrections):.3f}h")
        else:
            print("  Residual model not available, skipping")

    # Step 11: Optional isotonic calibration (v19)
    if use_isotonic:
        print(f"\n{'='*70}")
        print("ISOTONIC CALIBRATION (v19)")
        print(f"{'='*70}")

        iso_models = load_isotonic_models(eval_dir)
        if iso_models is not None:
            n_calibrated = apply_isotonic_calibration(output_commits, iso_models)
            print(f"  Applied isotonic calibration to {n_calibrated} commits")

            # Show calibration stats
            deltas = [c['estimated_hours'] - c['pre_isotonic_hours'] for c in output_commits
                      if 'pre_isotonic_hours' in c]
            if deltas:
                print(f"  Calibration deltas: mean={np.mean(deltas):.3f}h, "
                      f"std={np.std(deltas):.3f}h, "
                      f"min={min(deltas):.3f}h, max={max(deltas):.3f}h")

            # Scope breakdown
            scope_counts = {}
            for c in output_commits:
                s = c.get('isotonic_model_used', '?')
                scope_counts[s] = scope_counts.get(s, 0) + 1
            print(f"  Models used: {scope_counts}")
        else:
            print("  Isotonic models not available, skipping")

    # Summary
    estimates = [c['estimated_hours'] for c in output_commits]
    print(f"\n{'='*70}")
    print("SUMMARY")
    print(f"{'='*70}")
    print(f"Commits evaluated: {len(output_commits)}")
    print(f"Methods: {methods_used}")
    print(f"Rules applied: {rules_applied}")
    print(f"Complexity guards: {complexity_guards_applied}")
    total_tok = total_llm_stats['prompt_tokens'] + total_llm_stats['completion_tokens']
    input_cost = total_llm_stats['prompt_tokens'] / 1e6 * OPENROUTER_INPUT_PRICE
    output_cost = total_llm_stats['completion_tokens'] / 1e6 * OPENROUTER_OUTPUT_PRICE
    total_cost = input_cost + output_cost
    total_llm_stats['openrouter_cost_usd'] = round(total_cost, 4)
    print(f"LLM stats: {total_llm_stats['calls']} calls, "
          f"{total_llm_stats['prompt_tokens']} prompt + {total_llm_stats['completion_tokens']} completion = {total_tok} tokens, "
          f"{total_llm_stats['total_duration_ms']/1000:.0f}s total")
    print(f"OpenRouter cost (Qwen2.5-Coder-32B): ${input_cost:.4f} input + ${output_cost:.4f} output = ${total_cost:.4f}")
    print(f"Estimate distribution:")
    print(f"  min={min(estimates):.1f}, max={max(estimates):.1f}, "
          f"mean={np.mean(estimates):.1f}, median={np.median(estimates):.1f}")

    scopes = {}
    for c in output_commits:
        scope = c.get('routed_to', '?')
        if scope not in scopes:
            scopes[scope] = []
        scopes[scope].append(c['estimated_hours'])
    print(f"\nBy scope:")
    for scope, ests in sorted(scopes.items()):
        print(f"  {scope:10s}: n={len(ests)}, mean={np.mean(ests):.1f}h, "
              f"median={np.median(ests):.1f}h")

    # Save results
    if use_isotonic:
        method_name = 'v19-isotonic'
        pipeline_desc = 'v19 (v18 + per-scope isotonic calibration)'
        out_filename = 'qwen2.5-coder-32b-v19-isotonic.json'
    else:
        method_name = 'v18-simple-module-no-bias'
        pipeline_desc = 'v18 (v17 + module: simple-only, no decomp ensemble, no MODULE_BIAS)'
        out_filename = 'qwen2.5-coder-32b-v18-simple-module.json'

    output = {
        'model': 'qwen2.5-coder:32b',
        'method': method_name,
        'evaluation_date': datetime.now().strftime('%Y-%m-%d'),
        'pipeline': pipeline_desc,
        'module_bias': 0,
        'residual_model': use_residual,
        'isotonic_calibration': use_isotonic,
        'repository': data.get('repository', repo_name),
        'language': lang,
        'n_commits': len(output_commits),
        'methods_used': methods_used,
        'rules_applied': rules_applied,
        'complexity_guards_applied': complexity_guards_applied,
        'llm_stats': total_llm_stats,
        'commits': output_commits,
    }

    outpath = os.path.join(eval_dir, out_filename)
    with open(outpath, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\nSaved: {outpath}")
    print(f"Completed: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")


if __name__ == '__main__':
    main()
