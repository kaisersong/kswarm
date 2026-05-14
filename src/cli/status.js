/**
 * CLI Status — Rich terminal output for kswarm status
 *
 * Renders project state as a terminal "Kanban board":
 * - Each column = task status (pending / dispatched / in_progress / done)
 * - Shows agent assignment, progress, timing
 * - No UI framework needed — just ANSI escape codes
 *
 * This is the "验证" interface: human runs `kswarm status` and SEEs what's happening.
 */

// ANSI color helpers
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgRed: '\x1b[41m',
};

export function renderStatus({ projectManager, agentRegistry, projectId }) {
  const project = projectManager.getProject(projectId);
  if (!project) {
    console.log(`${c.red}No active project.${c.reset}`);
    return;
  }

  const stats = projectManager.getStats(projectId);
  const tasks = project.taskIds.map(id => projectManager.getTask(id)).filter(Boolean);

  // Header
  console.log('');
  console.log(`${c.bold}┌─────────────────────────────────────────────────────────────┐${c.reset}`);
  console.log(`${c.bold}│ ${c.cyan}${project.name}${c.reset}${c.bold}${' '.repeat(Math.max(0, 56 - project.name.length))}│${c.reset}`);
  console.log(`${c.bold}│${c.reset} ${c.dim}${project.goal.slice(0, 57)}${c.reset} ${c.bold}│${c.reset}`);
  console.log(`${c.bold}├─────────────────────────────────────────────────────────────┤${c.reset}`);

  // Progress bar
  const pct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;
  const barWidth = 40;
  const filled = Math.round(barWidth * pct / 100);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  const statusColor = project.status === 'delivered' ? c.green : c.yellow;
  console.log(`${c.bold}│${c.reset} ${statusColor}${bar}${c.reset} ${pct}% ${c.dim}(${stats.done}/${stats.total})${c.reset}  ${c.bold}│${c.reset}`);
  console.log(`${c.bold}├─────────────────────────────────────────────────────────────┤${c.reset}`);

  // Task list (Kanban-style)
  const statusOrder = ['pending', 'dispatched', 'accepted', 'in_progress', 'done', 'failed'];
  const statusLabel = {
    pending: `${c.gray}○ PENDING${c.reset}`,
    dispatched: `${c.blue}◐ DISPATCHED${c.reset}`,
    accepted: `${c.cyan}◑ ACCEPTED${c.reset}`,
    in_progress: `${c.yellow}● WORKING${c.reset}`,
    done: `${c.green}✓ DONE${c.reset}`,
    failed: `${c.red}✗ FAILED${c.reset}`,
  };

  for (const task of tasks) {
    const label = statusLabel[task.status] || task.status;
    const agent = task.assignedAgent ? `${c.magenta}@${task.assignedAgent}${c.reset}` : '';
    const title = task.title.length > 30 ? task.title.slice(0, 27) + '...' : task.title;
    console.log(`${c.bold}│${c.reset}  ${label}  ${title}  ${agent}`);
  }

  console.log(`${c.bold}├─────────────────────────────────────────────────────────────┤${c.reset}`);

  // Agent status
  if (agentRegistry) {
    const agents = agentRegistry.getAll();
    const agentLine = agents.map(a => {
      const dot = a.available ? `${c.green}●${c.reset}` : `${c.yellow}●${c.reset}`;
      return `${dot} ${a.alias}`;
    }).join('  ');
    console.log(`${c.bold}│${c.reset} Agents: ${agentLine}`);
  }

  // Footer
  console.log(`${c.bold}│${c.reset} Status: ${statusColor}${c.bold}${project.status.toUpperCase()}${c.reset}  ${c.dim}updated ${timeSince(project.updatedAt)}${c.reset}`);
  console.log(`${c.bold}└─────────────────────────────────────────────────────────────┘${c.reset}`);
  console.log('');
}

/**
 * Render event stream as a timeline (for `kswarm log`)
 */
export function renderTimeline(eventLog, { last = 20 } = {}) {
  const events = eventLog.getEvents();
  const recent = events.slice(-last);

  console.log('');
  console.log(`${c.bold}─── Event Timeline (last ${recent.length} of ${events.length}) ───${c.reset}`);
  console.log('');

  for (const event of recent) {
    const time = event.ts.split('T')[1].split('.')[0];
    const typeColor = event.type.startsWith('task.done') ? c.green
      : event.type.startsWith('task.failed') ? c.red
      : event.type.startsWith('project.delivered') ? c.green + c.bold
      : c.dim;
    const detail = event.title || event.agent || event.projectName || '';
    console.log(`  ${c.gray}${time}${c.reset}  ${typeColor}${event.type.padEnd(20)}${c.reset}  ${detail}`);
  }
  console.log('');
}

/**
 * One-line status for watch mode / IM responses
 */
export function renderOneLiner({ projectManager, projectId }) {
  const project = projectManager.getProject(projectId);
  if (!project) return '(no project)';

  const stats = projectManager.getStats(projectId);
  const pct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;

  if (project.status === 'delivered') {
    return `✅ ${project.name} — DELIVERED (${stats.done}/${stats.total} tasks)`;
  }
  return `⏳ ${project.name} — ${pct}% (${stats.done}/${stats.total}) | working: ${stats.inProgress} | waiting: ${stats.pending}`;
}

function timeSince(ts) {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}
