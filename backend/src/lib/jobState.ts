import { query } from './db';

/** Timestamps the scheduled maintenance jobs keep between runs (see handlers/maintenance.ts). */
export async function getJobState(name: string): Promise<Date | null> {
  const rows = await query<{ at: Date }>('SELECT at FROM job_state WHERE name = $1', [name]);
  return rows[0]?.at ?? null;
}

export async function setJobState(name: string, at: Date): Promise<void> {
  await query('INSERT INTO job_state (name, at) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET at = EXCLUDED.at', [name, at]);
}
