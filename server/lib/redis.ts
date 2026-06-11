import { Redis } from '@upstash/redis';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_ENABLED = REDIS_URL.startsWith('https://') && REDIS_TOKEN.length > 0;

let redis: Redis | null = null;

function getRedisClient(): Redis | null {
  if (!REDIS_ENABLED) return null;
  if (!redis) {
    redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  }
  return redis;
}

export async function getCache(key: string): Promise<any | null> {
  const client = getRedisClient();
  if (!client) return null;
  try {
    return await client.get(key);
  } catch (err) {
    console.warn('[Redis] Get failed:', err);
    return null;
  }
}

export async function setCache(key: string, value: any, ttlSeconds: number): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.set(key, value, { ex: ttlSeconds });
  } catch (err) {
    console.warn('[Redis] Set failed:', err);
  }
}
