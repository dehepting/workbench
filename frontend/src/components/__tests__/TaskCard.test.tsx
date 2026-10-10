import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskCard } from '../TaskCard';
import type { Task } from '../../lib/api';

const mockTask: Task = {
  id: 't_test123',
  project_id: 'p_test',
  title: 'Test Task',
  description: 'Test description',
  column_name: 'todo',
  priority: 7,
  assignee: null,
  labels: ['test', 'frontend'],
  deps: [],
  next_task_title: '',
  requires_review: false,
  max_retries: 3,
  retry_count: 0,
  lease_holder: null,
  lease_expires_at: null,
  created_at: '2026-10-10T00:00:00Z',
  updated_at: '2026-10-10T00:00:00Z',
  started_at: null,
  completed_at: null,
  meta: {},
};

describe('TaskCard', () => {
  it('renders task title', () => {
    render(<TaskCard task={mockTask} onClick={() => {}} />);
    expect(screen.getByText('Test Task')).toBeInTheDocument();
  });

  it('displays high priority badge for priority > 5', () => {
    render(<TaskCard task={mockTask} onClick={() => {}} />);
    expect(screen.getByText('P7')).toBeInTheDocument();
  });

  it('does not display priority badge for low priority', () => {
    const lowPriorityTask = { ...mockTask, priority: 3 };
    render(<TaskCard task={lowPriorityTask} onClick={() => {}} />);
    expect(screen.queryByText('P3')).not.toBeInTheDocument();
  });

  it('displays labels', () => {
    render(<TaskCard task={mockTask} onClick={() => {}} />);
    expect(screen.getByText('test')).toBeInTheDocument();
    expect(screen.getByText('frontend')).toBeInTheDocument();
  });

  it('shows blocked badge when has dependencies', () => {
    const blockedTask = { ...mockTask, deps: ['t_other'] };
    render(<TaskCard task={blockedTask} onClick={() => {}} />);
    expect(screen.getByTitle('Has dependencies')).toBeInTheDocument();
  });

  it('shows retry badge when retry_count > 0', () => {
    const retryingTask = { ...mockTask, retry_count: 2 };
    render(<TaskCard task={retryingTask} onClick={() => {}} />);
    expect(screen.getByTitle('Retry 2/3')).toBeInTheDocument();
  });

  it('shows review badge when requires_review is true', () => {
    const reviewTask = { ...mockTask, requires_review: true };
    render(<TaskCard task={reviewTask} onClick={() => {}} />);
    expect(screen.getByTitle('Requires review')).toBeInTheDocument();
  });

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<TaskCard task={mockTask} onClick={onClick} />);

    const card = screen.getByText('Test Task').closest('.task-card');
    if (card) {
      await user.click(card);
      expect(onClick).toHaveBeenCalledTimes(1);
    }
  });

  it('truncates long descriptions', () => {
    const longDesc = 'a'.repeat(150);
    const longDescTask = { ...mockTask, description: longDesc };
    render(<TaskCard task={longDescTask} onClick={() => {}} />);

    const descElement = screen.getByText(/aaa\.\.\.$/);
    expect(descElement.textContent?.length).toBeLessThan(longDesc.length);
  });

  it('shows task ID', () => {
    render(<TaskCard task={mockTask} onClick={() => {}} />);
    expect(screen.getByText('t_test123'.slice(0, 12))).toBeInTheDocument();
  });
});
