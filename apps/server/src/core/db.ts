import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';

/**
 * Database adapter. Three implementations:
 *  - MySQL/MariaDB via `mysql2`  (default — works with XAMPP out of the box)
 *  - SQLite via node:sqlite      (automatic fallback when MySQL is unreachable)
 *  - PostgreSQL via `pg`         (DATABASE_URL=postgres://…; install `pg` first)
 *
 * Rules for query authors (keep SQL portable):
 *  - `?` placeholders only (translated to $n for Postgres automatically)
 *  - ISO-8601 TEXT timestamps (use nowIso())
 *  - INTEGER 0/1 for booleans
 */
export interface Db {
  readonly dialect: 'mysql' | 'sqlite' | 'postgres';
  run(sql: string, params?: unknown[]): Promise<void>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

function cleanParams(params: unknown[] = []): unknown[] {
  return params.map((p) => (p === undefined ? null : p));
}

class MySqlDb implements Db {
  readonly dialect = 'mysql' as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private pool: any) {}

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.pool.query(sql, cleanParams(params));
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const [rows] = await this.pool.query(sql, cleanParams(params));
    return (rows as T[])[0];
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.pool.query(sql, cleanParams(params));
    return rows as T[];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class SqliteDb implements Db {
  readonly dialect = 'sqlite' as const;
  private db: InstanceType<typeof import('node:sqlite').DatabaseSync>;

  constructor(file: string, DatabaseSync: typeof import('node:sqlite').DatabaseSync) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...(cleanParams(params) as never[]));
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...(cleanParams(params) as never[])) as T | undefined;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(cleanParams(params) as never[])) as T[];
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

class PostgresDb implements Db {
  readonly dialect = 'postgres' as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private pool: any) {}

  private translate(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.pool.query(this.translate(sql), cleanParams(params));
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const res = await this.pool.query(this.translate(sql), cleanParams(params));
    return res.rows[0] as T | undefined;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query(this.translate(sql), cleanParams(params));
    return res.rows as T[];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

async function createSqlite(config: Config): Promise<Db> {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(config.serverRoot, 'data', 'livechat.db');
  const db = new SqliteDb(file, DatabaseSync);
  await migrate(db, config);
  return db;
}

export async function createDb(config: Config): Promise<Db> {
  const url = config.databaseUrl;

  if (url.startsWith('postgres')) {
    const { default: pg } = await import('pg' as string);
    const pool = new pg.Pool({ connectionString: url });
    const db = new PostgresDb(pool);
    await migrate(db, config);
    return db;
  }

  if (url.startsWith('mysql')) {
    try {
      const mysql = await import('mysql2/promise');
      const pool = mysql.createPool({
        uri: url,
        charset: 'utf8mb4',
        waitForConnections: true,
        connectionLimit: 10,
      });
      await pool.query('SELECT 1');
      const db = new MySqlDb(pool);
      await migrate(db, config);
      console.log(`[db] connected to MySQL (${url.replace(/\/\/.*@/, '//***@')})`);
      return db;
    } catch (err) {
      console.warn(
        `[db] MySQL unreachable (${(err as Error).message}). ` +
          'Falling back to built-in SQLite. Start XAMPP MySQL to use MySQL.',
      );
      return createSqlite(config);
    }
  }

  return createSqlite(config);
}

async function migrate(db: Db, config: Config): Promise<void> {
  const schema = fs.readFileSync(path.join(config.serverRoot, 'schema.sql'), 'utf8');
  const statements = schema
    // Strip line/inline "--" comments FIRST (they may contain ';' which would
    // otherwise fragment the statement split below).
    .replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    try {
      await db.run(stmt);
    } catch (err) {
      const msg = String((err as Error).message).toLowerCase();
      // MySQL < 8 / MariaDB variants without IF NOT EXISTS support on indexes
      if (msg.includes('exist') || msg.includes('duplicate')) continue;
      throw err;
    }
  }
}
