import { shutdownSleep } from './server-operation-lifetime.js';
import{types}from'node:util';
const asyncFunctionPrototype=Object.getPrototypeOf(async function(){}),applyOriginal=Reflect.apply;
const guardFailures=new WeakSet(),markGuardFailure=guardFailures.add.bind(guardFailures),isGuardFailure=guardFailures.has.bind(guardFailures);
export function isBrokerDeliveryGuardFailure(error){return error&&typeof error==='object'&&isGuardFailure(error);}
function guardFailure(error){const actual=error&&typeof error==='object'?error:new Error('TASK_DELIVERY_ADMISSION_REFUSED',{cause:error});markGuardFailure(actual);return actual;}
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
  beforeSend,
  onGuardTail,
} = {}) {
  const sendTo=brokerClient?.sendTo;
  if (!brokerClient || typeof sendTo !== 'function') {
    return { ok: false, error: 'broker_unavailable' };
  }
  if (!targetId || !kind || !request) return { ok: false, error: 'invalid_delivery_request' };
  if(beforeSend!==undefined&&(typeof beforeSend!=='function'||typeof onGuardTail!=='function'))throw guardFailure(Error('BROKER_DELIVERY_GUARD_OWNER_REQUIRED'));
  if(beforeSend&&(types.isProxy(beforeSend)||types.isAsyncFunction(beforeSend)||Object.getPrototypeOf(beforeSend)===asyncFunctionPrototype))throw guardFailure(Error('BROKER_DELIVERY_SYNCHRONOUS_GUARD_REQUIRED'));

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
  const sendArguments=[targetId,kind,request];
  if(beforeSend){
    try{
      const result=beforeSend();
      if(result!==undefined){const error=guardFailure(Error('BROKER_DELIVERY_SYNCHRONOUS_GUARD_REQUIRED'));try{onGuardTail(result,error);}catch(cause){Object.defineProperty(error,'cause',{value:cause,configurable:true});}throw error;}
    }catch(error){throw guardFailure(error);}
  }
  signal?.throwIfAborted();
  const delivery = await applyOriginal(sendTo,brokerClient,sendArguments);
  signal?.throwIfAborted();
  if (!isBrokerDeliverySuccessful(delivery, targetId)) {
    return { ok: false, error: 'delivery_failed', targetId, delivery };
  }
  return { ok: true, targetId, delivery };
}
