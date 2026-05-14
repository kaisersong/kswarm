/**
 * CreateProjectModal — project creation form.
 */

import { useState, useEffect } from 'react';
import { X, FolderOpen } from 'lucide-react';
import { useKSwarm } from '../../hooks/useKSwarm';

export function CreateProjectModal({ open, agents, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [requirements, setRequirements] = useState('');
  const [poAgent, setPoAgent] = useState('');
  const [members, setMembers] = useState([]);
  const [workFolder, setWorkFolder] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Auto-select PO agent: xiaok seed agent first, then xiaok-cli, then any PO agent
  useEffect(() => {
    if (open && !poAgent && agents.length > 0) {
      const seedAgent = agents.find(a => a.id === 'xiaok');
      const cliAgent = agents.find(a => a.id === 'cli-xiaok');
      const po = agents.find(a => a.roles?.includes('project_owner'));
      if (seedAgent) setPoAgent(seedAgent.id);
      else if (cliAgent) setPoAgent(cliAgent.id);
      else if (po) setPoAgent(po.id);
      else if (agents.length > 0) setPoAgent(agents[0].id);
    }
  }, [open, agents, poAgent]);

  if (!open) return null;

  const poAgents = agents.filter(a => a.roles?.includes('project_owner'));
  const workerAgents = agents.filter(a => a.id !== poAgent);

  const toggleMember = (id) => {
    setMembers(prev => prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id]);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !poAgent) return;
    setSubmitting(true);
    await onCreate({ name: name.trim(), goal: goal.trim(), requirements: requirements.trim(), poAgent, members, workFolder: workFolder.trim() || undefined });
    setName(''); setGoal(''); setRequirements(''); setPoAgent(''); setMembers([]); setWorkFolder('');
    setSubmitting(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8" onClick={onClose} data-testid="modal-create-project">
      <div className="relative w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-2xl border border-gray-300 bg-gray-50 shadow-xl p-6" onClick={e => e.stopPropagation()}>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-gray-900">新建项目</h2>
          <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-gray-500">项目名称</label>
            <input data-testid="input-project-name" type="text" value={name} onChange={e => setName(e.target.value)} placeholder="例：竞品分析报告" autoFocus
              className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-indigo-500" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-gray-500">目标</label>
            <input data-testid="input-project-goal" type="text" value={goal} onChange={e => setGoal(e.target.value)} placeholder="描述你希望完成什么..."
              className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-indigo-500" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-gray-500">项目要求</label>
            <textarea data-testid="input-project-requirements" value={requirements} onChange={e => setRequirements(e.target.value)} placeholder="格式要求、参考资料、限制条件、期望的产出物形式..." rows={4}
              className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-indigo-500 resize-none" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-gray-500">工作目录 <span className="text-gray-400">(可选，留空自动创建)</span></label>
            <div className="flex items-center gap-2">
              <input type="text" value={workFolder} onChange={e => setWorkFolder(e.target.value)} placeholder="~/projects/my-project"
                className="flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-indigo-500" />
              <button type="button" onClick={async (e) => {
                e.stopPropagation();
                if (window.showDirectoryPicker) {
                  try { const h = await window.showDirectoryPicker(); if (h) setWorkFolder(h.name); } catch {}
                } else {
                  const p = prompt('输入工作目录路径（绝对路径）：');
                  if (p) setWorkFolder(p.trim());
                }
              }} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100" title="选择目录">
                <FolderOpen size={15} />
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-gray-500">项目负责人</label>
            {agents.length === 0 ? (
              <p className="text-[12px] text-gray-500 py-2">请先创建智能体</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {(poAgents.length > 0 ? poAgents : agents).map(agent => (
                  <button key={agent.id} type="button" onClick={() => setPoAgent(agent.id)}
                    className={`rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                      poAgent === agent.id ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-500 hover:text-gray-900'
                    }`}>
                    <span>{agent.name}</span>
                    {agent.status === 'offline' && <span className="ml-1 text-[10px] text-gray-400">(离线)</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          {workerAgents.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-medium text-gray-500">执行者 <span className="text-gray-400">(可多选，可选)</span></label>
              <div className="flex flex-wrap gap-1.5">
                {workerAgents.map(agent => {
                  const selected = members.includes(agent.id);
                  return (
                    <button key={agent.id} type="button" onClick={() => toggleMember(agent.id)}
                      className={`rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                        selected ? 'bg-gray-100 text-gray-900 ring-1 ring-zinc-600' : 'bg-gray-100 text-gray-500 hover:text-gray-900'
                      }`}>
                      {agent.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-1.5 text-sm text-gray-500 hover:bg-gray-100">取消</button>
            <button type="submit" disabled={!name.trim() || !poAgent || submitting}
              className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
              {submitting ? '创建中...' : '创建项目'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
