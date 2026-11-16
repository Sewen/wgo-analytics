import type { StoredFile } from './files';

/**
 * File lists per table, project and day range (store/duck.ts), kept briefly per container. Writes and merges
 * in the same container clear it, so a dev server or test reads its own writes at once.
 */
export const listCache = new Map<string, { files: StoredFile[]; exp: number }>();
export const forgetFileLists = () => listCache.clear();
