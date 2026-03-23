# DevGhost Modal Worker

Serverless analysis pipeline running on [Modal](https://modal.com).

## Setup

1. Install Modal: `pip install modal`
2. Authenticate: `modal token new`
3. Create secrets:
   ```bash
   modal secret create devghost-db DIRECT_URL="postgresql://..."
   modal secret create devghost-llm OPENROUTER_API_KEY="..." MODAL_WEBHOOK_SECRET="..." LLM_MAX_QPS="5"
   modal secret create devghost-worker-tuning \
     DEMO_LIVE_CHUNK_SIZE="10" \
     LAST_N_SHALLOW_INITIAL_DAYS="30" \
     LAST_N_SHALLOW_MAX_DAYS="3650" \
     LAST_N_SHALLOW_GROWTH_FACTOR="2" \
     REPO_VOLUME_CHECKPOINTS="1" \
     GIT_PARTIAL_CLONE="1" \
     GIT_SHALLOW_BUFFER_DAYS="14" \
     GIT_FETCH_TIMEOUT_SEC="600" \
     GIT_CLONE_TIMEOUT_SEC="1800" \
     GIT_LOG_TIMEOUT_SEC="300"
   ```

## Deploy

```bash
cd packages/modal
modal deploy worker.py   # deploys devghost-worker (run_analysis)
modal deploy app.py      # deploys devghost-trigger (public trigger endpoint)
```

Use the endpoint URL from `modal deploy app.py` output as `MODAL_ENDPOINT_URL`
in Vercel/server env.

## Local Development

```bash
modal serve app.py  # Hot-reload trigger endpoint
```

## Architecture

- `app.py` — lightweight trigger app (`devghost-trigger`)
- `worker.py` — heavy analysis worker app (`devghost-worker`)
- `runtime_worker.py` — worker image/volume/runtime objects
- `git_ops.py` — Git clone/update/extract (Python port of git-operations.ts)
- `db.py` — Supabase connection and query helpers (raw SQL via psycopg2)
- `rate_limiter.py` — OpenRouter QPS limiter

Pipeline scripts are mounted from `../server/scripts/pipeline/` at runtime.
