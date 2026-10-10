import { Task } from '../lib/api';

interface TaskCardProps {
  task: Task;
  onClick: () => void;
}

export function TaskCard({ task, onClick }: TaskCardProps) {
  const isBlocked = task.deps.length > 0;
  const isRetrying = task.retry_count > 0;

  return (
    <div className="task-card" onClick={onClick}>
      <div className="task-card-header">
        <span className="task-card-title">{task.title}</span>
        {task.priority > 5 && (
          <span className="task-priority high">P{task.priority}</span>
        )}
      </div>

      {task.description && (
        <p className="task-card-description">{task.description.slice(0, 100)}{task.description.length > 100 ? '...' : ''}</p>
      )}

      <div className="task-card-footer">
        <div className="task-card-meta">
          {task.labels.length > 0 && (
            <div className="task-card-labels">
              {task.labels.slice(0, 3).map((label) => (
                <span key={label} className="task-label">
                  {label}
                </span>
              ))}
              {task.labels.length > 3 && (
                <span className="task-label">+{task.labels.length - 3}</span>
              )}
            </div>
          )}
        </div>

        <div className="task-card-badges">
          {isBlocked && (
            <span className="task-badge blocked" title="Has dependencies">
              🔒
            </span>
          )}
          {isRetrying && (
            <span className="task-badge retry" title={`Retry ${task.retry_count}/${task.max_retries}`}>
              🔄
            </span>
          )}
          {task.requires_review && (
            <span className="task-badge review" title="Requires review">
              👁️
            </span>
          )}
        </div>
      </div>

      <div className="task-card-id">{task.id.slice(0, 12)}</div>
    </div>
  );
}
