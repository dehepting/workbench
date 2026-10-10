import { useState } from 'react';
import { useProviders } from '../hooks/useStats';
import { api } from '../lib/api';

export function ConnectionsTab() {
  const { data: providersData, refetch } = useProviders();
  const [testing, setTesting] = useState<string | null>(null);

  const handleTest = async (provider: string) => {
    setTesting(provider);
    // Simulate testing - in real implementation, this would call a test endpoint
    await new Promise(resolve => setTimeout(resolve, 1500));
    await refetch();
    setTesting(null);
  };

  if (!providersData?.providers) {
    return <div className="tab-content">Loading...</div>;
  }

  const configured = providersData.providers.filter(p => p.configured);
  const unconfigured = providersData.providers.filter(p => !p.configured);
  const healthy = configured.filter(p => p.healthy).length;

  return (
    <div className="tab-content connections">
      <div className="connections-header">
        <h2>API Connections</h2>
        <div className="connection-stats">
          <span className="stat-badge healthy">{healthy} healthy</span>
          <span className="stat-badge total">{configured.length} configured</span>
          <span className="stat-badge available">{providersData.providers.length} total</span>
        </div>
      </div>

      {/* Configured Providers */}
      <div className="connections-section">
        <h3>Active Connections</h3>
        <div className="connections-grid">
          {configured.map((provider) => (
            <ConnectionCard
              key={provider.provider}
              provider={provider}
              onTest={handleTest}
              testing={testing === provider.provider}
            />
          ))}
        </div>
      </div>

      {/* Unconfigured Providers */}
      {unconfigured.length > 0 && (
        <div className="connections-section">
          <h3>Available Providers ({unconfigured.length})</h3>
          <div className="connections-grid">
            {unconfigured.map((provider) => (
              <ConnectionCard
                key={provider.provider}
                provider={provider}
                onTest={handleTest}
                testing={testing === provider.provider}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface ConnectionCardProps {
  provider: {
    provider: string;
    tier: string;
    configured: boolean;
    healthy: boolean;
    avg_latency_ms: number | null;
    fails: number;
    models: string[];
  };
  onTest: (provider: string) => void;
  testing: boolean;
}

function ConnectionCard({ provider, onTest, testing }: ConnectionCardProps) {
  const [expanded, setExpanded] = useState(false);

  const tierColors: Record<string, string> = {
    A: '#3fb950',
    B: '#4f9cf9',
    C: '#8b949e',
  };

  return (
    <div className={`connection-card ${provider.configured ? 'configured' : 'unconfigured'}`}>
      <div className="connection-card-header">
        <div className="connection-info">
          <div className="connection-title">
            <span className="connection-name">{provider.provider}</span>
            {provider.configured && (
              <span
                className={`connection-status ${provider.healthy ? 'healthy' : 'unhealthy'}`}
              >
                {provider.healthy ? '● Online' : '● Offline'}
              </span>
            )}
          </div>
          <div className="connection-meta">
            <span className="tier-badge" style={{ background: tierColors[provider.tier] }}>
              Tier {provider.tier}
            </span>
            <span className="model-count">{provider.models.length} models</span>
          </div>
        </div>

        {provider.configured && (
          <button
            className="test-button"
            onClick={() => onTest(provider.provider)}
            disabled={testing}
          >
            {testing ? 'Testing...' : 'Test'}
          </button>
        )}
      </div>

      {provider.configured && (
        <>
          <div className="connection-stats-row">
            <div className="stat-item">
              <span className="stat-label">Latency</span>
              <span className="stat-value">
                {provider.avg_latency_ms ? `${provider.avg_latency_ms}ms` : '—'}
              </span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Failures</span>
              <span className="stat-value" style={{ color: provider.fails > 0 ? 'var(--red)' : 'var(--text)' }}>
                {provider.fails}
              </span>
            </div>
          </div>

          <div className="connection-actions">
            <button
              className="expand-button"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? '▼' : '▶'} Models ({provider.models.length})
            </button>
          </div>

          {expanded && (
            <div className="models-list">
              {provider.models.map((model) => (
                <div key={model} className="model-item">
                  <code>{model}</code>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {!provider.configured && (
        <div className="unconfigured-notice">
          <p>Not configured</p>
          <small>Set environment variable to enable</small>
        </div>
      )}
    </div>
  );
}
