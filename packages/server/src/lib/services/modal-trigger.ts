import crypto from 'crypto';
import prisma from '@/lib/db';
import { analysisLogger } from '@/lib/logger';
import { appendJobEvent } from '@/lib/services/job-event-service';

const log = analysisLogger.child({ component: 'modal-trigger' });

/**
 * Trigger Modal webhook for a job. Returns true on success.
 * On success, replaces any existing modalCallId with the real call ID from Modal.
 */
export async function triggerModal(jobId: string): Promise<boolean> {
  const url = process.env.MODAL_ENDPOINT_URL;
  const secret = process.env.MODAL_WEBHOOK_SECRET;

  if (!url) {
    log.error({ jobId }, 'MODAL_ENDPOINT_URL not configured');
    return false;
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, auth_token: secret }),
    });

    if (resp.ok) {
      const data = await resp.json();
      await prisma.analysisJob.update({
        where: { id: jobId },
        data: { modalCallId: data.modal_call_id },
      });
      await appendJobEvent({
        jobId,
        phase: 'trigger',
        code: 'MODAL_TRIGGER_ACCEPTED',
        message: 'Modal job triggered successfully',
        payload: { modalCallId: data.modal_call_id },
      });
      return true;
    } else {
      await appendJobEvent({
        jobId,
        level: 'warn',
        phase: 'trigger',
        code: 'MODAL_TRIGGER_HTTP_FAIL',
        message: 'Modal trigger failed (HTTP)',
        payload: { httpStatus: resp.status },
      });
      log.warn({ jobId, status: resp.status }, 'Modal trigger failed');
      return false;
    }
  } catch (err) {
    await appendJobEvent({
      jobId,
      level: 'warn',
      phase: 'trigger',
      code: 'MODAL_TRIGGER_NETWORK_FAIL',
      message: 'Modal trigger network error',
      payload: { error: String(err) },
    });
    log.warn({ err, jobId }, 'Modal trigger network error');
    return false;
  }
}

/**
 * Atomically claim a trigger slot and fire Modal.
 * Returns true if this caller successfully triggered Modal.
 * Uses CAS (compare-and-swap) to prevent double-triggers.
 */
export async function claimAndTriggerModal(jobId: string): Promise<boolean> {
  const claimId = `triggering:${crypto.randomUUID()}`;

  const claimed = await prisma.analysisJob.updateMany({
    where: { id: jobId, status: 'PENDING', modalCallId: null },
    data: { modalCallId: claimId, updatedAt: new Date() },
  });

  if (claimed.count === 0) {
    log.info({ jobId }, 'Trigger claim failed (already claimed or status changed)');
    return false;
  }

  const success = await triggerModal(jobId);

  if (!success) {
    // Clear placeholder on trigger failure — only if we still own it
    await prisma.analysisJob.updateMany({
      where: { id: jobId, modalCallId: claimId },
      data: { modalCallId: null, updatedAt: new Date() },
    });
    await appendJobEvent({
      jobId,
      level: 'warn',
      phase: 'trigger',
      code: 'TRIGGER_CLAIM_CLEARED',
      message: 'Trigger claim cleared after modal trigger failure',
    });
  }

  return success;
}
