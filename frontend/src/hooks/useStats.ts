import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useStats() {
  return useQuery({
    queryKey: ['stats'],
    queryFn: () => api.getStats(),
    refetchInterval: 5000, // Refresh every 5s
  });
}

export function useTasks(projectId?: string) {
  return useQuery({
    queryKey: ['tasks', projectId],
    queryFn: () => api.getTasks(projectId),
    refetchInterval: 5000,
  });
}

export function useLedger() {
  return useQuery({
    queryKey: ['ledger'],
    queryFn: () => api.getLedger(),
    refetchInterval: 5000,
  });
}

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => api.getProviders(),
    refetchInterval: 10000,
  });
}

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => api.getAgents(),
    refetchInterval: 3000, // Refresh every 3s for live updates
  });
}
