import { shutdownSleep } from './server-operation-lifetime.js';
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_WAIT_INTERVAL_MS = 100;

export function isBrokerDeliverySuccessful(delivery = {}, targetId) {
  const online = Array.isArray(delivery.onlineRecipients) ? delivery.onlineRecipients : [];
  const offline = Array.isArray(delivery.offlineRecipients) ? delivery.offlineRecipients : [];
  return Number(delivery.deliveredCount || 0) > 0 && online.includes(targetId) && !offline.includes(targetId);
}

export async function waitForParticipantOnline({
  targetId,
  isOnline,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  intervalMs = DEFAULT_WAIT_INTERVAL_MS,
  sleep = shutdownSleep,
  signal,
} = {}) {
  if (!targetId || typeof isOnline !== 'function') return { ok: false, error: 'invalid_participant_check' };
  signal?.throwIfAborted();
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    signal?.throwIfAborted();
    const online = await isOnline(targetId);
    signal?.throwIfAborted();
    if (online) return { ok: true, targetId };
    await sleep(intervalMs, signal);
  }
  return { ok: false, error: 'participant_offline', targetId };
}

export async function sendTaskToBrokerParticipant({
  brokerClient,
  targetId,
  kind,
  request,
  isOnline,
  waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  waitIntervalMs = DEFAULT_WAIT_INTERVAL_MS,
  sleep = shutdownSleep,
  signal,
} = {}) {
  if (!brokerClient || typeof brokerClient.sendTo !== 'function') {
    return { ok: false, error: 'broker_unavailable' };
  }
  if (!targetId || !kind || !request) return { ok: false, error: 'invalid_delivery_request' };

  if (typeof isOnline === 'function') {
    const online = await waitForParticipantOnline({
      targetId,
      isOnline,
      timeoutMs: waitTimeoutMs,
      intervalMs: waitIntervalMs,
      sleep,
      signal,
    });
    if (!online.ok) return online;
  }

  signal?.throwIfAborted();
  const delivery = await brokerClient.sendTo(targetId, kind, request);
  signal?.throwIfAborted();
  if (!isBrokerDeliverySuccessful(delivery, targetId)) {
    return { ok: false, error: 'delivery_failed', targetId, delivery };
  }
  return { ok: true, targetId, delivery };
}
