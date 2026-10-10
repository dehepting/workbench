// API client for Workbench backend

const API_BASE = '/api';

export interface Task {
  id: string;
  project_id: string | null;
  title: string;
  description: string;
  column_name: string;
  priority: number;
  assignee: string | null;
  labels: string[];
  deps: string[];
  next_task_title: string;
  requires_review: boolean;
  max_retries: number;
  retry_count: number;
  lease_holder: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  meta: Record<string, unknown>;
}

export interface Project {
  id: string;
  name: string;
  status: string;
  client_view: boolean;
  created_at: string;
  meta: Record<string, unknown>;
  repo: string | null;
  tasks?: Task[];
  wip?: Array<{ column_name: string; limit_value: number }>;
}

export interface Stats {
  wip: number;
  doneToday: number;
  throughputPerDay: number;
  medianCycleMs: number | null;
  failed: number;
}

export interface Ledger {
  total: {
    cost: number;
  };
}

export interface Agent {
  id: string;
  task_id: string;
  pid: number | null;
  worktree_dir: string | null;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'killed';
  started_at: string;
  ended_at: string | null;
  last_commit: string | null;
  last_log_line: string | null;
}

export interface Provider {
  provider: string;
  tier: string;
  configured: boolean;
  healthy: boolean;
  avg_latency_ms: number | null;
  fails: number;
  models: string[];
}

class APIClient {
  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || response.statusText);
    }

    return response.json();
  }

  // Projects
  async getProjects(): Promise<Project[]> {
    return this.request('/projects');
  }

  async getProject(id: string): Promise<Project> {
    return this.request(`/projects/${id}`);
  }

  // Tasks
  async getTasks(projectId?: string): Promise<Task[]> {
    const qs = projectId ? `?project_id=${projectId}` : '';
    return this.request(`/tasks${qs}`);
  }

  async getTask(id: string): Promise<Task> {
    return this.request(`/tasks/${id}`);
  }

  async createTask(task: Partial<Task>): Promise<Task> {
    return this.request('/tasks', {
      method: 'POST',
      body: JSON.stringify(task),
    });
  }

  async moveTask(id: string, column: string, actor: string): Promise<void> {
    return this.request(`/tasks/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ column, actor }),
    });
  }

  // Stats & Metrics
  async getStats(): Promise<Stats> {
    return this.request('/stats');
  }

  async getLedger(): Promise<Ledger> {
    return this.request('/ledger');
  }

  // Agents
  async getAgents(): Promise<Agent[]> {
    return this.request('/agents');
  }

  // Providers
  async getProviders(): Promise<{ providers: Provider[] }> {
    return this.request('/providers');
  }

  // SSE connection
  createEventSource(): EventSource {
    return new EventSource('/events');
  }
}

export const api = new APIClient();
