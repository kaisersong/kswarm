const STATUS_CONFIG = {
  dispatched: { label: 'Dispatched', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  accepted: { label: 'Accepted', color: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' },
  in_progress: { label: 'Working', color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  awaiting_approval: { label: 'Needs Approval', color: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  submitted: { label: 'Done', color: 'bg-green-500/20 text-green-400 border-green-500/30' },
  rejected: { label: 'Rejected', color: 'bg-red-500/20 text-red-400 border-red-500/30' },
};

const COLUMNS = ['dispatched', 'in_progress', 'submitted'];
const COLUMN_LABELS = {
  dispatched: 'Waiting',
  in_progress: 'In Progress',
  submitted: 'Done',
};

export function Board({ tasks, pendingApprovals = [], onApprove, onReject }) {
  if (tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        <div className="text-center">
          <div className="text-3xl mb-3 opacity-40">&#9744;</div>
          <p>No tasks yet</p>
          <p className="text-xs text-zinc-600 mt-1">
            Waiting for events from the broker...
          </p>
        </div>
      </div>
    );
  }

  // Pending approval task IDs for quick lookup
  const approvalSet = new Set(pendingApprovals.map(a => a.taskId));

  // Group tasks by status column
  const columns = {};
  for (const col of COLUMNS) columns[col] = [];
  for (const task of tasks) {
    let col;
    if (task.status === 'awaiting_approval') col = 'in_progress';
    else if (task.status === 'accepted') col = 'in_progress';
    else if (task.status === 'rejected') col = 'dispatched';
    else col = COLUMNS.includes(task.status) ? task.status : 'dispatched';
    columns[col].push(task);
  }

  const totalDone = columns.submitted.length;
  const total = tasks.length;
  const pct = total > 0 ? Math.round((totalDone / total) * 100) : 0;

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Pending approvals banner */}
      {pendingApprovals.length > 0 && (
        <div className="px-3 py-2 rounded-lg border border-orange-500/30 bg-orange-500/10">
          <span className="text-xs font-medium text-orange-300">
            {pendingApprovals.length} task{pendingApprovals.length > 1 ? 's' : ''} awaiting your approval
          </span>
        </div>
      )}

      {/* Progress bar */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-green-500 rounded-full transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-xs text-zinc-400 tabular-nums w-16 text-right">
          {totalDone}/{total} done
        </span>
      </div>

      {/* Kanban columns */}
      <div className="flex-1 grid grid-cols-3 gap-3">
        {COLUMNS.map(col => (
          <div key={col} className="flex flex-col gap-2">
            <div className="flex items-center gap-2 px-1 mb-1">
              <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                {COLUMN_LABELS[col]}
              </span>
              <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 tabular-nums">
                {columns[col].length}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {columns[col].map(task => (
                <TaskCard
                  key={task.id}
                  task={task}
                  needsApproval={approvalSet.has(task.id)}
                  onApprove={onApprove}
                  onReject={onReject}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TaskCard({ task, needsApproval, onApprove, onReject }) {
  const cfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.dispatched;

  return (
    <div className={`p-3 rounded-lg border bg-zinc-900/50 hover:border-zinc-700 transition-colors ${needsApproval ? 'border-orange-500/40' : 'border-zinc-800'}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium text-zinc-200 leading-tight">
          {task.title}
        </h3>
      </div>

      {task.assignedAgent && (
        <div className="mt-2 flex items-center gap-1.5">
          <div className="w-4 h-4 rounded-full bg-indigo-500/30 flex items-center justify-center">
            <span className="text-[9px] text-indigo-300">@</span>
          </div>
          <span className="text-xs text-zinc-400">{task.assignedAgent}</span>
        </div>
      )}

      {task.result?.summary && (
        <p className="mt-2 text-xs text-zinc-500 line-clamp-2">
          {task.result.summary}
        </p>
      )}

      <div className="mt-2 flex items-center gap-2">
        <span className={`inline-flex text-[10px] px-1.5 py-0.5 rounded border ${cfg.color}`}>
          {cfg.label}
        </span>
      </div>

      {/* Approval actions */}
      {needsApproval && (
        <div className="mt-3 pt-2 border-t border-zinc-800 flex gap-2">
          <button
            onClick={() => onApprove?.(task.id)}
            className="flex-1 text-[11px] px-2 py-1.5 rounded bg-green-600/20 text-green-400 border border-green-500/30 hover:bg-green-600/30 transition-colors"
          >
            Approve
          </button>
          <button
            onClick={() => onReject?.(task.id)}
            className="flex-1 text-[11px] px-2 py-1.5 rounded bg-red-600/20 text-red-400 border border-red-500/30 hover:bg-red-600/30 transition-colors"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
