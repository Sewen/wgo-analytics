import type { SQSClient } from '@aws-sdk/client-sqs';
import type { EventRow } from '../events';
import { writeRows } from './write';

/**
 * Browser events reach storage through a queue: the ingest function answers the SDK straight away, and the
 * writer (handlers/store.ts) turns everything that arrived within WriteBufferSeconds into one Parquet file per
 * project and day. Without EVENTS_QUEUE_URL (dev server, tests) events are written directly.
 */
const MAX_MESSAGE_BYTES = 200 * 1024; // SQS allows 256 KiB per message

let sqs: SQSClient | null = null;

/** Split rows into JSON arrays of at most `max` bytes each (a single bigger row gets a message of its own). */
export function chunkJson(rows: unknown[], max = MAX_MESSAGE_BYTES): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let size = 2;
  for (const r of rows) {
    const s = JSON.stringify(r);
    if (cur.length && size + s.length + 1 > max) {
      out.push(`[${cur.join(',')}]`);
      cur = [];
      size = 2;
    }
    cur.push(s);
    size += s.length + 1;
  }
  if (cur.length) out.push(`[${cur.join(',')}]`);
  return out;
}

export async function storeEvents(rows: EventRow[]): Promise<void> {
  if (!rows.length) return;
  const url = process.env.EVENTS_QUEUE_URL;
  if (!url) {
    await writeRows('events', rows);
    return;
  }
  const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
  sqs ??= new SQSClient({});
  await Promise.all(chunkJson(rows).map((body) => sqs!.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body }))));
}

/** Rows from queued message bodies (dates arrive as ISO strings). */
export function eventsFromMessages(bodies: string[]): EventRow[] {
  return bodies.flatMap((b) => (JSON.parse(b) as EventRow[]).map((r) => ({ ...r, ts: new Date(r.ts) })));
}
