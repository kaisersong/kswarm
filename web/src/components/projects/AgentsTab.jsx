/**
 * AgentsTab — agent management embedded in ProjectsPage.
 */

import { useState, useEffect } from 'react';
import { Play, Square, Settings, Trash2, Wifi, WifiOff, Bot } from 'lucide-react';
import { useKSwarm } from '../../hooks/useKSwarm';
import { EditAgentModal } from './EditAgentModal';

export function AgentsTab() {
  const { agents, fetchAgents, startAgent, stopAgent, archiveAgent, probeAgent, pingHeartbeat, connected } = useKSwarm();
  const [editingAgent, setEditingAgent] = useState(null);
  const [probes, setProbes] = useState({});
  const [confirmArchive, setConfirmArchive] = useState(null);

  useEffect(() => {
    if (agents.length === 0) return;
    agents.forEach(agent => {
      if (agent.runtimeType) {
        probeAgent(agent.id).then(p => {
          if (p) setProbes(prev => ({ ...prev, [agent.id]: p }));
        });
      }
    });
  }, [agents, probeAgent]);

  // Ping heartbeats for online agents periodically
  useEffect(() => {
    const onlineAgents = agents.filter(a => a.status !== 'offline');
    if (onlineAgents.length === 0) return;
    const timer = setInterval(() => {
      onlineAgents.forEach(a => { pingHeartbeat(a.id).catch(() => {}); });
    }, 15000);
    return () => clearInterval(timer);
  }, [agents.map(a => `${a.id}:${a.status}`).join(','), pingHeartbeat]);

  const handleStart = async (id) => { await startAgent(id); await fetchAgents(); };
  const handleStop = async (id) => { await stopAgent(id); await fetchAgents(); };
  const handleArchive = async (id) => { await archiveAgent(id); await fetchAgents(); setConfirmArchive(null); };

  const getStatusStyle = (status) => {
    switch (status) {
      case 'idle': return { dot: 'bg-green-400', label: '空闲' };
      case 'working': return { dot: 'bg-yellow-400 animate-pulse', label: '工作中' };
      case 'blocked': return { dot: 'bg-yellow-400', label: '阻塞' };
      case 'error': return { dot: 'bg-red-400', label: '错误' };
      default: return { dot: 'bg-gray-400', label: '离线' };
    }
  };

  const getRoleLabel = (agent) => {
    const isPO = agent.roles?.includes('project_owner');
    const isWorker = agent.roles?.includes('worker');
    if (isPO && isWorker) return '全能型';
    if (isPO) return '项目负责人';
    return '执行者';
  };

  return (
    <div className="p-6">
      {agents.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 py-16">
          <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-gray-100">
            <Bot size={28} className="text-gray-500" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-gray-900">还没有智能体</p>
            <p className="mt-1 text-xs text-gray-500">点击右上角「新建智能体」创建</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {agents.map(agent => {
            const { dot, label } = getStatusStyle(agent.status);
            const probe = probes[agent.id];
            const isOnline = agent.status !== 'offline';
            return (
              <div key={agent.id} className="flex items-center gap-4 rounded-xl border border-gray-200 bg-gray-50 p-4 hover:bg-gray-50">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-100">
                  <span className="text-sm font-bold text-gray-500">{agent.name.charAt(0).toUpperCase()}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-gray-900 truncate">{agent.name}</span>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">{getRoleLabel(agent)}</span>
                    {agent.runtimeType && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">{agent.runtimeType}</span>}
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                    <span className="text-[11px] text-gray-500">{label}</span>
                    {probe && probe.probe !== 'skip' && (
                      <span className="flex items-center gap-1 text-[10px] text-gray-500">
                        {probe.healthy ? <Wifi size={10} className="text-green-400" /> : <WifiOff size={10} className="text-red-400" />}
                        {probe.version && <span>v{probe.version}</span>}
                        {probe.error && <span className="text-red-400">{probe.error}</span>}
                      </span>
                    )}
                    {probe && probe.probe === 'skip' && (
                      <span className="text-[10px] text-gray-400">无需探测</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {isOnline ? (
                    <button type="button" onClick={() => handleStop(agent.id)} className="rounded-md p-1.5 text-red-400 hover:bg-gray-100" title="停止"><Square size={14} /></button>
                  ) : (
                    <button type="button" onClick={() => handleStart(agent.id)} className="rounded-md p-1.5 text-green-400 hover:bg-gray-100" title="启动"><Play size={14} /></button>
                  )}
                  <button type="button" onClick={() => setEditingAgent(agent)} className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900" title="配置"><Settings size={14} /></button>
                  {confirmArchive === agent.id ? (
                    <div className="flex items-center gap-1 ml-1">
                      <button type="button" onClick={() => handleArchive(agent.id)} className="rounded-md px-2 py-1 text-[10px] font-medium bg-red-400 text-white">确认</button>
                      <button type="button" onClick={() => setConfirmArchive(null)} className="rounded-md px-2 py-1 text-[10px] font-medium text-gray-500 hover:bg-gray-100">取消</button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setConfirmArchive(agent.id)} className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-red-400" title="归档"><Trash2 size={14} /></button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editingAgent && <EditAgentModal agent={editingAgent} onClose={() => setEditingAgent(null)} />}
    </div>
  );
}
