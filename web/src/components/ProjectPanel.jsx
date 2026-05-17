import { useState, useEffect } from 'react';
import { useT } from '../i18n';
import { deriveAgentStatuses } from '../utils/agent-status.js';

export function ProjectPanel({ kswarm }) {
  const { t } = useT();
  const { projects, agents, participants, createProject, approveProject, getProjectDetail,
    humanAddTasks, createTasks, dispatchTasks, markTaskDone, cancelTask, deliverProject,
    closeProject, lastTaskEvent, logs } = kswarm;
  const [showCreate, setShowCreate] = useState(false);
  const [selectedProject, setSelectedProject] = useState(null);
  const [projectDetail, setProjectDetail] = useState(null);

  const availableAgents = participants.filter(p =>
    p.kind === 'agent' && !p.participantId.startsWith('kswarm-')
  );

  // Managed agents from the agent store (can be started as PO)
  const managedAgents = (agents || []).filter(a => !a.archivedAt);

  // Resolve agent ID to display name
  const agentName = (id) => {
    const a = managedAgents.find(a => a.id === id);
    return a?.name || id;
  };

  const handleViewDetail = async (projectId) => {
    const data = await getProjectDetail(projectId);
    setProjectDetail(data);
    setSelectedProject(projectId);
  };

  const refreshDetail = async () => {
    if (selectedProject) {
      const data = await getProjectDetail(selectedProject);
      setProjectDetail(data);
    }
  };

  useEffect(() => {
    if (lastTaskEvent && selectedProject && lastTaskEvent.projectId === selectedProject) {
      refreshDetail();
    }
  }, [lastTaskEvent]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold">{t('projects.title')}</h1>
          <p className="text-xs text-zinc-500 mt-0.5">{t('projects.subtitle')}</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-3 py-1.5 text-xs rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-500 transition-colors"
        >
          + {t('projects.new')}
        </button>
      </div>

      {showCreate && (
        <CreateProjectForm
          t={t}
          managedAgents={managedAgents}
          availableAgents={availableAgents}
          onCreate={async (data) => { await createProject(data); setShowCreate(false); }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      <div className="flex gap-4">
        <div className={`${selectedProject ? 'w-1/4' : 'w-full'} flex flex-col gap-3 transition-all`}>
          {projects.length === 0 ? (
            <div className="border border-dashed border-zinc-800 rounded-xl p-12 text-center">
              <p className="text-zinc-500 text-sm">{t('projects.empty')}</p>
              <p className="text-zinc-600 text-xs mt-1">{t('projects.emptyHint')}</p>
            </div>
          ) : (
            projects.map(project => (
              <ProjectCard key={project.id} t={t} project={project}
                selected={selectedProject === project.id}
                agentName={agentName}
                onView={() => handleViewDetail(project.id)} />
            ))
          )}
        </div>

        {selectedProject && projectDetail && (
          <div className="flex-1 border border-zinc-800 rounded-xl bg-zinc-900/20 overflow-hidden flex flex-col" style={{ maxHeight: 'calc(100vh - 160px)' }}>
            <ProjectDetail
              t={t}
              data={projectDetail}
              availableAgents={availableAgents}
              agents={managedAgents}
              participants={participants}
              logs={logs}
              agentName={agentName}
              onHumanAddTasks={(tasks) => humanAddTasks(selectedProject, tasks)}
              onCreateTasks={(tasks) => createTasks(selectedProject, tasks, projectDetail.project.poAgent)}
              onDispatch={() => dispatchTasks(selectedProject, projectDetail.project.poAgent)}
              onApprove={() => approveProject(selectedProject)}
              onMarkDone={(taskId) => markTaskDone(selectedProject, taskId, projectDetail.project.poAgent)}
              onCancel={(taskId) => cancelTask(selectedProject, taskId)}
              onDeliver={() => deliverProject(selectedProject, projectDetail.project.poAgent)}
              onClose={(summary) => closeProject(selectedProject, summary)}
              onRefresh={refreshDetail}
              onClosePanel={() => { setSelectedProject(null); setProjectDetail(null); }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Create Project Form ──────────────────────────────────────────

function CreateProjectForm({ t, managedAgents, availableAgents, onCreate, onCancel }) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [requirements, setRequirements] = useState('');
  const [poAgent, setPoAgent] = useState('');
  const [members, setMembers] = useState([]);
  const [workFolder, setWorkFolder] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const toggleMember = (id) => {
    setMembers(prev => prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id]);
  };

  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      if (!name.trim() || !poAgent) return;
      setSubmitting(true);
      await onCreate({ name: name.trim(), goal: goal.trim(), requirements: requirements.trim(), poAgent, members, workFolder: workFolder.trim() || undefined });
      setSubmitting(false);
    }} className="mb-6 p-4 rounded-xl border border-zinc-800 bg-zinc-900/50">
      <h3 className="text-sm font-medium mb-3">{t('projects.create.title')}</h3>
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-zinc-400 block mb-1">{t('projects.create.name')} *</label>
            <input autoFocus value={name} onChange={e => setName(e.target.value)}
              placeholder={t('projects.create.namePlaceholder')}
              className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500" />
          </div>
          <div>
            <label className="text-xs text-zinc-400 block mb-1">{t('projects.create.goal')}</label>
            <input value={goal} onChange={e => setGoal(e.target.value)}
              placeholder={t('projects.create.goalPlaceholder')}
              className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500" />
          </div>
        </div>
        {/* Requirements - multi-line textarea */}
        <div>
          <label className="text-xs text-zinc-400 block mb-1">{t('projects.create.requirements')}</label>
          <textarea value={requirements} onChange={e => setRequirements(e.target.value)}
            placeholder={t('projects.create.requirementsPlaceholder')}
            rows={4}
            className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 resize-y" />
        </div>
        {/* Work folder — directory picker */}
        <div>
          <label className="text-xs text-zinc-400 block mb-1">工作目录（可选，留空自动创建）</label>
          <div className="flex gap-2">
            <input value={workFolder} onChange={e => setWorkFolder(e.target.value)} readOnly
              placeholder="留空则自动分配 ~/.kswarm/projects/ 下"
              className="flex-1 px-3 py-2 text-sm rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 font-mono cursor-default" />
            <button type="button" onClick={async () => {
              try {
                if (window.showDirectoryPicker) {
                  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
                  // resolve full path via server — browser only gives handle.name
                  // For now use handle.name as hint; server will create under ~/.kswarm/projects/<id> if not absolute
                  setWorkFolder(handle.name);
                } else {
                  // Fallback: prompt
                  const p = prompt('输入工作目录路径（绝对路径）：');
                  if (p) setWorkFolder(p.trim());
                }
              } catch (e) {
                // User cancelled picker
              }
            }}
              className="px-3 py-2 text-xs rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:border-zinc-600 transition-colors whitespace-nowrap">
              浏览...
            </button>
            {workFolder && (
              <button type="button" onClick={() => setWorkFolder('')}
                className="px-2 py-2 text-xs text-zinc-500 hover:text-zinc-300">
                清除
              </button>
            )}
          </div>
          <p className="text-[10px] text-zinc-600 mt-1">选择本地文件夹作为项目工作目录，产出物将存放在此</p>
        </div>
        <div>
          <label className="text-xs text-zinc-400 block mb-1">{t('projects.create.po')} * — {t('projects.create.poHint')}</label>
          <div className="flex flex-wrap gap-2">
            {managedAgents.length === 0 && (
              <p className="text-[11px] text-zinc-500 italic">请先在「智能体」面板创建并配置 Agent</p>
            )}
            {managedAgents.map(a => (
              <button key={a.id} type="button" onClick={() => setPoAgent(a.id)}
                className={`px-2.5 py-1.5 text-[11px] rounded-lg border transition-colors ${
                  poAgent === a.id ? 'bg-purple-600/20 text-purple-300 border-purple-500/40' : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-600'
                }`}>
                {a.name}
                {a.status === 'offline' && <span className="ml-1 text-[9px] text-zinc-600">(离线)</span>}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs text-zinc-400 block mb-1">{t('projects.create.members')}</label>
          <div className="flex flex-wrap gap-2">
            {managedAgents.filter(a => a.id !== poAgent).map(a => (
              <button key={a.id} type="button" onClick={() => toggleMember(a.id)}
                className={`px-2.5 py-1.5 text-[11px] rounded-lg border transition-colors ${
                  members.includes(a.id) ? 'bg-blue-600/20 text-blue-300 border-blue-500/40' : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-600'
                }`}>
                {a.name}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex gap-2 mt-4">
        <button type="submit" disabled={!name.trim() || !poAgent || submitting}
          className="px-4 py-1.5 text-xs rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-500 disabled:opacity-40 transition-colors">
          {submitting ? '...' : t('projects.create.submit')}
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200">
          {t('projects.create.cancel')}
        </button>
      </div>
    </form>
  );
}

// ─── Project Card ─────────────────────────────────────────────────

const STATUS_STYLES = {
  created: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  planning: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  active: 'bg-green-500/20 text-green-400 border-green-500/30',
  delivered: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  closed: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
};

function ProjectCard({ t, project, selected, agentName, onView }) {
  const statusStyle = STATUS_STYLES[project.status] || STATUS_STYLES.created;
  const statusLabel = t(`projects.status.${project.status}`) || project.status;
  const progress = project.taskCount > 0 ? Math.round((project.doneCount / project.taskCount) * 100) : 0;

  return (
    <div className={`p-4 rounded-xl border cursor-pointer transition-colors ${
      selected ? 'border-indigo-500/50 bg-indigo-500/5' : 'border-zinc-800 bg-zinc-900/30 hover:border-zinc-700'
    }`} onClick={onView}>
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-zinc-200 flex-1 truncate">{project.name}</h3>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${statusStyle}`}>{statusLabel}</span>
      </div>
      {project.goal && <p className="text-xs text-zinc-500 mt-1 truncate">{project.goal}</p>}
      <div className="flex items-center gap-3 mt-2 text-[11px] text-zinc-500">
        <span>PO: <span className="text-zinc-300">{agentName(project.poAgent)}</span></span>
        {project.plan && (
          <span className="px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-[10px]">
            Plan v{project.plan.version}
          </span>
        )}
        {project.taskCount > 0 && <span>{project.doneCount}/{project.taskCount}</span>}
      </div>
      {project.taskCount > 0 && (
        <div className="mt-2 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div className="h-full bg-gradient-to-r from-indigo-500 to-green-500 rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
        </div>
      )}
    </div>
  );
}

// ─── Project Detail ───────────────────────────────────────────────

function ProjectDetail({ t, data, availableAgents, agents, participants, logs, agentName, onHumanAddTasks, onCreateTasks, onDispatch, onApprove, onMarkDone, onCancel, onDeliver, onClose, onRefresh, onClosePanel }) {
  const { project, tasks, activities = [], humanActions = [], workspace, plan, planProgress } = data;
  const [showAddTasks, setShowAddTasks] = useState(false);
  const [detailTab, setDetailTab] = useState(plan ? 'plan' : 'board');
  const [previewArtifact, setPreviewArtifact] = useState(null);
  const [closeConfirm, setCloseConfirm] = useState(false);

  const allDone = tasks.length > 0 && tasks.every(t => t.status === 'done');
  const isClosed = project.status === 'closed';

  const TABS = [
    ...(plan ? [{ id: 'plan', label: `Plan v${plan.version}` }] : []),
    { id: 'board', label: 'Kanban' },
    { id: 'timeline', label: t('projects.detail.activities') },
    { id: 'deliverable', label: t('projects.detail.deliverable') },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-zinc-800 shrink-0">
        <div>
          <h2 className="text-base font-semibold">{project.name}</h2>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-zinc-500">PO: {agentName(project.poAgent)}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_STYLES[project.status] || ''}`}>
              {t(`projects.status.${project.status}`) || project.status}
            </span>
          </div>
          {project.goal && <p className="text-[11px] text-zinc-400 mt-1">{project.goal}</p>}
          {project.requirements && <p className="text-[10px] text-zinc-500 mt-0.5 line-clamp-2">{project.requirements}</p>}
          {/* Workspace path */}
          {workspace && (
            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-[10px] text-zinc-600">Workspace:</span>
              <span className="text-[10px] text-zinc-400 font-mono truncate max-w-[300px]">{workspace.path}</span>
              {workspace.artifacts?.length > 0 && (
                <span className="text-[9px] px-1 rounded bg-zinc-800 text-zinc-500">{workspace.artifacts.length} files</span>
              )}
            </div>
          )}
          {(project.status === 'created' || project.status === 'planning') && !plan && (
            <p className="text-[10px] text-yellow-500 mt-1">等待 PO 制定计划...</p>
          )}
          {(project.status === 'created' || project.status === 'planning') && plan && (
            <p className="text-[10px] text-green-500 mt-1">Plan v{plan.version} 已就绪，可审批</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {(project.status === 'created' || project.status === 'planning') && (
            <ActionBtn color="green" onClick={async () => {
              const result = await onApprove();
              if (result && !result.ok && result.error === 'no_plan_or_tasks') {
                alert('PO 尚未提交计划，请稍候');
              }
              onRefresh();
            }}>
              {t('projects.actions.approve')}
            </ActionBtn>
          )}
          {project.status === 'active' && tasks.some(t => t.status === 'pending') && (
            <ActionBtn color="blue" onClick={async () => { await onDispatch(); setTimeout(onRefresh, 600); }}>
              {t('projects.actions.dispatch')}
            </ActionBtn>
          )}
          {project.status === 'active' && !isClosed && (
            <ActionBtn color="red" onClick={() => setCloseConfirm(true)}>
              关闭项目
            </ActionBtn>
          )}
          <button onClick={onRefresh} className="px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300">{t('projects.actions.refresh')}</button>
          <button onClick={onClosePanel} className="px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300">{t('projects.actions.close')}</button>
        </div>
      </div>

      <AgentStatusStrip
        project={project}
        tasks={tasks}
        agents={agents}
        participants={participants}
        logs={logs}
      />

      {/* Close confirm dialog */}
      {closeConfirm && (
        <div className="p-3 border-b border-red-500/30 bg-red-500/5 flex items-center gap-3">
          <span className="text-xs text-red-400">确认关闭项目？关闭后不可重开。</span>
          <button onClick={async () => { await onClose('Human confirmed closure'); setCloseConfirm(false); onRefresh(); }}
            className="px-2 py-1 text-[10px] rounded bg-red-600 text-white hover:bg-red-500">确认关闭</button>
          <button onClick={() => setCloseConfirm(false)} className="px-2 py-1 text-[10px] text-zinc-400">取消</button>
        </div>
      )}

      {/* Sub tabs */}
      <div className="flex items-center gap-1 px-4 pt-3 pb-2 border-b border-zinc-800/50 shrink-0">
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setDetailTab(tab.id)}
            className={`px-2.5 py-1 text-[11px] rounded-md transition-colors ${
              detailTab === tab.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
            }`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {detailTab === 'plan' && plan && (
          <PlanView plan={plan} planProgress={planProgress} tasks={tasks} agentName={agentName} />
        )}
        {detailTab === 'board' && (
          <BoardView t={t} tasks={tasks} project={project}
            availableAgents={availableAgents}
            showAddTasks={showAddTasks}
            setShowAddTasks={setShowAddTasks}
            onHumanAddTasks={onHumanAddTasks}
            onMarkDone={onMarkDone}
            onCancel={onCancel}
            agentName={agentName}
            onRefresh={onRefresh}
            onPreview={setPreviewArtifact}
            isClosed={isClosed} />
        )}
        {detailTab === 'timeline' && (
          <ActivityTimeline activities={activities} humanActions={humanActions} t={t} onPreview={setPreviewArtifact} agentName={agentName} />
        )}
        {detailTab === 'deliverable' && (
          <DeliverableView project={project} tasks={tasks} t={t} onPreview={setPreviewArtifact} agentName={agentName} />
        )}
      </div>

      {/* Artifact Preview Modal */}
      {previewArtifact && (
        <ArtifactPreview artifact={previewArtifact} onClose={() => setPreviewArtifact(null)} />
      )}

      {/* Status banners */}
      {isClosed && detailTab === 'board' && (
        <div className="p-3 border-t border-zinc-500/30 bg-zinc-500/10 text-center shrink-0">
          <span className="text-sm text-zinc-400 font-medium">项目已关闭</span>
          {project.closedAt && <span className="text-[10px] text-zinc-600 ml-2">{new Date(project.closedAt).toLocaleString()}</span>}
        </div>
      )}
    </div>
  );
}

function ActionBtn({ color, onClick, children }) {
  const colors = {
    green: 'bg-green-600/20 text-green-400 border-green-500/30 hover:bg-green-600/30',
    blue: 'bg-blue-600/20 text-blue-400 border-blue-500/30 hover:bg-blue-600/30',
    purple: 'bg-purple-600/20 text-purple-400 border-purple-500/30 hover:bg-purple-600/30',
    red: 'bg-red-600/20 text-red-400 border-red-500/30 hover:bg-red-600/30',
  };
  return (
    <button onClick={onClick} className={`px-2.5 py-1 text-[11px] rounded-md border ${colors[color] || colors.blue}`}>
      {children}
    </button>
  );
}

const AGENT_STATUS_STYLES = {
  working: { dot: 'bg-blue-400 animate-pulse', chip: 'border-blue-500/30 bg-blue-500/10 text-blue-300' },
  reviewing: { dot: 'bg-cyan-400 animate-pulse', chip: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300' },
  waiting_review: { dot: 'bg-cyan-400', chip: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300' },
  waiting: { dot: 'bg-zinc-500', chip: 'border-zinc-700 bg-zinc-900/60 text-zinc-300' },
  blocked: { dot: 'bg-yellow-400', chip: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-300' },
  failed: { dot: 'bg-red-500', chip: 'border-red-500/30 bg-red-500/10 text-red-300' },
  error: { dot: 'bg-red-500 animate-pulse', chip: 'border-red-500/40 bg-red-500/15 text-red-200' },
  cancelled: { dot: 'bg-zinc-500', chip: 'border-zinc-600/50 bg-zinc-800/50 text-zinc-400' },
  done: { dot: 'bg-green-400', chip: 'border-green-500/30 bg-green-500/10 text-green-300' },
  offline: { dot: 'bg-zinc-700', chip: 'border-zinc-800 bg-zinc-950/50 text-zinc-500' },
};

function AgentStatusStrip({ project, tasks, agents, participants, logs }) {
  const statuses = deriveAgentStatuses({ project, tasks, agents, participants, logs });
  if (!statuses.length) return null;

  return (
    <div className="px-4 py-2 border-b border-zinc-800/50 bg-zinc-950/30 shrink-0">
      <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
        {statuses.map(status => {
          const style = AGENT_STATUS_STYLES[status.status] || AGENT_STATUS_STYLES.waiting;
          return (
            <div key={status.id}
              title={status.taskTitle ? `${status.detail}: ${status.taskTitle}` : status.detail}
              className={`min-w-[150px] max-w-[220px] rounded-md border px-2.5 py-1.5 ${style.chip}`}>
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={`w-2 h-2 rounded-full shrink-0 ${style.dot}`} />
                <span className="text-[11px] font-medium truncate text-zinc-100">{status.name}</span>
                <span className="text-[9px] text-zinc-500 shrink-0">{status.role}</span>
                <span className="ml-auto text-[10px] shrink-0">{status.label}</span>
              </div>
              <div className="mt-0.5 text-[9px] text-zinc-500 truncate">
                {status.taskTitle || status.detail}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Plan View ───────────────────────────────────────────────────

const ITEM_STATUS_STYLES = {
  planned: 'text-zinc-400 bg-zinc-800/50 border-zinc-700',
  active: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  completed: 'text-green-400 bg-green-500/10 border-green-500/30',
  revised: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30',
  dropped: 'text-zinc-600 bg-zinc-800/30 border-zinc-800 line-through',
};

function PlanView({ plan, planProgress, tasks, agentName }) {
  const [expandedPhases, setExpandedPhases] = useState(() =>
    new Set((plan.phases || []).map(p => p.id))
  );
  const [showRevisions, setShowRevisions] = useState(false);

  const togglePhase = (id) => {
    setExpandedPhases(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // Match plan items to tasks for status
  const taskMap = {};
  for (const t of (tasks || [])) {
    if (t.planItemId) taskMap[t.planItemId] = t;
    taskMap[t.id] = t;
  }

  return (
    <div className="space-y-4">
      {/* Analysis */}
      {plan.analysis && (
        <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-950/50">
          <h4 className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-2">Analysis</h4>
          <div className="text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed">{plan.analysis}</div>
        </div>
      )}

      {/* Success Criteria */}
      {plan.successCriteria?.length > 0 && (
        <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-950/50">
          <h4 className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-2">Success Criteria</h4>
          <ul className="space-y-1">
            {plan.successCriteria.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <span className="text-zinc-600 mt-0.5">-</span>
                <span className="text-zinc-300">{c}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Phases */}
      {(plan.phases || []).map((phase, pi) => {
        const phaseProgress = planProgress?.phases?.find(p => p.phaseId === phase.id);
        const total = phaseProgress?.total || phase.items?.length || 0;
        const done = phaseProgress?.done || 0;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const isExpanded = expandedPhases.has(phase.id);

        return (
          <div key={phase.id} className="rounded-lg border border-zinc-800 bg-zinc-950/50 overflow-hidden">
            {/* Phase header */}
            <button onClick={() => togglePhase(phase.id)}
              className="w-full flex items-center gap-3 p-3 hover:bg-zinc-800/30 transition-colors text-left">
              <span className="text-[10px] text-zinc-600">{isExpanded ? '\u25BC' : '\u25B6'}</span>
              <span className="text-xs font-medium text-zinc-200 flex-1">{phase.name}</span>
              <span className="text-[10px] text-zinc-500">{done}/{total}</span>
              <div className="w-20 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-indigo-500 to-green-500 rounded-full transition-all duration-500"
                  style={{ width: `${pct}%` }} />
              </div>
            </button>

            {/* Phase items */}
            {isExpanded && (
              <div className="border-t border-zinc-800 divide-y divide-zinc-800/50">
                {(phase.items || []).map(item => {
                  const task = taskMap[item.id];
                  const status = item.status || (task?.status === 'done' ? 'completed' : 'planned');
                  const review = task?.reviewResult;
                  const statusStyle = ITEM_STATUS_STYLES[status] || ITEM_STATUS_STYLES.planned;

                  return (
                    <div key={item.id} className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded border ${statusStyle}`}>{status}</span>
                        <span className="text-xs text-zinc-200 flex-1">{item.title}</span>
                        {item.assignedAgent && (
                          <span className="text-[9px] text-zinc-500">@{agentName(item.assignedAgent)}</span>
                        )}
                      </div>
                      {item.brief && <p className="text-[10px] text-zinc-500 mt-1 ml-6">{item.brief}</p>}
                      {item.acceptanceCriteria && (
                        <p className="text-[10px] text-zinc-600 mt-0.5 ml-6">
                          <span className="text-zinc-500">Acceptance:</span> {item.acceptanceCriteria}
                        </p>
                      )}
                      {review && (
                        <div className={`mt-1 ml-6 px-2 py-1.5 rounded text-[9px] border ${
                          review.passed ? 'bg-green-500/5 border-green-500/20 text-green-400' : 'bg-red-500/5 border-red-500/20 text-red-400'
                        }`}>
                          <span className="font-medium">{review.passed ? '✅ PASSED' : '❌ REWORK'}</span>
                          {review.feedback && <p className="text-zinc-400 mt-0.5 whitespace-pre-wrap">{review.feedback}</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Revision History */}
      {plan.revisions?.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/50">
          <button onClick={() => setShowRevisions(!showRevisions)}
            className="w-full flex items-center gap-2 p-3 hover:bg-zinc-800/30 transition-colors text-left">
            <span className="text-[10px] text-zinc-600">{showRevisions ? '\u25BC' : '\u25B6'}</span>
            <span className="text-[11px] font-medium text-zinc-400">Revision History ({plan.revisions.length})</span>
          </button>
          {showRevisions && (
            <div className="border-t border-zinc-800 p-3 space-y-2">
              {plan.revisions.map((rev, i) => (
                <div key={i} className="text-[10px] border-l-2 border-yellow-500/30 pl-2">
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-400">v{rev.version}</span>
                    {rev.ts && <span className="text-zinc-600">{new Date(rev.ts).toLocaleString()}</span>}
                  </div>
                  <p className="text-zinc-500 mt-0.5">{rev.reason}</p>
                  <div className="mt-0.5 text-zinc-600">
                    {(rev.changes || []).map((c, j) => (
                      <span key={j} className="mr-2">
                        {c.type === 'add' ? '+' : c.type === 'drop' ? '-' : '~'} {c.item?.title || c.itemId || ''}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Board View ───────────────────────────────────────────────────

const BOARD_COLUMNS = [
  { id: 'pending', color: 'text-zinc-400' },
  { id: 'in_progress', color: 'text-yellow-400' },
  { id: 'submitted', color: 'text-cyan-400' },
  { id: 'done', color: 'text-green-400' },
  { id: 'failed_cancelled', color: 'text-red-400' },
];

function BoardView({ t, tasks, project, availableAgents, showAddTasks, setShowAddTasks, onHumanAddTasks, onMarkDone, onCancel, onRefresh, onPreview, isClosed, agentName }) {
  const visibleTasks = tasks;
  const grouped = {};
  for (const col of BOARD_COLUMNS) grouped[col.id] = [];
  for (const task of visibleTasks) {
    const col = ['accepted', 'dispatched'].includes(task.status)
      ? 'in_progress'
      : ['failed', 'cancelled'].includes(task.status)
      ? 'failed_cancelled'
      : task.status;
    if (grouped[col]) grouped[col].push(task);
    else grouped['pending'].push(task);
  }

  const colLabels = {
    pending: t('projects.board.pending'),
    in_progress: t('projects.board.inProgress'),
    submitted: t('projects.board.review'),
    done: t('projects.board.done'),
    failed_cancelled: '异常',
  };

  return (
    <>
      {/* Human can always add tasks (key design: Human is boss) */}
      {!isClosed && (
        <div className="mb-3 flex items-center gap-2">
          <button onClick={() => setShowAddTasks(true)}
            className="px-2.5 py-1 text-[11px] rounded-md bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 hover:bg-indigo-600/30">
            + {t('projects.tasks.add')}（人工添加）
          </button>
          <span className="text-[10px] text-zinc-600">你可以随时添加任务，PO 会安排执行</span>
        </div>
      )}

      {showAddTasks && (
        <AddTasksForm t={t} availableAgents={availableAgents}
          onSubmit={async (taskList) => {
            await onHumanAddTasks(taskList);
            setShowAddTasks(false);
            onRefresh();
          }}
          onCancel={() => setShowAddTasks(false)} />
      )}

      {visibleTasks.length === 0 && !showAddTasks && (
        <div className="border border-dashed border-zinc-800 rounded-lg p-6 text-center">
          <p className="text-sm text-zinc-500">{t('projects.tasks.empty')}</p>
          <p className="text-[11px] text-zinc-600 mt-1">{t('projects.tasks.emptyHint')}</p>
        </div>
      )}

      {visibleTasks.length > 0 && (
        <div className="grid grid-cols-5 gap-2 min-h-[250px]">
          {BOARD_COLUMNS.map(col => (
            <div key={col.id} className="flex flex-col">
              <div className="flex items-center gap-1.5 mb-2 px-1">
                <span className={`text-[10px] font-medium uppercase tracking-wider ${col.color}`}>
                  {colLabels[col.id]}
                </span>
                <span className="text-[9px] px-1 rounded bg-zinc-800 text-zinc-500">
                  {grouped[col.id].length}
                </span>
              </div>
              <div className="flex-1 flex flex-col gap-1.5">
                {grouped[col.id].map(task => (
                  <TaskCard key={task.id} t={t} task={task}
                    showMarkDone={col.id === 'submitted'}
                    onMarkDone={() => { onMarkDone(task.id); setTimeout(onRefresh, 300); }}
                    onCancel={() => { onCancel(task.id); setTimeout(onRefresh, 300); }}
                    onPreview={onPreview}
                    agentName={agentName} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const TASK_STATUS_ICON = {
  pending: '⏸',
  dispatched: '📤',
  accepted: '📥',
  in_progress: '⚡',
  submitted: '📝',
  done: '✅',
  failed: '❌',
  cancelled: '⛔',
};

function TaskCard({ t, task, showMarkDone, onMarkDone, onCancel, onPreview, agentName }) {
  const hasArtifacts = task.result?.artifacts?.length > 0;
  const review = task.reviewResult;
  const icon = TASK_STATUS_ICON[task.status] || '○';

  return (
    <div className="p-2 rounded-md border border-zinc-800 bg-zinc-950/50 hover:border-zinc-700 transition-colors relative">
      {task.status === 'pending' && onCancel && (
        <button onClick={(e) => { e.stopPropagation(); onCancel(); }}
          title="取消任务"
          className="absolute top-1 right-1 text-[10px] text-zinc-600 hover:text-red-400 leading-none">
          ✕
        </button>
      )}
      <p className="text-[11px] text-zinc-200 font-medium leading-tight pr-3">
        <span className="mr-1">{icon}</span>{task.title}
      </p>
      {task.assignedAgent && (
        <p className="text-[9px] text-zinc-500 mt-0.5">@{agentName ? agentName(task.assignedAgent) : task.assignedAgent}</p>
      )}
      {review && (
        <div className={`mt-1 px-1.5 py-1 rounded text-[9px] ${
          review.passed
            ? 'bg-green-500/10 border border-green-500/20 text-green-400'
            : 'bg-red-500/10 border border-red-500/20 text-red-400'
        }`}>
          <span className="font-medium">{review.passed ? 'PASSED' : 'REWORK'}</span>
          {review.feedback && <p className="mt-0.5 text-zinc-400 line-clamp-2">{review.feedback}</p>}
        </div>
      )}
      {hasArtifacts && (
        <div className="mt-1 flex flex-wrap gap-1">
          {task.result.artifacts.map((art, i) => {
            const artifact = typeof art === 'string' ? { filename: art, url: `/api/artifacts/${art}` } : art;
            return (
              <button key={i} onClick={(e) => { e.stopPropagation(); onPreview(artifact); }}
                className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 truncate max-w-full">
                {artifact.filename}
              </button>
            );
          })}
        </div>
      )}
      {showMarkDone && (
        <button onClick={(e) => { e.stopPropagation(); onMarkDone(); }}
          className="mt-1.5 w-full text-[10px] py-1 rounded bg-green-600/20 text-green-400 border border-green-500/30 hover:bg-green-600/30">
          {t('projects.tasks.markDone')}
        </button>
      )}
    </div>
  );
}

// ─── Activity Timeline ────────────────────────────────────────────

const EVENT_META = {
  'project.created': { icon: '+', color: 'bg-blue-500', label: '创建项目' },
  'po.assigned': { icon: 'PO', color: 'bg-purple-500', label: '指定 PO' },
  'tasks.created': { icon: 'T', color: 'bg-cyan-500', label: 'PO 创建任务' },
  'tasks.added_by_human': { icon: 'H', color: 'bg-indigo-500', label: '人工添加任务' },
  'project.approved': { icon: '!', color: 'bg-green-500', label: '审批通过' },
  'task.assigned': { icon: '→', color: 'bg-blue-400', label: '分配任务' },
  'task.dispatched': { icon: '>', color: 'bg-blue-500', label: '派发任务' },
  'task.accepted': { icon: 'A', color: 'bg-yellow-500', label: '接受任务' },
  'task.progress': { icon: '~', color: 'bg-yellow-400', label: '执行中' },
  'task.submitted': { icon: 'S', color: 'bg-cyan-500', label: '提交结果' },
  'task.done': { icon: 'D', color: 'bg-green-500', label: '确认完成' },
  'task.rework': { icon: 'R', color: 'bg-orange-500', label: '要求返工' },
  'project.delivered': { icon: 'V', color: 'bg-purple-500', label: 'PO 提交交付' },
  'project.closed': { icon: 'X', color: 'bg-zinc-500', label: '项目关闭' },
  'approval.pending': { icon: '?', color: 'bg-yellow-500', label: '等待审批' },
  'plan.submitted': { icon: 'P', color: 'bg-indigo-500', label: '提交计划' },
  'plan.revised': { icon: '~', color: 'bg-yellow-500', label: '修订计划' },
  'task.reviewed': { icon: 'Q', color: 'bg-cyan-500', label: 'PO 质量验收' },
};

function ActivityTimeline({ activities, humanActions, t, onPreview, agentName }) {
  if (!activities || activities.length === 0) {
    return <div className="text-center p-8 text-zinc-500 text-sm">{t('projects.detail.noOutput')}</div>;
  }

  return (
    <div className="space-y-0">
      {activities.map((event, i) => {
        const meta = EVENT_META[event.type] || { icon: '.', color: 'bg-zinc-600', label: event.type };
        const time = event.ts ? new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
        const agent = event.agent || event.by || event.target || event.confirmedBy || '';
        const taskTitle = event.taskTitle || event.title || '';
        const artifacts = event.output?.artifacts || [];

        return (
          <div key={i} className="flex items-start gap-3 py-2 hover:bg-zinc-900/30 rounded px-2">
            <div className="flex flex-col items-center mt-0.5">
              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white ${meta.color}`}>
                {meta.icon}
              </div>
              {i < activities.length - 1 && <div className="w-px h-6 bg-zinc-800 mt-1" />}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-zinc-200">{meta.label}</span>
                {agent && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">@{agent}</span>}
                {taskTitle && <span className="text-[10px] text-zinc-500">"{taskTitle}"</span>}
              </div>

              {/* Show task assignments in detail */}
              {event.tasks && (
                <div className="mt-1 text-[10px] text-zinc-500">
                  {event.tasks.map((t, j) => (
                    <span key={j} className="mr-2">
                      {t.title}{t.assignedAgent ? ` → @${agentName(t.assignedAgent)}` : ''}
                    </span>
                  ))}
                </div>
              )}

              {/* Clickable artifacts */}
              {artifacts.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {artifacts.map((art, j) => {
                    const artifact = typeof art === 'string' ? { filename: art, url: `/api/artifacts/${art}` } : art;
                    return (
                      <button key={j} onClick={() => onPreview(artifact)}
                        className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20">
                        {artifact.filename}
                      </button>
                    );
                  })}
                </div>
              )}

              {event.count && <span className="text-[10px] text-zinc-600 ml-1">{event.count} tasks</span>}
            </div>

            <span className="text-[10px] text-zinc-600 shrink-0 font-mono">{time}</span>
          </div>
        );
      })}

      {/* Human actions summary */}
      {humanActions && humanActions.length > 0 && (
        <div className="mt-4 pt-4 border-t border-zinc-800">
          <h4 className="text-[11px] font-medium text-zinc-400 mb-2 uppercase tracking-wider">你的操作记录</h4>
          {humanActions.map((action, i) => (
            <div key={i} className="flex items-center gap-2 py-1 text-[11px]">
              <span className="w-4 h-4 rounded-full bg-indigo-500 flex items-center justify-center text-[8px] text-white font-bold">H</span>
              <span className="text-zinc-300">{action.action}</span>
              {action.projectName && <span className="text-zinc-500">— {action.projectName}</span>}
              <span className="text-zinc-600 font-mono ml-auto">{new Date(action.ts).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Deliverable View ─────────────────────────────────────────────

function DeliverableView({ project, tasks, t, onPreview, agentName }) {
  return (
    <div className="space-y-4">
      {project.deliverable ? (
        <div className="p-4 rounded-lg border border-purple-500/30 bg-purple-500/5">
          <h4 className="text-xs font-medium text-purple-400 mb-2">{t('projects.detail.deliverable')}</h4>
          <pre className="text-sm text-zinc-200 whitespace-pre-wrap font-sans">
            {typeof project.deliverable === 'string' ? project.deliverable : JSON.stringify(project.deliverable, null, 2)}
          </pre>
          {project.deliveredAt && (
            <p className="text-[10px] text-zinc-500 mt-2">
              {t('projects.detail.deliveredAt')}: {new Date(project.deliveredAt).toLocaleString()}
            </p>
          )}
        </div>
      ) : (
        <div className="p-4 rounded-lg border border-dashed border-zinc-800 text-center text-zinc-500 text-sm">
          PO 尚未提交交付物
        </div>
      )}

      <div>
        <h4 className="text-xs font-medium text-zinc-400 mb-3">{t('projects.detail.taskOutput')}</h4>
        <div className="space-y-2">
          {tasks.map(task => (
            <div key={task.id} className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/30">
              <div className="flex items-center gap-2 mb-1">
                <span className={`w-2 h-2 rounded-full ${task.status === 'done' ? 'bg-green-500' : task.status === 'submitted' ? 'bg-cyan-500' : 'bg-zinc-600'}`} />
                <span className="text-xs font-medium text-zinc-200">{task.title}</span>
                <span className="text-[10px] text-zinc-500">@{agentName(task.assignedAgent) || '—'}</span>
              </div>
              {task.result ? (
                <div className="mt-1 pl-4 border-l-2 border-zinc-800">
                  {task.result.summary && <p className="text-[11px] text-zinc-400">{task.result.summary}</p>}
                  {task.result.artifacts && task.result.artifacts.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {task.result.artifacts.map((art, i) => {
                        const artifact = typeof art === 'string' ? { filename: art, url: `/api/artifacts/${art}` } : art;
                        return (
                          <button key={i} onClick={() => onPreview(artifact)}
                            className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20">
                            {artifact.filename}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-[10px] text-zinc-600 pl-4">{t('projects.detail.noOutput')}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Artifact Preview Modal ───────────────────────────────────────

function ArtifactPreview({ artifact, onClose }) {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(true);

  // URL: could be /projects/:id/artifacts/:file or /artifacts/:file
  const url = artifact.url?.startsWith('/') ? `/api${artifact.url}` : artifact.url;
  const ext = artifact.filename?.split('.').pop()?.toLowerCase();
  const previewable = ['html', 'md', 'txt', 'json', 'svg'].includes(ext);

  useEffect(() => {
    if (previewable && url) {
      setLoading(true);
      fetch(url)
        .then(r => r.text())
        .then(text => { setContent(text); setLoading(false); })
        .catch(() => { setContent('Failed to load'); setLoading(false); });
    } else {
      setLoading(false);
    }
  }, [url]);

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-8" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-3xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <div>
            <h3 className="text-sm font-medium text-zinc-200">{artifact.filename}</h3>
            <span className="text-[10px] text-zinc-500">{artifact.mimeType || ext}</span>
          </div>
          <div className="flex items-center gap-2">
            {url && (
              <a href={url} download={artifact.filename}
                className="px-2.5 py-1 text-[11px] rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700">
                下载
              </a>
            )}
            <button onClick={onClose} className="px-2.5 py-1 text-[11px] text-zinc-400 hover:text-zinc-200">关闭</button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="text-center text-zinc-500 py-8">Loading...</div>
          ) : previewable ? (
            ext === 'html' || ext === 'svg' ? (
              <iframe srcDoc={content} className="w-full h-full min-h-[400px] bg-white rounded" sandbox="allow-scripts" />
            ) : ext === 'md' ? (
              <div className="prose prose-invert prose-sm max-w-none">
                <MarkdownRender content={content} />
              </div>
            ) : (
              <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono">{content}</pre>
            )
          ) : (
            <div className="text-center py-12">
              <p className="text-zinc-400 text-sm mb-3">此文件类型不支持预览</p>
              <a href={url} download={artifact.filename}
                className="px-4 py-2 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 inline-block">
                下载文件
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Simple markdown renderer (basic)
function MarkdownRender({ content }) {
  if (!content) return null;
  const html = content
    .replace(/^## (.+)$/gm, '<h2 class="text-base font-semibold text-zinc-200 mt-4 mb-2">$1</h2>')
    .replace(/^### (.+)$/gm, '<h3 class="text-sm font-medium text-zinc-300 mt-3 mb-1">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-zinc-200">$1</strong>')
    .replace(/^- (.+)$/gm, '<li class="text-zinc-400 text-xs ml-4">$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li class="text-zinc-400 text-xs ml-4">$1. $2</li>')
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>');
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

// ─── Add Tasks Form ───────────────────────────────────────────────

function AddTasksForm({ t, availableAgents, onSubmit, onCancel }) {
  const [rows, setRows] = useState([{ title: '', assignedAgent: '' }]);

  const addRow = () => setRows([...rows, { title: '', assignedAgent: '' }]);
  const updateRow = (i, field, value) => {
    const next = [...rows];
    next[i] = { ...next[i], [field]: value };
    setRows(next);
  };

  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      const tasks = rows.filter(r => r.title.trim()).map((r, i) => ({
        id: `task-${Date.now()}-${i}`,
        title: r.title.trim(),
        brief: '',
        assignedAgent: r.assignedAgent || null,
        dependencies: [],
      }));
      if (tasks.length > 0) await onSubmit(tasks);
    }} className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/50 mb-3">
      <h4 className="text-xs font-medium text-zinc-400 mb-2">{t('projects.tasks.add')}</h4>
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex gap-2">
            <input value={row.title} onChange={e => updateRow(i, 'title', e.target.value)}
              placeholder="Task title..."
              className="flex-1 px-2 py-1.5 text-xs rounded border border-zinc-700 bg-zinc-900 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500" />
            <select value={row.assignedAgent} onChange={e => updateRow(i, 'assignedAgent', e.target.value)}
              className="w-32 px-2 py-1.5 text-xs rounded border border-zinc-700 bg-zinc-900 text-zinc-200 focus:outline-none focus:border-indigo-500">
              <option value="">{t('projects.tasks.assignTo')}...</option>
              {availableAgents.map(a => (
                <option key={a.participantId} value={a.participantId}>{a.alias || a.participantId.split('-')[0]}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-3">
        <button type="button" onClick={addRow} className="text-[11px] text-zinc-500 hover:text-zinc-300">+ {t('projects.tasks.addRow')}</button>
        <div className="flex-1" />
        <button type="button" onClick={onCancel} className="px-3 py-1 text-[11px] text-zinc-400 hover:text-zinc-200">{t('projects.tasks.cancel')}</button>
        <button type="submit" className="px-3 py-1 text-[11px] rounded bg-indigo-600 text-white hover:bg-indigo-500">{t('projects.tasks.save')}</button>
      </div>
    </form>
  );
}
