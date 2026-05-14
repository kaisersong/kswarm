/**
 * KanbanBoard — 4-column kanban with task detail, artifact links, review results, agent assignment.
 */

import { useState } from 'react';
import { Circle, Loader2, Eye, CheckCircle2, Plus, X as XIcon, Check, AlertCircle } from 'lucide-react';
import { useKSwarm } from '../../hooks/useKSwarm';
import { ArtifactPreviewModal } from './ArtifactPreviewModal';

const COLUMNS = [
  { id: 'pending', label: '待处理', color: 'border-t-zinc-500', icon: Circle, statuses: ['pending'] },
  { id: 'active', label: '进行中', color: 'border-t-yellow-400', icon: Loader2, statuses: ['dispatched', 'in_progress'] },
  { id: 'review', label: '待审核', color: 'border-t-green-400', icon: Eye, statuses: ['review'] },
  { id: 'done', label: '已完成', color: 'border-t-green-400', icon: CheckCircle2, statuses: ['done', 'failed', 'cancelled'] },
];

function TaskCard({ task, projectId, onPreviewArtifact }) {
  const { cancelTask, markTaskDone, agents } = useKSwarm();
  const [acting, setActing] = useState(false);
  const isFailed = task.status === 'failed';
  const isCancelled = task.status === 'cancelled';
  const canCancel = task.status === 'pending';
  const canMarkDone = task.status === 'review' || task.status === 'in_progress';
  const result = task.result || {};
  const hasArtifacts = result.artifacts && result.artifacts.length > 0;
  const review = task.reviewResult;

  const agentName = (id) => {
    if (!id) return '';
    const a = agents.find(a => a.id === id);
    return a?.name || id;
  };

  const handleCancel = async (e) => {
    e.stopPropagation();
    setActing(true);
    await cancelTask(projectId, task.id);
    setActing(false);
  };

  const handleMarkDone = async (e) => {
    e.stopPropagation();
    setActing(true);
    await markTaskDone(projectId, task.id);
    setActing(false);
  };

  return (
    <>
      <div className={`group rounded-lg border border-gray-200 bg-gray-50 p-3 transition-colors hover:bg-gray-50 ${
        isFailed ? 'border-red-400/30' : isCancelled ? 'opacity-50' : ''
      }`}>
        <div className="flex items-start justify-between gap-1">
          <p className="text-[12px] font-medium text-gray-900 line-clamp-2 flex-1">{task.title}</p>
          {!acting && (canCancel || canMarkDone) && (
            <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
              {canMarkDone && (
                <button type="button" onClick={handleMarkDone} className="rounded p-0.5 text-green-400 hover:bg-gray-100" title="标记完成"><Check size={12} /></button>
              )}
              {canCancel && (
                <button type="button" onClick={handleCancel} className="rounded p-0.5 text-red-400 hover:bg-gray-100" title="取消"><XIcon size={12} /></button>
              )}
            </div>
          )}
        </div>
        {task.description && <p className="mt-1 text-[11px] text-gray-500 line-clamp-2">{task.description}</p>}
        {task.assignedAgent && (
          <div className="mt-2 flex items-center gap-1.5">
            <div className="h-4 w-4 rounded-full bg-gray-100 flex items-center justify-center">
              <span className="text-[8px] font-bold text-gray-500">{task.assignedAgent.charAt(0).toUpperCase()}</span>
            </div>
            <span className="text-[10px] text-gray-500 truncate">{agentName(task.assignedAgent)}</span>
          </div>
        )}
        {review && (
          <div className={`mt-2 px-2 py-1.5 rounded-lg text-[10px] border ${
            review.passed ? 'border-green-400/20 bg-green-400/5 text-green-400' : 'border-red-400/20 bg-red-400/5 text-red-400'
          }`}>
            <span className="font-medium">{review.passed ? 'PASSED' : 'REWORK'}</span>
            {review.feedback && <p className="mt-0.5 text-gray-500 line-clamp-2">{review.feedback}</p>}
          </div>
        )}
        {hasArtifacts && (
          <div className="mt-2 flex flex-wrap gap-1">
            {result.artifacts.map((art, i) => {
              const a = typeof art === 'string' ? { name: art, url: `/api/artifacts/${art}` } : art;
              return (
                <button key={i} type="button" onClick={(e) => { e.stopPropagation(); onPreviewArtifact(a); }}
                  className="text-[9px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-300 hover:bg-gray-200 truncate max-w-full">
                  {a.name || a.filename}
                </button>
              );
            })}
          </div>
        )}
        {isFailed && <span className="mt-1.5 inline-block rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">失败</span>}
      </div>
    </>
  );
}

