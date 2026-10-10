import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../api';

// Mock fetch
global.fetch = vi.fn();

describe('API Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getTasks makes GET request to /api/tasks', async () => {
    const mockTasks = [{ id: 't_1', title: 'Test' }];
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockTasks,
    });

    const result = await api.getTasks();

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/tasks',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    );
    expect(result).toEqual(mockTasks);
  });

  it('getTasks with projectId includes query parameter', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    await api.getTasks('p_123');

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/tasks?project_id=p_123',
      expect.any(Object)
    );
  });

  it('createTask makes POST request with task data', async () => {
    const newTask = { title: 'New Task', column_name: 'backlog' };
    const createdTask = { id: 't_new', ...newTask };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => createdTask,
    });

    const result = await api.createTask(newTask);

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/tasks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(newTask),
      })
    );
    expect(result).toEqual(createdTask);
  });

  it('moveTask makes POST request to move endpoint', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => undefined,
    });

    await api.moveTask('t_123', 'doing', 'test-agent');

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/tasks/t_123/move',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ column: 'doing', actor: 'test-agent' }),
      })
    );
  });

  it('throws error on non-ok response', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      statusText: 'Not Found',
      json: async () => ({ error: 'Task not found' }),
    });

    await expect(api.getTask('t_invalid')).rejects.toThrow('Task not found');
  });

  it('getProviders fetches provider data', async () => {
    const mockProviders = { providers: [{ provider: 'groq', healthy: true }] };
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockProviders,
    });

    const result = await api.getProviders();

    expect(global.fetch).toHaveBeenCalledWith('/api/providers', expect.any(Object));
    expect(result).toEqual(mockProviders);
  });
});
