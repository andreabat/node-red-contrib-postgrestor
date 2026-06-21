import type { SchemaPayload } from './types';

export interface CacheEntry {
  payload: SchemaPayload;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

export function getSchemaCache(): Map<string, CacheEntry> {
  return cache;
}
