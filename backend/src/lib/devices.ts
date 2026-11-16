import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Device, DeviceCreated } from '../contract';
import { query } from './db';
import { HttpError } from './http';
import { isUuid } from './projects';

/**
 * Device tokens: long-lived, read-only credentials for the Android widget.
 * A token belongs to a user (email) and grants read access to the widget API for that user's projects only.
 * Only the SHA-256 of the token is stored, so a database dump can't be replayed.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MAX_DEVICES = 20;

export function generateDeviceToken(): string {
  // 40 chars over a 62-symbol alphabet ≈ 238 bits; the modulo bias is irrelevant at this length
  let out = 'dt_';
  for (const b of randomBytes(40)) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

interface Row {
  id: string;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
}
const toDevice = (r: Row): Device => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
});

export async function listDevices(email: string): Promise<Device[]> {
  const rows = await query<Row>(
    'SELECT id, name, created_at, last_used_at FROM device_tokens WHERE email = $1 ORDER BY created_at DESC',
    [email],
  );
  return rows.map(toDevice);
}

export async function createDevice(email: string, rawName: unknown): Promise<DeviceCreated> {
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 60) : 'Android device';
  const [{ n }] = await query<{ n: number }>('SELECT count(*)::int AS n FROM device_tokens WHERE email = $1', [email]);
  if (n >= MAX_DEVICES) throw new HttpError(400, `You can connect at most ${MAX_DEVICES} devices. Revoke an old one first.`);
  const id = randomUUID();
  const token = generateDeviceToken();
  const rows = await query<Row>(
    `INSERT INTO device_tokens (id, email, name, token_hash) VALUES ($1, $2, $3, $4)
     RETURNING id, name, created_at, last_used_at`,
    [id, email, name, hashToken(token)],
  );
  return { device: toDevice(rows[0]), token };
}

export async function revokeDevice(email: string, id: string): Promise<void> {
  if (!isUuid(id)) throw new HttpError(404, 'Device not found');
  const rows = await query<{ id: string }>('DELETE FROM device_tokens WHERE id = $1 AND email = $2 RETURNING id', [id, email]);
  if (!rows[0]) throw new HttpError(404, 'Device not found');
  for (const [k, v] of tokenCache) if (v.id === id) tokenCache.delete(k);
}

// token hash -> owner, cached briefly per container. Revocation takes effect within TOKEN_CACHE_MS
// on other warm containers (immediately on the one that handled the revoke).
const TOKEN_CACHE_MS = 30_000;
const tokenCache = new Map<string, { id: string; email: string; exp: number }>();
// last_used_at is bookkeeping for the dashboard; write it at most every 10 minutes per device
const TOUCH_EVERY_MS = 10 * 60_000;

export async function authenticateDevice(token: string | undefined): Promise<{ id: string; email: string }> {
  if (!token || !/^dt_[A-Za-z0-9]{20,80}$/.test(token)) throw new HttpError(401, 'Missing or malformed device token');
  const h = hashToken(token);
  const hit = tokenCache.get(h);
  if (hit && hit.exp > Date.now()) return hit;
  const rows = await query<{ id: string; email: string; last_used_at: Date | null }>(
    'SELECT id, email, last_used_at FROM device_tokens WHERE token_hash = $1',
    [h],
  );
  const row = rows[0];
  if (!row) throw new HttpError(401, 'This device was disconnected. Pair it again from the dashboard.');
  if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > TOUCH_EVERY_MS) {
    await query('UPDATE device_tokens SET last_used_at = now() WHERE id = $1', [row.id]).catch((e) => console.warn('touch failed', e));
  }
  const entry = { id: row.id, email: row.email, exp: Date.now() + TOKEN_CACHE_MS };
  tokenCache.set(h, entry);
  if (tokenCache.size > 1000) tokenCache.delete(tokenCache.keys().next().value!);
  return entry;
}
