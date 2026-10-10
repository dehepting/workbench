import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Task } from '../lib/api';
import { api } from '../lib/api';

interface TaskModalProps {
  task: Task;
  onClose: () => void;
}

const COLUMNS = ['backlog', 'todo', 'doing', 'review', 'done', 'failed'];
const COLUMN_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  doing: 'Doing',
  review: 'Review',
  done: 'Done',
  failed: 'Failed',
};

export function TaskModal({ task, onClose }: TaskModalProps) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showComments, setShowComments] = useState(false);

  const handleMove = async (column: string) => {
    setSubmitting(true);
    setError(null);
    try {
      await api.moveTask(task.id, column, 'web-ui');
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to move task');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete task "${task.title}"?`)) return;

    setSubmitting(true);
    setError(null);
    try {
      await fetch(`/api/tasks/${task.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: 'web-ui' }),
      });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete task');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClaim = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await fetch(`/api/tasks/${task.id}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'web-ui' }),
      });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to claim task');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRelease = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await fetch(`/api/tasks/${task.id}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'web-ui' }),
      });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to release task');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddComment = async () => {
    if (!comment.trim()) return;

    setSubmitting(true);
    setError(null);
    try {
      await fetch(`/api/tasks/${task.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: 'web-ui', body: comment.trim() }),
      });
      setComment('');
      // Optionally refetch task to get updated comments
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add comment');
    } finally {
      setSubmitting(false);
    }
  };

  const isLeased = !!task.lease_holder;
  const canRelease = task.lease_holder === 'web-ui';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content task-modal-large" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{task.title}</h2>
          <button onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {error && (
            <div className="error-message">{error}</div>
          )}

          <div className="modal-section">
            <label>Description</label>
            <p>{task.description || 'No description'}</p>
          </div>

          <div className="modal-grid">
            <div className="modal-section">
              <label>Status</label>
              <p className="modal-value">{COLUMN_LABELS[task.column_name]}</p>
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

          {isLeased && (
            <div className="modal-section">
              <label>Lease</label>
              <p className="modal-value">
                {task.lease_holder} until{' '}
                {task.lease_expires_at
                  ? new Date(task.lease_expires_at).toLocaleTimeString()
                  : 'unknown'}
              </p>
            </div>
          )}

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

          {/* Actions */}
          <div className="modal-section">
            <label>Actions</label>
            <div className="task-actions">
              {canRelease ? (
                <button onClick={handleRelease} disabled={submitting}>
                  Release Lease
                </button>
              ) : !isLeased ? (
                <button onClick={handleClaim} disabled={submitting} className="primary">
                  Claim as web-ui
                </button>
              ) : null}

              <div className="move-buttons">
                {COLUMNS.filter(col => col !== task.column_name).map((col) => (
                  <button
                    key={col}
                    onClick={() => handleMove(col)}
                    disabled={submitting}
                    className="move-button"
                  >
                    → {COLUMN_LABELS[col]}
                  </button>
                ))}
              </div>

              <button
                onClick={handleDelete}
                disabled={submitting}
                className="delete-button"
              >
                Delete Task
              </button>
            </div>
          </div>

          {/* Comments */}
          <div className="modal-section">
            <button
              className="expand-button"
              onClick={() => setShowComments(!showComments)}
            >
              {showComments ? '▼' : '▶'} Comments & Activity
            </button>

            {showComments && (
              <div className="comments-section">
                <div className="comment-input-row">
                  <input
                    type="text"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Add a comment..."
                    onKeyPress={(e) => e.key === 'Enter' && handleAddComment()}
                    disabled={submitting}
                  />
                  <button onClick={handleAddComment} disabled={submitting || !comment.trim()}>
                    Post
                  </button>
                </div>
                <p className="comments-placeholder">
                  Comments will appear here. Use the backend API to view existing comments.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
