import { useProviders } from '../hooks/useStats';

const TIER_COLORS: Record<string, string> = {
  A: '#3fb950',
  B: '#4f9cf9',
  C: '#8b949e',
};

export function ProvidersCard() {
  const { data: providersData } = useProviders();

  if (!providersData?.providers) {
    return null;
  }

  const configured = providersData.providers.filter(p => p.configured);
  const healthy = configured.filter(p => p.healthy);

  return (
    <div className="card">
      <h3>LLM Providers ({healthy.length}/{configured.length} healthy)</h3>
      <div className="providers-list">
        {providersData.providers
          .filter(p => p.configured)
          .map((provider) => (
            <div key={provider.provider} className="provider-item">
              <div className="provider-header">
                <span className="provider-name">{provider.provider}</span>
                <div className="provider-badges">
                  <span
                    className="tier-badge"
                    style={{ background: TIER_COLORS[provider.tier] }}
                  >
                    {provider.tier}
                  </span>
                  <span
                    className={`status-badge ${provider.healthy ? 'healthy' : 'down'}`}
                  >
                    {provider.healthy ? '✓' : '✗'}
                  </span>
                </div>
              </div>
              <div className="provider-models">
                {provider.models.slice(0, 2).map(model => (
                  <span key={model} className="model-tag">
                    {model.split('/').pop()}
                  </span>
                ))}
                {provider.models.length > 2 && (
                  <span className="model-tag">+{provider.models.length - 2}</span>
                )}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
