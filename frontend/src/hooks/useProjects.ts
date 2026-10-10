import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => api.getProjects(),
    refetchInterval: 10000,
  });
}
