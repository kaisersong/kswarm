#!/usr/bin/env node
/**
 * KSwarm Service Guardian (守护进程)
 *
 * 持续监控 broker / server / vite 三个服务的健康状态，
 * 任何一个挂掉时自动重启。
 *
 * Usage:
 *   node scripts/guardian.js          # 前台运行，看日志
 *   node scripts/guardian.js --daemon  # 后台运行
 *
 * 停止:
 *   kill $(cat ~/.kswarm/guardian.pid)
 *   或: node scripts/guardian.js --stop
 */

import { spawn, execSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Config ──────────────────────────────────────────────────────────────────

const KSWARM_HOME = join(homedir(), '.kswarm');
const PID_FILE = join(KSWARM_HOME, 'guardian.pid');
const LOG_FILE = join(KSWARM_HOME, 'guardian.log');
mkdirSync(KSWARM_HOME, { recursive: true });

const KSWARM_ROOT = join(import.meta.dirname, '..');
const BROKER_ROOT = process.env.BROKER_ROOT || join(homedir(), 'projects/intent-broker');

const CHECK_INTERVAL = 5000;  // 5s between health checks
const RESTART_COOLDOWN = 10000; // 10s cooldown after restart before next check
const MAX_RESTARTS = 10; // max restarts per service within window
const RESTART_WINDOW = 300000; // 5min window for max restart count

const SERVICES = {
  broker: {
    name: 'intent-broker',
    port: 4318,
    healthUrl: 'http://127.0.0.1:4318/health',
    cwd: BROKER_ROOT,
    cmd: 'node',
    args: ['--experimental-sqlite', 'src/cli.js'],
    startOrder: 1,
  },
  server: {
    name: 'kswarm-server',
    port: 4400,
    healthUrl: 'http://127.0.0.1:4400/health',
    cwd: KSWARM_ROOT,
    cmd: 'node',
    args: ['src/server/index.js'],
    startOrder: 2,
    dependsOn: 'broker',
  },
  vite: {
    name: 'vite-dev',
    port: 5188,
    healthUrl: 'http://localhost:5188/',
    cwd: join(KSWARM_ROOT, 'web'),
    cmd: 'npx',
    args: ['vite', '--port', '5188'],
    startOrder: 3,
  },
};

// ─── State ───────────────────────────────────────────────────────────────────

const state = {};
for (const [id, svc] of Object.entries(SERVICES)) {
  state[id] = { proc: null, restarts: [], status: 'stopped', lastCheck: 0 };
}

let running = true;

// ─── Logging ─────────────────────────────────────────────────────────────────

function logSync(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { writeFileSync(LOG_FILE, line + '\n', { flag: 'a' }); } catch {}
}

// ─── Health Check ────────────────────────────────────────────────────────────

async function checkHealth(url, timeout = 3000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Service Management ──────────────────────────────────────────────────────

function startService(id) {
  const svc = SERVICES[id];
  const s = state[id];

  // Check restart throttle
  const now = Date.now();
  s.restarts = s.restarts.filter(t => now - t < RESTART_WINDOW);
  if (s.restarts.length >= MAX_RESTARTS) {
    logSync(`⛔ ${svc.name}: too many restarts (${MAX_RESTARTS} in ${RESTART_WINDOW / 1000}s), giving up`);
    s.status = 'failed';
    return false;
  }

  // Kill any leftover process on the port
  try {
    const pids = execSync(`lsof -ti:${svc.port} 2>/dev/null`).toString().trim();
    if (pids) {
      execSync(`kill -9 ${pids.split('\n').join(' ')} 2>/dev/null`);
      logSync(`  killed leftover pids on port ${svc.port}`);
    }
  } catch {}

  logSync(`🚀 Starting ${svc.name}...`);

  const proc = spawn(svc.cmd, svc.args, {
    cwd: svc.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,  // Detach child so killing it doesn't propagate to guardian
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  proc.unref(); // Don't let child keep guardian alive

  // Capture stderr for crash diagnostics
  let lastStderr = '';
  proc.stderr?.on('data', (chunk) => {
    lastStderr = chunk.toString().slice(-500);
  });
  proc.stdout?.on('data', () => {}); // drain stdout

  proc.on('exit', (code, signal) => {
    if (!running) return;
    logSync(`💀 ${svc.name} exited (code=${code}, signal=${signal})`);
    if (lastStderr) logSync(`  stderr: ${lastStderr.trim().slice(0, 200)}`);
    s.proc = null;
    s.status = 'crashed';
  });

  s.proc = proc;
  s.status = 'starting';
  s.restarts.push(now);
  s.lastCheck = now + RESTART_COOLDOWN; // skip checks during cooldown

  return true;
}

function stopService(id) {
  const s = state[id];
  if (s.proc) {
    s.proc.kill('SIGTERM');
    setTimeout(() => { if (s.proc) s.proc.kill('SIGKILL'); }, 3000);
    s.proc = null;
  }
  s.status = 'stopped';
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function checkAndRestart() {
  const sorted = Object.entries(SERVICES).sort((a, b) => a[1].startOrder - b[1].startOrder);

  for (const [id, svc] of sorted) {
    const s = state[id];
    if (s.status === 'failed') continue; // gave up on this one
    if (Date.now() < s.lastCheck) continue; // in cooldown

    const healthy = await checkHealth(svc.healthUrl);

    if (healthy) {
      if (s.status !== 'running') {
        logSync(`✅ ${svc.name} is healthy`);
        s.status = 'running';
      }
    } else {
      // Not healthy — restart
      if (s.status === 'running' || s.status === 'crashed' || s.status === 'stopped') {
        logSync(`❌ ${svc.name} is DOWN — restarting...`);

        // Check dependency first
        if (svc.dependsOn && state[svc.dependsOn].status !== 'running') {
          logSync(`  waiting for dependency: ${svc.dependsOn}`);
          continue;
        }

        startService(id);
      }
    }
  }
}

async function mainLoop() {
  logSync('═══ KSwarm Guardian started ═══');
  writeFileSync(PID_FILE, String(process.pid));

  // Initial start of all services
  const sorted = Object.entries(SERVICES).sort((a, b) => a[1].startOrder - b[1].startOrder);
  for (const [id, svc] of sorted) {
    startService(id);
    // Wait a bit between service starts for dependencies
    await sleep(3000);
  }

  // Health check loop
  while (running) {
    await sleep(CHECK_INTERVAL);
    await checkAndRestart();
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── CLI Commands ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--stop')) {
  if (existsSync(PID_FILE)) {
    const pid = readFileSync(PID_FILE, 'utf-8').trim();
    try {
      process.kill(Number(pid), 'SIGTERM');
      unlinkSync(PID_FILE);
      console.log(`Guardian (pid ${pid}) stopped`);
    } catch (err) {
      console.log(`Could not kill pid ${pid}: ${err.message}`);
      unlinkSync(PID_FILE);
    }
  } else {
    console.log('No guardian running (no pid file)');
  }
  process.exit(0);
}

if (args.includes('--status')) {
  (async () => {
    console.log('KSwarm Service Status:\n');
    for (const [id, svc] of Object.entries(SERVICES)) {
      const ok = await checkHealth(svc.healthUrl);
      console.log(`  ${ok ? '✅' : '❌'} ${svc.name.padEnd(15)} port:${svc.port}  ${ok ? 'healthy' : 'DOWN'}`);
    }
    console.log('');
    if (existsSync(PID_FILE)) {
      const pid = readFileSync(PID_FILE, 'utf-8').trim();
      try { process.kill(Number(pid), 0); console.log(`Guardian running (pid ${pid})`); }
      catch { console.log('Guardian not running (stale pid file)'); }
    } else {
      console.log('Guardian not running');
    }
  })();
} else if (args.includes('--daemon')) {
  // Daemonize: spawn self detached
  const child = spawn(process.execPath, [import.meta.filename], {
    cwd: KSWARM_ROOT,
    stdio: 'ignore',
    detached: true,
    env: process.env,
  });
  child.unref();
  console.log(`Guardian daemonized (pid ${child.pid})`);
  console.log(`Log: ${LOG_FILE}`);
  console.log(`Stop: node scripts/guardian.js --stop`);
  process.exit(0);
} else {
  // Foreground mode
  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });

  function shutdown() {
    logSync('═══ Guardian shutting down ═══');
    running = false;
    for (const id of Object.keys(SERVICES)) {
      stopService(id);
    }
    try { unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  }

  mainLoop().catch(err => {
    logSync(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
