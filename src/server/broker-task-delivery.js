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
  sleep = defaultSleep,
} = {}) {
  if (!targetId || typeof isOnline !== 'function') return { ok: false, error: 'invalid_participant_check' };
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (await isOnline(targetId)) return { ok: true, targetId };
    await sleep(intervalMs);
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
  sleep = defaultSleep,
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
    });
    if (!online.ok) return online;
  }

  const delivery = await brokerClient.sendTo(targetId, kind, request);
  if (!isBrokerDeliverySuccessful(delivery, targetId)) {
    return { ok: false, error: 'delivery_failed', targetId, delivery };
  }
  return { ok: true, targetId, delivery };
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
