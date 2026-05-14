/**
 * ProjectsPage — project list with Projects/Agents tabs, create modals.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, FolderKanban, ArrowLeft } from 'lucide-react';
import { useKSwarm } from '../../hooks/useKSwarm';
import { ProjectCard } from './ProjectCard';
import { CreateProjectModal } from './CreateProjectModal';
import { CreateAgentModal } from './CreateAgentModal';
import { AgentsTab } from './AgentsTab';

export function ProjectsPage() {
  const navigate = useNavigate();
  const { projects, agents, createProject, connected } = useKSwarm();
  const [activeTab, setActiveTab] = useState('projects');
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateAgent, setShowCreateAgent] = useState(false);

  const handleCreate = async (input) => { await createProject(input); };

  const TABS = [
    { id: 'projects', label: '项目', count: projects.length },
    { id: 'agents', label: '智能体', count: agents.length },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white text-gray-900">
      <div className="flex items-center gap-1 border-b border-gray-200 px-6 py-3">
        {TABS.map(tab => (
          <button key={tab.id} type="button" data-testid={`tab-${tab.id}`} onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12px] font-medium transition-colors ${
              activeTab === tab.id ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-500'
            }`}>
            <span>{tab.label}</span>
            <span className="text-[10px] text-gray-500">{tab.count}</span>
          </button>
        ))}
        {!connected && (
          <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400">离线</span>
        )}
        <div className="flex-1" />
        {activeTab === 'projects' && (
          <button type="button" data-testid="btn-create-project" onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">
            <Plus size={15} /><span>新建项目</span>
          </button>
        )}
        {activeTab === 'agents' && (
          <button type="button" data-testid="btn-create-agent" onClick={() => setShowCreateAgent(true)}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">
            <Plus size={15} /><span>新建智能体</span>
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeTab === 'projects' && (
          projects.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-gray-100">
                <FolderKanban size={28} className="text-gray-500" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-900">还没有项目</p>
                <p className="mt-1 text-xs text-gray-500">创建一个项目，让 AI 团队帮你完成复杂任务</p>
              </div>
              <button type="button" onClick={() => setShowCreate(true)}
                className="mt-2 flex items-center gap-1.5 rounded-lg border border-gray-200 px-4 py-1.5 text-sm font-medium text-gray-500 hover:bg-gray-100">
                <Plus size={15} /><span>创建第一个项目</span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map(project => <ProjectCard key={project.id} project={project} />)}
            </div>
          )
        )}
        {activeTab === 'agents' && <AgentsTab />}
      </div>

      <CreateProjectModal open={showCreate} agents={agents} onClose={() => setShowCreate(false)} onCreate={handleCreate} />
      <CreateAgentModal open={showCreateAgent} onClose={() => setShowCreateAgent(false)} />
    </div>
  );
}
