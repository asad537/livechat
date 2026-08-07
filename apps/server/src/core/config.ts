import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface Config {
  port: number;
  publicUrl: string;
  jwtSecret: string;
  databaseUrl: string;      // 'file:...' → SQLite, 'postgres://...' → PostgreSQL
  redisUrl: string | null;
  dailyApiKey: string | null;
  anthropicApiKey: string | null;
  aiModel: string;
  aiGreeter: boolean;
  s3Bucket: string | null;
  scanMode: 'permissive' | 'strict';
  storageDir: string;
  serverRoot: string;
  repoRoot: string;
}

export function loadConfig(): Config {
  // Load repo-root .env (Node 20.12+ built-in; no dotenv dependency needed)
  try {
    process.loadEnvFile(path.resolve(serverRoot, '../../.env'));
  } catch {
    /* .env is optional */
  }
  const env = process.env;
  return {
    port: Number(env.PORT || 4000),
    publicUrl: env.PUBLIC_URL || `http://localhost:${Number(env.PORT || 4000)}`,
    jwtSecret: env.JWT_SECRET || 'dev-secret-do-not-use-in-production',
    databaseUrl: env.DATABASE_URL || 'mysql://root@127.0.0.1:3306/livechat',
    redisUrl: env.REDIS_URL || null,
    dailyApiKey: env.DAILY_API_KEY || null,
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    aiModel: env.AI_MODEL || 'claude-opus-5',
    aiGreeter: env.AI_GREETER !== 'off',
    s3Bucket: env.S3_BUCKET || null,
    scanMode: env.SCAN_MODE === 'strict' ? 'strict' : 'permissive',
    storageDir: env.STORAGE_DIR || path.join(serverRoot, 'storage'),
    serverRoot,
    repoRoot: path.resolve(serverRoot, '../..'),
  };
}
