import { useState } from 'react';
import { useTasks } from '../hooks/useStats';
import { useProjects } from '../hooks/useProjects';
import type { Task } from '../lib/api';
import { TaskCard } from './TaskCard';

const COLUMNS = [
  { id: 'backlog', label: 'Backlog', color: '#8b949e' },
  { id: 'todo', label: 'To Do', color: '#a371f7' },
  { id: 'doing', label: 'Doing', color: '#d29922' },
  { id: 'review', label: 'Review', color: '#4f9cf9' },
  { id: 'done', label: 'Done', color: '#3fb950' },
  { id: 'failed', label: 'Failed', color: '#f85149' },
];

export function BoardTab() {
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const { data: projects } = useProjects();
  const { data: tasks, isLoading } = useTasks(selectedProjectId || undefined);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  if (isLoading) {
    return <div className="tab-content">Loading...</div>;
  }

  // Group tasks by column
  const tasksByColumn = COLUMNS.reduce((acc, col) => {
    acc[col.id] = (tasks || []).filter((t) => t.column_name === col.id);
    return acc;
  }, {} as Record<string, Task[]>);

  return (
    <div className="board-container">
      <div className="board-header">
        <div className="board-controls">
          <label htmlFor="project-select">Project:</label>
          <select
            id="project-select"
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            className="project-select"
          >
            <option value="">All Projects</option>
            {projects?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
                {project.repo ? ` (${project.repo})` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="board-stats">
          <span className="board-stat">
            {tasks?.length || 0} tasks
          </span>
        </div>
      </div>

      <div className="board-columns">
        {COLUMNS.map((column) => (
          <div key={column.id} className="board-column">
            <div className="column-header" style={{ borderTopColor: column.color }}>
              <h3>{column.label}</h3>
              <span className="column-count">{tasksByColumn[column.id].length}</span>
            </div>
            <div className="column-tasks">
              {tasksByColumn[column.id].length === 0 ? (
                <div className="column-empty">No tasks</div>
              ) : (
                tasksByColumn[column.id].map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onClick={() => setSelectedTask(task)}
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      {selectedTask && (
        <TaskModal task={selectedTask} onClose={() => setSelectedTask(null)} />
      )}
    </div>
  );
}

function TaskModal({ task, onClose }: { task: Task; onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{task.title}</h2>
          <button onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="modal-section">
            <label>Description</label>
            <p>{task.description || 'No description'}</p>
          </div>

          <div className="modal-grid">
            <div className="modal-section">
              <label>Status</label>
              <p className="modal-value">{task.column_name}</p>
            </div>

            <div className="modal-section">
              <label>Priority</label>
              <p className="modal-value">{task.priority}</p>
            </div>

            {task.assignee && (
              <div className="modal-section">
                <label>Assignee</label>
                <p className="modal-value">{task.assignee}</p>
              </div>
            )}

            <div className="modal-section">
              <label>Created</label>
              <p className="modal-value">
                {new Date(task.created_at).toLocaleDateString()}
              </p>
            </div>

            {task.completed_at && (
              <div className="modal-section">
                <label>Completed</label>
                <p className="modal-value">
                  {new Date(task.completed_at).toLocaleDateString()}
                </p>
              </div>
            )}

            {task.retry_count > 0 && (
              <div className="modal-section">
                <label>Retries</label>
                <p className="modal-value">
                  {task.retry_count} / {task.max_retries}
                </p>
              </div>
            )}
          </div>

          {task.labels.length > 0 && (
            <div className="modal-section">
              <label>Labels</label>
              <div className="label-cloud">
                {task.labels.map((label) => (
                  <span key={label} className="label-tag">
                    {label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {task.deps.length > 0 && (
            <div className="modal-section">
              <label>Dependencies</label>
              <div className="deps-list">
                {task.deps.map((dep) => (
                  <code key={dep} className="dep-id">
                    {dep}
                  </code>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
