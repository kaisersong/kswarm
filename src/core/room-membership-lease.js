/**
 * Membership-use lease gate (design §8.5, §9.2).
 *
 * Every room-linked dispatch / PO change / member add / review / rework /
 * cancel that assigns work to a room agent must acquire a membership-use
 * lease from the broker BEFORE acting. Leases are bound to one
 * (roomId, logicalAgentId, operationId) triple and expire after 30s; they
 * cannot be replayed against another room, agent or operation.
 */

function roomContractError(code, extra = {}) {
  const error = new Error(code);
  error.code = code;
  for (const [key, value] of Object.entries(extra)) {
    error[key] = value;
  }
  return error;
}

function isLeaseExpired(lease, now = new Date()) {
  const expiresAt = new Date(lease?.expiresAt ?? 0).getTime();
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

export async function acquireRoomLeaseForOperation({
  brokerClient,
  primaryRoomId,
  logicalAgentId,
  operationId,
}) {
  const acquire = async () => {
    const result = await brokerClient.acquireRoomMembershipLease({
      roomId: primaryRoomId,
      logicalAgentId,
      operationId,
    });
    if (!result || result.ok === false) {
      throw roomContractError('room_membership_lease_required', {
        cause: result?.code ?? 'room_membership_lease_required',
      });
    }
    return result.lease;
  };

  const lease = await acquire();
  if (isLeaseExpired(lease)) {
    // one retry for a lease the broker handed out already expired, then fail
    const retried = await acquire();
    if (isLeaseExpired(retried)) {
      throw roomContractError('room_membership_lease_expired', { lease: retried });
    }
    return retried;
  }
  return lease;
}

export function assertRoomLeaseMatchesOperation({
  lease,
  primaryRoomId,
  logicalAgentId,
  operationId,
}) {
  const matches = lease
    && lease.roomId === primaryRoomId
    && lease.logicalAgentId === logicalAgentId
    && lease.operationId === operationId;
  if (!matches) {
    throw roomContractError('room_actor_identity_mismatch', {
      leaseRoomId: lease?.roomId,
      leaseLogicalAgentId: lease?.logicalAgentId,
      leaseOperationId: lease?.operationId,
    });
  }
  if (isLeaseExpired(lease)) {
    throw roomContractError('room_membership_lease_expired');
  }
  return true;
}
