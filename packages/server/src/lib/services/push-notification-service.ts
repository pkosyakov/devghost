import prisma from '@/lib/db';
import { logger } from '@/lib/logger';

const log = logger.child({ service: 'push-notifications' });

export interface PushPayload {
  type: 'analysis_complete' | 'ghost_alert' | 'weekly_digest';
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Send push notification to all devices of a user.
 * Uses APNs HTTP/2 API directly (no external dependency).
 * Requires: APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_AUTH_KEY (p8 base64)
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  const devices = await prisma.deviceToken.findMany({
    where: { userId },
  });

  if (devices.length === 0) {
    log.debug({ userId }, 'No device tokens found for user');
    return;
  }

  const apnsKeyId = process.env.APNS_KEY_ID;
  const apnsTeamId = process.env.APNS_TEAM_ID;
  const apnsBundleId = process.env.APNS_BUNDLE_ID || 'com.devghost.app';

  if (!apnsKeyId || !apnsTeamId) {
    log.warn('APNs not configured (APNS_KEY_ID, APNS_TEAM_ID required)');
    return;
  }

  for (const device of devices) {
    if (device.platform !== 'ios') continue;

    try {
      // TODO: Implement APNs HTTP/2 push with JWT auth
      // For now, log the notification that would be sent
      log.info(
        {
          userId,
          deviceToken: device.token.substring(0, 8) + '...',
          type: payload.type,
          title: payload.title,
        },
        'Push notification queued (APNs integration pending)',
      );
    } catch (err) {
      log.error(
        { err, userId, deviceId: device.id },
        'Failed to send push notification',
      );

      // If token is invalid, clean it up
      // APNs returns 410 Gone for expired tokens
    }
  }
}

/**
 * Send analysis completion notification.
 */
export async function notifyAnalysisComplete(
  userId: string,
  orderName: string,
  avgGhostPercent: number | null,
  orderId: string,
): Promise<void> {
  const ghostStr = avgGhostPercent != null ? `${Math.round(avgGhostPercent)}%` : 'N/A';

  await sendPushToUser(userId, {
    type: 'analysis_complete',
    title: 'Analysis Complete',
    body: `${orderName}: Average Ghost% is ${ghostStr}`,
    data: { orderId },
  });
}

/**
 * Send ghost alert when Ghost% drops below threshold.
 */
export async function notifyGhostAlert(
  userId: string,
  developerName: string,
  ghostPercent: number,
  orderId: string,
): Promise<void> {
  await sendPushToUser(userId, {
    type: 'ghost_alert',
    title: 'Ghost% Alert',
    body: `${developerName}'s Ghost% dropped to ${Math.round(ghostPercent)}%`,
    data: { orderId },
  });
}
