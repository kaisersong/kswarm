/**
 * Runtime heartbeat manager — tracks agent liveness and auto-detects offline agents.
 *
 * Aligned with multica's daemon heartbeat pattern:
 * - Agents report heartbeats periodically (via task progress or explicit ping)
 * - Hub detects idle agents and marks them offline
 * - When agent comes back online, it can claim pending tasks
 */

const HEARTBEAT_INTERVAL_MS = 30_000;  // Agent should heartbeat every 30s
const OFFLINE_TIMEOUT_MS = 120_000;     // Mark offline after 120s of silence

export function createHeartbeatManager(hub, silent = false) {
  const lastSeen = new Map(); // agentId → timestamp
  let timer = null;

  function ping(agentId) {
    lastSeen.set(agentId, Date.now());
  }

  function getLastSeen(agentId) {
    return lastSeen.get(agentId) || null;
  }

  function checkLiveness() {
    const now = Date.now();
    const stale = [];

    for (const [agentId, ts] of lastSeen.entries()) {
      if (now - ts > OFFLINE_TIMEOUT_MS) {
        stale.push(agentId);
        lastSeen.delete(agentId);
      }
    }

    if (stale.length > 0 && !silent) {
      console.log(`[Heartbeat] ${stale.length} agent(s) went offline: ${stale.join(', ')}`);
    }

    return stale;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      const stale = checkLiveness();
      if (stale.length > 0) {
        // Broadcast to connected clients
        if (hub._broadcast) {
          hub._broadcast({ type: 'agents_offline', agentIds: stale });
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { ping, getLastSeen, checkLiveness, start, stop };
}
