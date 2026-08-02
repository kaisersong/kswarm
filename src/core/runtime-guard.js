/**
 * runtime-guard — explicit Node runtime floor probe.
 *
 * The durable SQLite backend relies on `node:sqlite` (DatabaseSync) which is only
 * guaranteed on the Node 22.22.x runtime validated for the packaged Electron
 * sidecar. We probe explicitly at startup rather than relying on the npm
 * `engines` warning (which never blocks execution).
 */

export const NODE_VERSION_FLOOR = '22.22.0';

function parse(version) {
  const clean = String(version || '').trim().replace(/^v/, '');
  const [core] = clean.split('-');
  const parts = core.split('.').map(n => Number.parseInt(n, 10));
  return {
    major: Number.isFinite(parts[0]) ? parts[0] : 0,
    minor: Number.isFinite(parts[1]) ? parts[1] : 0,
    patch: Number.isFinite(parts[2]) ? parts[2] : 0,
  };
}

export function isNodeVersionAtLeast(current, floor = NODE_VERSION_FLOOR) {
  const c = parse(current);
  const f = parse(floor);
  if (c.major !== f.major) return c.major > f.major;
  if (c.minor !== f.minor) return c.minor > f.minor;
  return c.patch >= f.patch;
}

export function assertNodeRuntime(current = process.versions.node, floor = NODE_VERSION_FLOOR) {
  if (!isNodeVersionAtLeast(current, floor)) {
    throw new Error(
      `[kswarm] Node ${current} is below the required floor ${floor}. ` +
      'The durable SQLite state backend requires node:sqlite from Node >= ' + floor + '.',
    );
  }
}
