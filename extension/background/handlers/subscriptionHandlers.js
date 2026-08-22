/**
 * Subscription lifecycle message handlers.
 */

'use strict';

import { validateRemoteHttpsUrl } from '../../core/remoteUrl.js';
import {
  getSubscriptions,
  setSubscriptionEnabled,
  refreshSubscription,
  addSubscription,
  removeSubscription
} from '../../subscriptions/manager.js';

const SUBSCRIPTION_ID_RE = /^[a-z0-9_-]{1,80}$/i;
const MAX_SUBSCRIPTION_NAME_LEN = 120;
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 24 * 30;

export function isValidSubscriptionId(id) {
  return typeof id === 'string' && SUBSCRIPTION_ID_RE.test(id);
}

export function validateCustomSubscriptionInput(sub) {
  if (!sub || typeof sub !== 'object' || Array.isArray(sub)) {
    return { ok: false, error: 'Invalid subscription' };
  }
  if (!isValidSubscriptionId(sub.id)) {
    return { ok: false, error: 'Invalid subscription ID' };
  }

  const validatedUrl = validateRemoteHttpsUrl(sub.url, { label: 'Subscription' });
  if (!validatedUrl.ok) return validatedUrl;
  const parsed = new URL(validatedUrl.url);

  const name = typeof sub.name === 'string' ? sub.name.trim().slice(0, MAX_SUBSCRIPTION_NAME_LEN) : parsed.hostname;
  const intervalHours = sub.intervalHours === undefined
    ? undefined
    : Number(sub.intervalHours);
  if (
    intervalHours !== undefined &&
    (!Number.isInteger(intervalHours) || intervalHours < MIN_INTERVAL_HOURS || intervalHours > MAX_INTERVAL_HOURS)
  ) {
    return { ok: false, error: 'Invalid refresh interval' };
  }

  return {
    ok: true,
    subscription: {
      id: sub.id,
      name: name || parsed.hostname,
      url: parsed.href,
      intervalHours
    }
  };
}

export async function handleSubscriptionGet() {
  return getSubscriptions();
}

export async function handleSubscriptionSet(msg) {
  if (!isValidSubscriptionId(msg.id) || typeof msg.enabled !== 'boolean') {
    return { ok: false, error: 'Invalid subscription update' };
  }
  return setSubscriptionEnabled(msg.id, msg.enabled);
}

export async function handleSubscriptionRefresh(msg) {
  if (!isValidSubscriptionId(msg.id)) return { ok: false, error: 'Invalid subscription ID' };
  return refreshSubscription(msg.id);
}

export async function handleSubscriptionAdd(msg) {
  const validation = validateCustomSubscriptionInput(msg.subscription);
  if (!validation.ok) return { ok: false, error: validation.error };
  return addSubscription(validation.subscription);
}

export async function handleSubscriptionRemove(msg) {
  if (!isValidSubscriptionId(msg.id)) return { ok: false, error: 'Invalid subscription ID' };
  return removeSubscription(msg.id);
}
