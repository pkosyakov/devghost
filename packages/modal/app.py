"""
Modal App definition for DevGhost analysis pipeline.

Defines the web endpoint for triggering analysis jobs.
"""
import os

import modal
from fastapi.responses import JSONResponse

app = modal.App("devghost-trigger")
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("fastapi[standard]")
)


# === Web endpoint for Vercel trigger ===

@app.function(
    image=image,
    secrets=[modal.Secret.from_name("devghost-llm")],  # includes MODAL_WEBHOOK_SECRET
)
@modal.fastapi_endpoint(method="POST")
def trigger(payload: dict):
    """HTTP trigger from Vercel. Validates shared secret, spawns async job."""
    if not isinstance(payload, dict):
        return JSONResponse({"error": "invalid_payload"}, status_code=400)

    auth_token = os.environ.get("MODAL_WEBHOOK_SECRET", "")
    provided = payload.get("auth_token", "")

    # SECURITY: Reject if secret is not configured or doesn't match.
    if not auth_token or provided != auth_token:
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    job_id = payload.get("job_id")
    if not job_id or not isinstance(job_id, str):
        return JSONResponse({"error": "missing_job_id"}, status_code=400)

    try:
        runner = modal.Function.from_name("devghost-worker", "run_analysis")
        call = runner.spawn(job_id)
        return {"status": "accepted", "modal_call_id": getattr(call, "object_id", None)}
    except Exception as err:
        return JSONResponse(
            {
                "error": "spawn_failed",
                "type": type(err).__name__,
                "detail": str(err)[:500],
            },
            status_code=500,
        )
