"""
Runtime objects for heavy background analysis worker app.
"""
import os

import modal

app = modal.App("devghost-worker")

repos_volume = modal.Volume.from_name("devghost-repos", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        "fastapi[standard]",  # Required for web trigger app
        "psycopg2-binary",    # Direct Supabase connection
        "requests",           # OpenRouter API calls
        "numpy>=1.24",        # Required by run_v16_pipeline.py
        "scikit-learn>=1.3",  # Required by run_v16_pipeline.py
    )
    .run_commands(
        # CVE-2024-32002 mitigation: prevent symlink-based RCE
        "git config --system protocol.file.allow never",
        "git config --system core.symlinks false",
    )
    .add_local_dir(
        os.path.dirname(__file__),
        remote_path="/app/modal",
    )
    .add_local_dir(
        os.path.join(os.path.dirname(__file__), "..", "server", "scripts", "pipeline"),
        remote_path="/app/pipeline",
    )
)
