import { useAgents, useTasks } from '../hooks/useStats';

const STATUS_COLORS = {
  starting: '#a371f7',
  running: '#3fb950',
  completed: '#4f9cf9',
  failed: '#f85149',
  killed: '#d29922',
};

function formatElapsed(startedAt: string): string {
  const elapsed = Date.now() - new Date(startedAt).getTime();
  if (elapsed < 60000) return `${(elapsed / 1000).toFixed(0)}s`;
  if (elapsed < 3600000) return `${(elapsed / 60000).toFixed(1)}m`;
  return `${(elapsed / 3600000).toFixed(1)}h`;
}

export function LiveTab() {
  const { data: agents, isLoading } = useAgents();
  const { data: tasks } = useTasks();

  if (isLoading) {
    return <div className="tab-content">Loading...</div>;
  }

  if (!agents || agents.length === 0) {
    return (
      <div className="tab-content">
        <h2>Live Agents</h2>
        <div className="empty-state">
          <p>No agents running</p>
          <p className="muted">Start agents with <code>npm run agents</code></p>
        </div>
      </div>
    );
  }

  return (
    <div className="tab-content live">
      <div className="live-header">
        <h2>Live Agents</h2>
        <div className="live-count">
          {agents.length} agent{agents.length !== 1 ? 's' : ''} active
        </div>
      </div>

      <div className="agents-list">
        {agents.map((agent) => {
          const task = tasks?.find((t) => t.id === agent.task_id);
          const taskTitle = task?.title || 'Unknown task';

          return (
            <div
              key={agent.id}
              className={`agent-card ${agent.status}`}
              style={{
                borderLeftColor: STATUS_COLORS[agent.status] || '#8b949e',
              }}
            >
              <div className="agent-header">
                <div className="agent-title">
                  <strong>{taskTitle}</strong>
                  <span className="task-id">{agent.task_id.slice(0, 12)}</span>
                </div>
                <div
                  className="agent-status"
                  style={{
                    color: STATUS_COLORS[agent.status] || '#8b949e',
                  }}
                >
                  {agent.status.toUpperCase()}
                </div>
              </div>

              <dl className="agent-details">
                <div>
                  <dt>Agent ID</dt>
                  <dd>{agent.id.slice(0, 12)}</dd>
                </div>
                <div>
                  <dt>PID</dt>
                  <dd>{agent.pid || '—'}</dd>
                </div>
                {agent.worktree_dir && (
                  <div>
                    <dt>Worktree</dt>
                    <dd className="truncate" title={agent.worktree_dir}>
                      ...{agent.worktree_dir.slice(-40)}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Elapsed</dt>
                  <dd>{formatElapsed(agent.started_at)}</dd>
                </div>
                {agent.last_commit && (
                  <div>
                    <dt>Last Commit</dt>
                    <dd>{agent.last_commit.slice(0, 8)}</dd>
                  </div>
                )}
                {agent.last_log_line && (
                  <div>
                    <dt>Last Log</dt>
                    <dd className="truncate" title={agent.last_log_line}>
                      {agent.last_log_line.slice(0, 80)}
                    </dd>
                  </div>
                )}
              </dl>

              {agent.ended_at && (
                <div className="agent-footer">
                  Ended: {new Date(agent.ended_at).toLocaleString()}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
