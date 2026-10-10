import { useState } from 'react';
import { api } from '../lib/api';
import { useQueryClient } from '@tanstack/react-query';

interface NewTaskModalProps {
  onClose: () => void;
}

export function NewTaskModal({ onClose }: NewTaskModalProps) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(5);
  const [labels, setLabels] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await api.createTask({
        title: title.trim(),
        description: description.trim(),
        priority,
        labels: labels
          .split(',')
          .map((l) => l.trim())
          .filter((l) => l.length > 0),
        column_name: 'backlog',
        deps: [],
        requires_review: false,
        max_retries: 3,
      });

      // Invalidate tasks query to refetch
      queryClient.invalidateQueries({ queryKey: ['tasks'] });

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>New Task</h2>
          <button onClick={onClose}>✕</button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body">
          {error && (
            <div className="error-message">{error}</div>
          )}

          <div className="form-group">
            <label htmlFor="title">Title *</label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title"
              autoFocus
              disabled={submitting}
            />
          </div>

          <div className="form-group">
            <label htmlFor="description">Description</label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Task description"
              rows={4}
              disabled={submitting}
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="priority">Priority</label>
              <input
                id="priority"
                type="number"
                min="1"
                max="10"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                disabled={submitting}
              />
            </div>

            <div className="form-group">
              <label htmlFor="labels">Labels</label>
              <input
                id="labels"
                type="text"
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                placeholder="comma, separated, labels"
                disabled={submitting}
              />
            </div>
          </div>

          <div className="form-actions">
            <button type="button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
