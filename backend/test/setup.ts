import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Raw data (Parquet) goes to a fresh directory per test file; DSQL tables still come from DATABASE_URL.
process.env.STORE_URL = mkdtempSync(join(tmpdir(), 'wgo-store-'));
delete process.env.EVENTS_QUEUE_URL;
