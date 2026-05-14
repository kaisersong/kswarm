/**
 * ProjectCard — project summary card in the project list grid.
 * Shows name, goal, status, task progress, PO, last updated, and delete button.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderKanban, CheckCircle2, Clock, Loader2, Trash2, AlertTriangle } from 'lucide-react';
import { useKSwarm } from '../../hooks/useKSwarm';

const STATUS_CONFIG = {
  draft: { label: '草稿', color: 'text-gray-500', icon: Clock },
  planning: { label: '规划中', color: 'text-yellow-400', icon: Loader2 },
  created: { label: '已创建', color: 'text-gray-500', icon: Clock },
  active: { label: '进行中', color: 'text-green-400', icon: Loader2 },
  review: { label: '审核中', color: 'text-gray-500', icon: Clock },
  delivered: { label: '已交付', color: 'text-green-400', icon: CheckCircle2 },
  closed: { label: '已关闭', color: 'text-gray-500', icon: CheckCircle2 },
};

export function ProjectCard({ project }) {
  const navigate = useNavigate();
  const { closeProject } = useKSwarm();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const conf = STATUS_CONFIG[project.status] || STATUS_CONFIG.draft;
  const StatusIcon = conf.icon;
  const totalTasks = project.taskCount || 0;
  const doneTasks = project.doneCount || 0;
  const progress = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  const formatTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    return d.toLocaleDateString('zh-CN');
  };

  const handleDelete = async (e) => {
    e.stopPropagation();
    setDeleting(true);
    try {
      await closeProject(project.id, 'deleted');
      // Force refresh by navigating away and back
      window.location.hash = '#/';
      setTimeout(() => { window.location.reload(); }, 300);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="group relative rounded-xl border border-gray-200 bg-gray-50 p-4 transition-colors hover:bg-gray-100">
      {/* Delete button (top-right, only visible on hover or when confirming) */}
      <div className={`absolute top-3 right-3 ${confirmDelete || deleting ? '' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
        {confirmDelete ? (
          <div className="flex items-center gap-1 bg-white rounded-lg border border-red-200 shadow-lg px-2 py-1.5">
            <AlertTriangle size={12} className="text-red-400" />
            <span className="text-[10px] text-gray-600 whitespace-nowrap">删除后产物不可恢复</span>
            <button onClick={handleDelete} disabled={deleting}
              className="text-[10px] px-1.5 py-0.5 rounded bg-red-500 text-white hover:bg-red-400 disabled:opacity-50">
              {deleting ? '...' : '确认'}
            </button>
            <button onClick={() => setConfirmDelete(false)} disabled={deleting}
              className="text-[10px] px-1.5 py-0.5 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-50">取消</button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)}
            className="rounded-md p-1 text-gray-400 hover:text-red-400 hover:bg-white" title="删除项目">
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {/* Clickable area (exclude delete button) */}
      <button type="button" onClick={() => navigate(`/projects/${project.id}`)}
        className="text-left w-full pr-16"
      >
        <div className="flex items-start gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-200">
            <FolderKanban size={16} className="text-gray-500" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-[13px] font-medium text-gray-900 truncate">{project.name}</h3>
              <span className={`shrink-0 text-[10px] ${conf.color}`}>
                <StatusIcon size={10} className="inline" /> {conf.label}
              </span>
            </div>
          </div>
        </div>

        {project.goal && <p className="text-xs text-gray-500 mt-2 line-clamp-2">{project.goal}</p>}

        {totalTasks > 0 && (
          <div className="flex flex-col gap-1.5 mt-3">
            <div className="h-1 w-full overflow-hidden rounded-full bg-gray-200">
              <div className="h-full rounded-full bg-green-400 transition-all" style={{ width: `${progress}%` }} />
            </div>
            <div className="flex items-center justify-between text-[10px] text-gray-500">
              <span>{doneTasks}/{totalTasks} 任务</span>
              <span>{progress}%</span>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between mt-3 text-[10px] text-gray-400">
          <div className="flex items-center gap-2">
            {project.poAgent && <span>PO: {project.poAgent}</span>}
            {project.plan && (
              <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[9px] text-indigo-400">
                Plan v{project.plan.version}
              </span>
            )}
          </div>
          {project.updatedAt && <span>{formatTime(project.updatedAt)}</span>}
        </div>
      </button>
    </div>
  );
}