function AddTaskForm({ projectId, onDone }) {
  const { humanAddTasks, agents } = useKSwarm();
  const [rows, setRows] = useState([{ title: '', assignedAgent: '' }]);
  const [saving, setSaving] = useState(false);

  const updateRow = (idx, field, value) => {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));
  };
  const addRow = () => setRows(prev => [...prev, { title: '', assignedAgent: '' }]);
  const removeRow = (idx) => { if (rows.length <= 1) return; setRows(prev => prev.filter((_, i) => i !== idx)); };

  const handleSave = async () => {
    const tasks = rows.filter(r => r.title.trim()).map(r => ({ title: r.title.trim(), description: '', assignedAgent: r.assignedAgent || undefined }));
    if (tasks.length === 0) return;
    setSaving(true);
    await humanAddTasks(projectId, tasks);
    setSaving(false);
    onDone();
  };

  const managedAgents = agents.filter(a => a.roles?.includes('worker') || !a.roles?.length);

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
      <div className="flex flex-col gap-2">
        {rows.map((row, idx) => (
          <div key={idx} className="flex items-center gap-1.5">
            <input type="text" value={row.title} onChange={e => updateRow(idx, 'title', e.target.value)} placeholder="任务标题..."
              className="flex-1 rounded-lg border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-[12px] text-gray-900 placeholder-gray-400 outline-none focus:border-indigo-500" autoFocus={idx === 0} placeholder="需求内容..." />
            <select value={row.assignedAgent} onChange={e => updateRow(idx, 'assignedAgent', e.target.value)}
              className="w-28 rounded-lg border border-gray-300 bg-gray-50 px-2 py-1.5 text-[11px] text-gray-900 outline-none">
              <option value="">自动分配</option>
              {managedAgents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            {rows.length > 1 && (
              <button type="button" onClick={() => removeRow(idx)} className="rounded p-1 text-gray-500 hover:text-red-400"><XIcon size={12} /></button>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <button type="button" onClick={addRow} className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-500">
          <Plus size={11} /><span>添加一行</span>
        </button>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={onDone} className="rounded-lg px-2.5 py-1 text-[11px] text-gray-500 hover:bg-gray-100">取消</button>
          <button type="button" onClick={handleSave} disabled={saving || rows.every(r => !r.title.trim())}
            className="rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {saving ? '...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function KanbanBoard({ project }) {
  const tasks = project.tasks || [];
  const [showAddForm, setShowAddForm] = useState(false);
  const [previewArtifact, setPreviewArtifact] = useState(null);

  if (tasks.length === 0 && !showAddForm) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-gray-500">暂无任务</p>
        <button type="button" onClick={() => setShowAddForm(true)}
          className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-[12px] text-gray-500 hover:bg-gray-100">
          <Plus size={12} /><span>新增需求</span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center px-6 pt-4 pb-2">
        {!showAddForm ? (
          <button type="button" onClick={() => setShowAddForm(true)}
            className="flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1 text-[11px] text-gray-500 hover:bg-gray-100">
            <Plus size={11} /><span>新增需求</span>
          </button>
        ) : (
          <div className="w-full max-w-md"><AddTaskForm projectId={project.id} onDone={() => setShowAddForm(false)} /></div>
        )}
      </div>
      <div className="flex flex-1 gap-4 overflow-x-auto px-6 pb-6">
        {COLUMNS.map(col => {
          const Icon = col.icon;
          const colTasks = tasks.filter(t => col.statuses.includes(t.status));
          return (
            <div key={col.id} className="flex w-60 shrink-0 flex-col">
              <div className={`mb-3 flex items-center gap-2 border-t-2 ${col.color} pt-2`}>
                <Icon size={13} className="text-gray-500" />
                <span className="text-[12px] font-medium text-gray-900">{col.label}</span>
                <span className="ml-auto text-[10px] text-gray-500">{colTasks.length}</span>
              </div>
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
                {colTasks.map(task => <TaskCard key={task.id} task={task} projectId={project.id} onPreviewArtifact={setPreviewArtifact} />)}
              </div>
            </div>
          );
        })}
      </div>
      {previewArtifact && <ArtifactPreviewModal artifact={previewArtifact} onClose={() => setPreviewArtifact(null)} />}
    </div>
  );
}
