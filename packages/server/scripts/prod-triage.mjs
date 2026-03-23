#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CRON_ENV_KEY = 'CRON_SECRET';
const DEFAULT_BASE_URL = 'https://devghost.pro';
const DEFAULT_STUCK_LIMIT = 3;
const DEFAULT_EVENTS_LIMIT = 50;
const VERCEL_BIN = process.platform === 'win32' ? 'vercel.cmd' : 'vercel';

function parseArgs(argv) {
  const options = {
    url: DEFAULT_BASE_URL,
    orderId: null,
    stuckLimit: DEFAULT_STUCK_LIMIT,
    eventsLimit: DEFAULT_EVENTS_LIMIT,
    noPull: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') {
      options.url = argv[i + 1] ?? options.url;
      i += 1;
      continue;
    }
    if (arg === '--order') {
      options.orderId = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === '--stuck-limit') {
      const value = Number.parseInt(argv[i + 1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) {
        options.stuckLimit = value;
      }
      i += 1;
      continue;
    }
    if (arg === '--events-limit') {
      const value = Number.parseInt(argv[i + 1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) {
        options.eventsLimit = value;
      }
      i += 1;
      continue;
    }
    if (arg === '--no-pull') {
      options.noPull = true;
      continue;
    }
  }

  return options;
}

async function findRepoRoot(startDir) {
  let current = startDir;
  for (;;) {
    const vercelProject = path.join(current, '.vercel', 'project.json');
    try {
      await fs.access(vercelProject);
      return current;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return startDir;
}

async function readEnvFile(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith(`${CRON_ENV_KEY}=`)) continue;
    let value = line.slice(`${CRON_ENV_KEY}=`.length).trim();
    value = value.replace(/^['"]/, '').replace(/['"]$/, '');
    if (value) return value;
  }
  return null;
}

async function loadCronSecret({ noPull }, repoRoot) {
  const fromEnv = process.env[CRON_ENV_KEY]?.trim();
  if (fromEnv) {
    return { value: fromEnv, source: 'env' };
  }

  if (noPull) {
    throw new Error(
      `${CRON_ENV_KEY} is missing in shell env and --no-pull was set.`,
    );
  }

  const tempFile = path.join(
    os.tmpdir(),
    `devghost-prod-env-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );

  try {
    await execFileAsync(
      VERCEL_BIN,
      ['env', 'pull', tempFile, '--environment=production', '--yes'],
      {
        cwd: repoRoot,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        shell: process.platform === 'win32',
      },
    );
    const secret = await readEnvFile(tempFile);
    if (!secret) {
      throw new Error(
        `${CRON_ENV_KEY} was not found in pulled production environment.`,
      );
    }
    return { value: secret, source: 'vercel-env-pull' };
  } finally {
    await fs.rm(tempFile, { force: true });
  }
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { response, text, body };
}

function printCheckSummary(check) {
  console.log(`  - [${check.status.toUpperCase()}] ${check.id}: ${check.summary}`);
  if (check.details) {
    console.log(`    ${check.details}`);
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = await findRepoRoot(process.cwd());
  const baseUrl = args.url.replace(/\/$/, '');
  const { value: cronSecret, source } = await loadCronSecret(args, repoRoot);

  console.log(`[triage] baseUrl=${baseUrl}`);
  console.log(`[triage] auth=${source}`);

  const live = await fetchJson(`${baseUrl}/api/health`);
  console.log(`[health] status=${live.response.status} body=${live.text}`);

  const monitoring = await fetchJson(`${baseUrl}/api/admin/monitoring`, {
    Authorization: `Bearer ${cronSecret}`,
  });

  if (!monitoring.response.ok || !monitoring.body?.success) {
    throw new Error(
      `Monitoring API failed: HTTP ${monitoring.response.status}, body=${monitoring.text}`,
    );
  }

  const pipeline = monitoring.body.data?.pipeline;
  const counts = pipeline?.counts ?? { pass: 0, warn: 0, fail: 0 };
  const checks = Array.isArray(pipeline?.checks) ? pipeline.checks : [];
  const stuckJobs = Array.isArray(pipeline?.stuckJobs) ? pipeline.stuckJobs : [];

  console.log(`[monitoring] pass=${counts.pass} warn=${counts.warn} fail=${counts.fail}`);

  const notPassChecks = checks.filter((check) => check.status !== 'pass');
  if (notPassChecks.length > 0) {
    console.log('[monitoring] non-pass checks:');
    for (const check of notPassChecks) {
      printCheckSummary(check);
    }
  } else {
    console.log('[monitoring] all checks are PASS');
  }

  console.log(`[monitoring] stuck_jobs=${stuckJobs.length}`);

  const targets = [];
  if (args.orderId) {
    targets.push({ orderId: args.orderId, jobId: null, source: 'explicit-order' });
  } else {
    for (const job of stuckJobs.slice(0, args.stuckLimit)) {
      targets.push({ orderId: job.orderId, jobId: job.id, source: 'stuck-job' });
    }
  }

  if (targets.length === 0) {
    console.log('[diagnostics] no targets to inspect');
    return;
  }

  console.log(`[diagnostics] targets=${targets.length}`);
  for (const target of targets) {
    const query = new URLSearchParams();
    query.set('includeLog', '0');
    query.set('eventsLimit', String(args.eventsLimit));
    if (target.jobId) query.set('jobId', target.jobId);

    const url = `${baseUrl}/api/admin/orders/${target.orderId}/diagnostics?${query.toString()}`;
    const diagnostics = await fetchJson(url, {
      Authorization: `Bearer ${cronSecret}`,
    });

    if (!diagnostics.response.ok || !diagnostics.body?.success) {
      console.log(
        `[diagnostics] order=${target.orderId} source=${target.source} failed HTTP=${diagnostics.response.status}`,
      );
      console.log(diagnostics.text);
      continue;
    }

    const data = diagnostics.body.data;
    const order = data.order;
    const job = data.job;
    const info = data.diagnostics;
    const missing = Array.isArray(info?.missingAtomicSteps) ? info.missingAtomicSteps : [];
    const latestCode = job?.latestEvent?.code ?? 'n/a';
    const latestLevel = job?.latestEvent?.level ?? 'n/a';

    console.log(
      [
        `[diagnostics] order=${order?.id ?? target.orderId}`,
        `status=${order?.status ?? 'n/a'}`,
        `job=${job?.id ?? 'n/a'}`,
        `job_status=${job?.status ?? 'n/a'}`,
        `pendingTooLong=${Boolean(info?.pendingTooLong)}`,
        `heartbeatCritical=${Boolean(info?.heartbeatCritical)}`,
        `postProcessingStale=${Boolean(info?.postProcessingStale)}`,
        `missingSteps=${missing.length > 0 ? missing.join(',') : 'none'}`,
        `latestEvent=${latestLevel}:${latestCode}`,
      ].join(' '),
    );
  }
}

run().catch((error) => {
  console.error(`[triage] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
