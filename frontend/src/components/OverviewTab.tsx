import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useLedger, useStats, useTasks } from '../hooks/useStats';

const COLUMNS = ['backlog', 'todo', 'doing', 'review', 'done', 'failed'];
const COLUMN_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  doing: 'Doing',
  review: 'Review',
  done: 'Done',
  failed: 'Failed',
};

function formatMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 60e3) return `${(ms / 1e3).toFixed(0)}s`;
  if (ms < 36e5) return `${(ms / 6e4).toFixed(1)}m`;
  return `${(ms / 36e5).toFixed(1)}h`;
}

export function OverviewTab() {
  const { data: stats, isLoading: statsLoading } = useStats();
  const { data: tasks, isLoading: tasksLoading } = useTasks();
  const { data: ledger } = useLedger();

  if (statsLoading || tasksLoading) {
    return <div className="tab-content">Loading...</div>;
  }

  // Tasks by column
  const byColumn = COLUMNS.reduce((acc, col) => {
    acc[col] = (tasks || []).filter((t) => t.column_name === col).length;
    return acc;
  }, {} as Record<string, number>);

  // Chart data
  const chartData = COLUMNS.map((col) => ({
    name: COLUMN_LABELS[col],
    count: byColumn[col],
  }));

  // Tasks by label
  const byLabel: Record<string, number> = {};
  (tasks || []).forEach((t) => {
    (t.labels || []).forEach((label) => {
      byLabel[label] = (byLabel[label] || 0) + 1;
    });
  });

  return (
    <div className="tab-content overview">
      <h2>Overview</h2>

      {/* Stats Cards */}
      <div className="stats-grid">
        <StatCard title="Total Tasks" value={tasks?.length || 0} />
        <StatCard title="WIP" value={stats?.wip || 0} color="amber" />
        <StatCard title="Done Today" value={stats?.doneToday || 0} color="green" />
        <StatCard title="Failed" value={stats?.failed || 0} color="red" />
      </div>

      {/* Charts and Tables */}
      <div className="content-grid">
        {/* Tasks by Column Chart */}
        <div className="card">
          <h3>Tasks by Column</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData}>
              <XAxis dataKey="name" stroke="#8b949e" />
              <YAxis stroke="#8b949e" />
              <Tooltip
                contentStyle={{
                  background: '#161b22',
                  border: '1px solid #2d333b',
                  borderRadius: '6px',
                }}
              />
              <Bar dataKey="count" fill="#4f9cf9" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Performance Metrics */}
        <div className="card">
          <h3>Performance Metrics</h3>
          <dl className="metrics-list">
            <div>
              <dt>Throughput</dt>
              <dd>{stats?.throughputPerDay || 0} tasks/day</dd>
            </div>
            <div>
              <dt>Cycle Time</dt>
              <dd>{formatMs(stats?.medianCycleMs || null)}</dd>
            </div>
            <div>
              <dt>Total Spend</dt>
              <dd>${ledger?.total?.cost || 0}</dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Labels */}
      {Object.keys(byLabel).length > 0 && (
        <div className="card">
          <h3>Tasks by Label</h3>
          <div className="label-cloud">
            {Object.entries(byLabel)
              .sort((a, b) => b[1] - a[1])
              .map(([label, count]) => (
                <span key={label} className="label-tag">
                  {label} ({count})
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  title,
  value,
  color,
}: {
  title: string;
  value: number;
  color?: 'green' | 'red' | 'amber';
}) {
  return (
    <div className={`stat-card ${color || ''}`}>
      <div className="stat-title">{title}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
