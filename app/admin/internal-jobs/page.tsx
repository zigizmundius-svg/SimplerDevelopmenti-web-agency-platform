'use client';

import { useCallback, useEffect, useState } from 'react';

type JobStatus = 'pending' | 'running' | 'completed' | 'dead_letter';
type Job = {
  id: number;
  clientId: number;
  type: string;
  status: JobStatus;
  attemptCount: number;
  nextRetryAt: string | null;
  error: string | null;
  dedupeKey: string | null;
  createdAt: string;
  processedAt: string | null;
};
type Counts = Record<JobStatus, number>;

const filters: Array<{ value: JobStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All jobs' },
  { value: 'dead_letter', label: 'Failed permanently' },
  { value: 'pending', label: 'Pending' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
];

function dateTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : '—';
}

function statusStyle(status: JobStatus) {
  if (status === 'dead_letter') return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
  if (status === 'running') return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
  if (status === 'pending') return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300';
  return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
}

export default function InternalJobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [counts, setCounts] = useState<Counts>({ pending: 0, running: 0, completed: 0, dead_letter: 0 });
  const [filter, setFilter] = useState<JobStatus | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const query = filter === 'all' ? '' : `?status=${filter}`;
      const response = await fetch(`/api/admin/internal-jobs${query}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || 'Could not load jobs');
      setJobs(result.data ?? []);
      setCounts(result.counts ?? { pending: 0, running: 0, completed: 0, dead_letter: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load jobs');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  async function retry(id: number) {
    setRetrying(id);
    setError('');
    try {
      const response = await fetch('/api/admin/internal-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || 'Could not retry job');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not retry job');
    } finally {
      setRetrying(null);
    }
  }

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Background jobs</h1>
          <p className="text-sm text-muted-foreground mt-1">Durable booking emails, calendar sync, and other queued work.</p>
        </div>
        <button onClick={() => void load()} className="px-3 py-2 rounded-md border border-border text-sm hover:bg-accent">Refresh</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(['pending', 'running', 'completed', 'dead_letter'] as const).map((status) => (
          <button key={status} onClick={() => setFilter(status)} className="text-left rounded-lg border border-border bg-card p-4 hover:bg-accent">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">{status.replace('_', ' ')}</div>
            <div className="text-2xl font-semibold font-mono mt-1">{counts[status]}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {filters.map((item) => (
          <button key={item.value} onClick={() => setFilter(item.value)} className={`px-3 py-1.5 rounded-md text-sm border ${filter === item.value ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-accent'}`}>
            {item.label}
          </button>
        ))}
      </div>

      {error && <div role="alert" className="rounded-md border border-red-300 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300 p-3 text-sm">{error}</div>}

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-sm text-muted-foreground">Loading jobs…</div>
        ) : jobs.length === 0 ? (
          <div className="p-8 text-sm text-muted-foreground">No jobs in this view.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">Job</th>
                  <th className="p-3">Tenant</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Attempts</th>
                  <th className="p-3">Created</th>
                  <th className="p-3">Next retry / processed</th>
                  <th className="p-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-t border-border align-top">
                    <td className="p-3">
                      <div className="font-medium text-foreground">{job.type}</div>
                      <div className="text-xs text-muted-foreground font-mono">#{job.id} · {job.dedupeKey ?? 'no dedupe key'}</div>
                      {job.error && <div className="mt-2 max-w-md text-xs text-red-700 dark:text-red-300 whitespace-pre-wrap break-words">{job.error}</div>}
                    </td>
                    <td className="p-3 font-mono">{job.clientId}</td>
                    <td className="p-3"><span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusStyle(job.status)}`}>{job.status.replace('_', ' ')}</span></td>
                    <td className="p-3 font-mono">{job.attemptCount}/3</td>
                    <td className="p-3 whitespace-nowrap">{dateTime(job.createdAt)}</td>
                    <td className="p-3 whitespace-nowrap">{dateTime(job.nextRetryAt || job.processedAt)}</td>
                    <td className="p-3">
                      {job.status === 'dead_letter' && (
                        <button disabled={retrying === job.id} onClick={() => void retry(job.id)} className="px-2.5 py-1.5 rounded-md border border-border hover:bg-accent disabled:opacity-50">
                          {retrying === job.id ? 'Retrying…' : 'Retry'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">The list shows the latest 150 jobs. Retrying a failed job resets its attempt counter and returns it to the queue.</p>
    </div>
  );
}
