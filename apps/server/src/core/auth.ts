import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { Role, UserPublic } from '@livechat/shared';
import type { Db } from './db.js';
import type { Config } from './config.js';

// ─── Passwords (scrypt, no external deps) ────────────────────
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

// ─── Tokens ──────────────────────────────────────────────────
export interface AgentTokenPayload {
  sub: string;      // user id
  role: Role;
  typ: 'agent';
}

export interface VisitorTokenPayload {
  sub: string;      // visitor id
  websiteId: string;
  typ: 'visitor';
}

export function signAgentToken(config: Config, userId: string, role: Role): string {
  return jwt.sign({ sub: userId, role, typ: 'agent' }, config.jwtSecret, { expiresIn: '12h' });
}

export function signVisitorToken(config: Config, visitorId: string, websiteId: string): string {
  return jwt.sign({ sub: visitorId, websiteId, typ: 'visitor' }, config.jwtSecret, { expiresIn: '90d' });
}

export function verifyToken<T extends AgentTokenPayload | VisitorTokenPayload>(
  config: Config,
  token: string,
): T | null {
  try {
    return jwt.verify(token, config.jwtSecret) as T;
  } catch {
    return null;
  }
}

// ─── DB row → public shape ───────────────────────────────────
export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  max_chats: number;
  avatar_color: string;
  avatar_url?: string | null;
  created_at: string;
}

export function toUserPublic(row: UserRow): UserPublic {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    maxChats: Number(row.max_chats),
    avatarColor: row.avatar_color,
    avatarUrl: row.avatar_url ?? null,
  };
}

// ─── Express middleware ──────────────────────────────────────
export interface AuthedRequest extends Request {
  user?: UserRow;
}

export function requireAgent(db: Db, config: Config) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization || '';
    const token =
      header.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string | undefined) || '';
    const payload = verifyToken<AgentTokenPayload>(config, token);
    if (!payload || payload.typ !== 'agent') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const user = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', [payload.sub]);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    req.user = user;
    next();
  };
}

export function requireRole(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}
