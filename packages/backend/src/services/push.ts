import webpush from 'web-push';
import { listPushSubscriptions, removePushSubscription, touchPushSubscription } from './db.js';
import { registry } from './ws.js';
import { currentTenant } from '../tenancy/context.js';

export interface PushPayload {
  title: string;
  body: string;
  threadId?: string;
  tag?: string;
  url?: string;
}

export class PushService {
  private configured = false;
  /** Tenant mode only: this tenant's own VAPID details, passed with every send. web-push's setVapidDetails is one global for the whole process,
   *  so a tenant's service never calls it (a second tenant would overwrite the first's keys); null with tenancy off. */
  private tenantVapid: { subject: string; publicKey: string; privateKey: string } | null = null;

  constructor(vapidPublic?: string, vapidPrivate?: string, vapidContact?: string) {
    if (vapidPublic && vapidPrivate && vapidContact) {
      if (currentTenant()) {
        this.tenantVapid = { subject: vapidContact, publicKey: vapidPublic, privateKey: vapidPrivate };
      } else {
        webpush.setVapidDetails(vapidContact, vapidPublic, vapidPrivate);
      }
      this.configured = true;
      console.log('PushService: VAPID configured');
    } else {
      console.log('PushService: VAPID keys not set — push disabled');
    }
  }

  isConfigured(): boolean {
    return this.configured;
  }

  getVapidPublicKey(): string | null {
    if (this.tenantVapid) return this.tenantVapid.publicKey;
    return this.configured ? process.env.VAPID_PUBLIC_KEY || null : null;
  }

  /** Send push to all web_push subscriptions */
  async sendPush(payload: PushPayload): Promise<void> {
    if (!this.configured) return;

    const subscriptions = listPushSubscriptions();
    if (subscriptions.length === 0) return;

    const jsonPayload = JSON.stringify(payload);

    const results = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        if (!sub.endpoint || !sub.keys_p256dh || !sub.keys_auth) return;

        try {
          const target: webpush.PushSubscription = { endpoint: sub.endpoint, keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth } };
          // Tenancy off: the call exactly as it always was (the global VAPID details). Tenant mode: this tenant's own, per call.
          if (this.tenantVapid) await webpush.sendNotification(target, jsonPayload, { vapidDetails: this.tenantVapid });
          else await webpush.sendNotification(target, jsonPayload);
          touchPushSubscription(sub.endpoint);
        } catch (err: unknown) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 410 || statusCode === 404) {
            // Subscription expired or invalid — remove it
            console.log(`PushService: removing expired subscription ${sub.endpoint.slice(0, 50)}...`);
            removePushSubscription(sub.endpoint);
          } else {
            console.error(`PushService: failed to send to ${sub.endpoint.slice(0, 50)}...`, err);
          }
        }
      })
    );

    const sent = results.filter(r => r.status === 'fulfilled').length;
    console.log(`PushService: sent ${sent}/${subscriptions.length} push notifications`);
  }

  /** Send push only when user has no active WebSocket connections */
  async sendIfOffline(payload: PushPayload): Promise<void> {
    if (!registry.isUserConnected()) {
      await this.sendPush(payload);
    }
  }

  /** Always send push regardless of connection state (for time-critical items) */
  async sendAlways(payload: PushPayload): Promise<void> {
    await this.sendPush(payload);
  }
}
