import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import './App.css';

// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5000,
    },
  },
});

type Tab = 'board' | 'overview' | 'live' | 'debug';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>(
    (localStorage.getItem('wb_tab') as Tab) || 'board'
  );

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    localStorage.setItem('wb_tab', tab);
  };

  return (
    <QueryClientProvider client={queryClient}>
      <div className="app">
        <header className="header">
          <h1>
            Work<span>bench</span>
          </h1>
          <button className="primary">+ New task</button>
        </header>

        <nav className="tabs">
          <button
            className={`tab ${activeTab === 'board' ? 'active' : ''}`}
            onClick={() => handleTabChange('board')}
          >
            Board
          </button>
          <button
            className={`tab ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => handleTabChange('overview')}
          >
            Overview
          </button>
          <button
            className={`tab ${activeTab === 'live' ? 'active' : ''}`}
            onClick={() => handleTabChange('live')}
          >
            Live
          </button>
          <button
            className={`tab ${activeTab === 'debug' ? 'active' : ''}`}
            onClick={() => handleTabChange('debug')}
          >
            Debug
          </button>
        </nav>

        <main className="main">
          {activeTab === 'board' && <BoardTab />}
          {activeTab === 'overview' && <OverviewTab />}
          {activeTab === 'live' && <LiveTab />}
          {activeTab === 'debug' && <DebugTab />}
        </main>
      </div>
    </QueryClientProvider>
  );
}

// Placeholder tab components
function BoardTab() {
  return <div className="tab-content">Board - Coming soon</div>;
}

function OverviewTab() {
  return <div className="tab-content">Overview - Coming soon</div>;
}

function LiveTab() {
  return <div className="tab-content">Live - Coming soon</div>;
}

function DebugTab() {
  return (
    <div className="tab-content">
      <h2>Debug</h2>
      <p>OpenTelemetry traces will appear here</p>
    </div>
  );
}

export default App;
