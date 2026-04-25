import { Redis } from '@upstash/redis';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Look for .env in the root directory (two levels up from server/lib)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

let redis: Redis | null = null;

function getRedisClient(): Redis {
  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL || '',
      token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
    });
  }
  return redis;
}

export async function getCache(key: string): Promise<any | null> {
  try {
    return await getRedisClient().get(key);
  } catch (err) {
    console.warn('[Redis] Get failed:', err);
    return null;
  }
}

export async function setCache(key: string, value: any, ttlSeconds: number): Promise<void> {
  try {
    await getRedisClient().set(key, value, { ex: ttlSeconds });
  } catch (err) {
    console.warn('[Redis] Set failed:', err);
  }
}
