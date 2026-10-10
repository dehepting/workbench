import { useState } from 'react';
import { useTasks } from '../hooks/useStats';
import { useProjects } from '../hooks/useProjects';
import type { Task } from '../lib/api';
import { TaskCard } from './TaskCard';
import { TaskModal } from './TaskModal';

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
