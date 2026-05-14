import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import { ProjectsPage } from './components/projects/ProjectsPage';
import { ProjectDetailPage } from './components/projects/ProjectDetailPage';
import { useKSwarm } from './hooks/useKSwarm';
import { StatusBar } from './components/StatusBar';

export default function App() {
  return (
    <Router>
      <div className="flex h-screen flex-col bg-white text-gray-900">
        <Header />
        <main className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<ProjectsPage />} />
            <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

/**
 * Shared top bar — matches xiaok's header exactly.
 * No tabs here; each page manages its own sub-tabs.
 */
function Header() {
  const kswarm = useKSwarm();
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-gray-200 px-5">
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-xs font-bold">K</div>
        <span className="text-sm font-semibold tracking-tight">KSwarm</span>
      </div>
      <div className="flex-1" />
      <StatusBar connected={kswarm.connected} brokerConnected={kswarm.brokerConnected} />
    </header>
  );
}
