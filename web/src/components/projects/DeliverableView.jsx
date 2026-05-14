/**
 * DeliverableView — project deliverables and task artifacts with inline preview.
 */

import { useState } from 'react';
import { FileText, Download, Eye } from 'lucide-react';
import { ArtifactPreviewModal } from './ArtifactPreviewModal';

function ArtifactCard({ artifact, taskTitle, onPreview }) {
  // Normalize: string → object
  const art = typeof artifact === 'string' ? { name: artifact, url: `/api/artifacts/${artifact}` } : artifact;
  const isPreviewable = /\.(md|markdown|html|htm|txt|json|svg)$/i.test(art.name || '') ||
    /text|json|html|markdown|svg/.test(art.mimeType || '');
  const handleOpen = () => {
    if (art.url) window.open(art.url, '_blank');
    else if (art.path) window.open(`file://${art.path}`, '_blank');
  };
  return (
    <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 hover:bg-gray-100">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100">
        <FileText size={15} className="text-gray-500" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-gray-900 truncate">{art.name}</p>
        <p className="text-[10px] text-gray-500 truncate">{taskTitle} · {art.mimeType || '未知类型'}</p>
      </div>
      <div className="flex items-center gap-0.5">
        {isPreviewable && <button type="button" onClick={onPreview} className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900" title="预览"><Eye size={14} /></button>}
        {(art.url || art.path) && <button type="button" onClick={handleOpen} className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900" title="下载"><Download size={14} /></button>}
      </div>
    </div>
  );
}

export function DeliverableView({ project, tasks }) {
  const [previewArtifact, setPreviewArtifact] = useState(null);
  const tasks_ = tasks || project.tasks || [];

  const taskOutputs = [];
  for (const task of tasks_) {
    const artifacts = task.result?.artifacts || [];
    if (artifacts.length > 0) taskOutputs.push({ task, artifacts });
  }

  const deliverables = project.deliverables || [];
  const deliverable = project.deliverable;

  if (taskOutputs.length === 0 && deliverables.length === 0 && !deliverable) {
    return <div className="flex h-full items-center justify-center"><p className="text-sm text-gray-500">暂无产物</p></div>;
  }

  return (
    <div className="p-6 space-y-6">
      {deliverable && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-3">项目交付物</h3>
          <pre className="text-sm text-gray-900 whitespace-pre-wrap font-sans">
            {typeof deliverable === 'string' ? deliverable : JSON.stringify(deliverable, null, 2)}
          </pre>
          {project.deliveredAt && <p className="text-[10px] text-gray-500 mt-2">交付于: {new Date(project.deliveredAt).toLocaleString()}</p>}
        </div>
      )}
      {deliverables.length > 0 && (
        <div>
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500">项目交付物</h3>
          <div className="flex flex-col gap-2">
            {deliverables.map(d => (
              <div key={d.id} className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100">
                  <FileText size={15} className="text-green-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-gray-900 truncate">{d.title}</p>
                  {d.format && <p className="text-[10px] text-gray-500">{d.format}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {taskOutputs.length > 0 && (
        <div>
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500">任务产物</h3>
          <div className="flex flex-col gap-3">
            {taskOutputs.map(({ task, artifacts }) => (
              <div key={task.id} className="rounded-lg border border-gray-200 bg-gray-50 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-200/50">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${task.status === 'done' ? 'bg-green-400' : task.status === 'review' ? 'bg-yellow-400' : 'bg-gray-400'}`} />
                    <span className="text-xs font-medium text-gray-900">{task.title}</span>
                    {task.assignedAgent && <span className="text-[10px] text-gray-500">@{task.assignedAgent}</span>}
                  </div>
                  {task.result && (
                    <>
                      {task.result.summary && <p className="mt-1.5 text-[11px] text-gray-500 pl-4">{task.result.summary}</p>}
                      {task.result.artifacts && task.result.artifacts.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1 pl-4">
                          {task.result.artifacts.map((art, i) => {
                            const a = typeof art === 'string' ? { name: art, url: `/api/artifacts/${art}` } : art;
                            return (
                              <button key={i} type="button" onClick={() => setPreviewArtifact(a)}
                                className="text-[10px] px-2 py-0.5 rounded bg-indigo-50 text-indigo-400 border border-indigo-200 hover:bg-indigo-100">
                                {a.name || a.filename}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div className="divide-y divide-gray-200/50">
                  {artifacts.map((art, i) => (
                    <div key={i} className="px-4 py-2">
                      <ArtifactCard artifact={art} taskTitle={task.title} onPreview={() => setPreviewArtifact(art)} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {previewArtifact && <ArtifactPreviewModal artifact={previewArtifact} onClose={() => setPreviewArtifact(null)} />}
    </div>
  );
}
