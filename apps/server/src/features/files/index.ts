/**
 * Secure file sharing — upload pipeline + authorized download.
 *
 * Pipeline (per SPEC): authorize → quarantine write → extension/size guard →
 * virus scan (clamdscan/clamscan when available, else SCAN_MODE policy) →
 * BLOCKED: delete + SYSTEM message · CLEAN: gzip to private storage + FILE message.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import {
  BLOCKED_EXTENSIONS,
  MAX_FILE_BYTES,
  type FileMeta,
  type Role,
  type ScanStatus,
} from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import {
  verifyToken,
  type AgentTokenPayload,
  type VisitorTokenPayload,
} from '../../core/auth.js';
import { newId, nowIso } from '../../core/db.js';
import { postMessage } from '../../domain/messages.js';

// ─── Row shapes ──────────────────────────────────────────────

interface FileRow {
  id: string;
  conversation_id: string;
  uploader_type: 'VISITOR' | 'AGENT';
  uploader_id: string;
  original_name: string;
  mime: string;
  size: number;
  scan_status: ScanStatus;
  stored_path: string | null;
  compressed_path: string | null;
  created_at: string;
}

interface ConversationRow {
  id: string;
  website_id: string;
  visitor_id: string;
  status: string;
  assigned_user_id: string | null;
}

type Actor =
  | { type: 'VISITOR'; id: string }
  | { type: 'AGENT'; id: string; role: Role };

// ─── Helpers ─────────────────────────────────────────────────

export function toFileMeta(row: FileRow): FileMeta {
  return {
    id: row.id,
    originalName: row.original_name,
    mime: row.mime,
    size: Number(row.size),
    scanStatus: row.scan_status,
    downloadUrl: `/api/files/${row.id}/download`,
  };
}

function extractToken(req: Request): string {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  const fromQuery = req.query.token;
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
  const fromBody = (req.body as Record<string, unknown> | undefined)?.token;
  if (typeof fromBody === 'string' && fromBody) return fromBody;
  return '';
}

/**
 * Authorize a token against a conversation. Allowed actors:
 * the conversation's visitor, the assigned agent, a LEAD of the website's
 * team, or any ADMIN.
 */
async function authorizeConversation(
  deps: AppDeps,
  token: string,
  conversationId: string,
): Promise<{ actor: Actor; conversation: ConversationRow } | null> {
  if (!token || !conversationId) return null;
  const payload = verifyToken<AgentTokenPayload | VisitorTokenPayload>(deps.config, token);
  if (!payload) return null;

  const conversation = await deps.db.get<ConversationRow>(
    'SELECT id, website_id, visitor_id, status, assigned_user_id FROM conversations WHERE id = ?',
    [conversationId],
  );
  if (!conversation) return null;

  if (payload.typ === 'visitor') {
    if (payload.sub !== conversation.visitor_id) return null;
    return { actor: { type: 'VISITOR', id: payload.sub }, conversation };
  }

  if (payload.typ === 'agent') {
    const user = await deps.db.get<{ id: string; role: Role }>(
      'SELECT id, role FROM users WHERE id = ?',
      [payload.sub],
    );
    if (!user) return null;
    const actor: Actor = { type: 'AGENT', id: user.id, role: user.role };
    // MANAGER may read (download) anywhere; uploads are blocked in the route.
    if (user.role === 'ADMIN' || user.role === 'MANAGER') return { actor, conversation };
    if (conversation.assigned_user_id === user.id) return { actor, conversation };
    // Team Lead of the assigned CSR
    if (user.role === 'LEAD' && conversation.assigned_user_id) {
      const csr = await deps.db.get(
        'SELECT id FROM users WHERE id = ? AND team_lead_id = ?',
        [conversation.assigned_user_id, user.id],
      );
      if (csr) return { actor, conversation };
    }
    return null;
  }

  return null;
}

// ─── Virus scanning ──────────────────────────────────────────

let resolvedScanner: string | null | undefined; // undefined = not looked up yet

function findScannerBinary(): string | null {
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of ['clamdscan', 'clamscan']) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* not here — keep looking */
      }
    }
  }
  return null;
}

async function scanFile(deps: AppDeps, filePath: string): Promise<'CLEAN' | 'BLOCKED'> {
  if (resolvedScanner === undefined) resolvedScanner = findScannerBinary();

  if (!resolvedScanner) {
    if (deps.config.scanMode === 'permissive') {
      console.log(
        '[files] no clamdscan/clamscan on PATH — SCAN_MODE=permissive, marking file CLEAN',
      );
      return 'CLEAN';
    }
    console.warn('[files] no clamdscan/clamscan on PATH — SCAN_MODE=strict, blocking file');
    return 'BLOCKED';
  }

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(resolvedScanner as string, ['--no-summary', filePath], {
      stdio: 'ignore',
    });
    child.on('error', () => resolve(2));
    child.on('close', (code) => resolve(code ?? 2));
  });

  if (exitCode === 0) return 'CLEAN'; // no threats found
  if (exitCode === 1) return 'BLOCKED'; // threat detected
  // Scanner error — fall back to configured policy
  console.warn(`[files] scanner exited with code ${exitCode} — applying SCAN_MODE=${deps.config.scanMode}`);
  return deps.config.scanMode === 'permissive' ? 'CLEAN' : 'BLOCKED';
}

// ─── Router ──────────────────────────────────────────────────

export function buildFilesRouter(deps: AppDeps): Router {
  const router = Router();
  const quarantineDir = path.join(deps.config.storageDir, 'quarantine');
  const privateDir = path.join(deps.config.storageDir, 'private');
  fs.mkdirSync(quarantineDir, { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true });

  const upload = multer({ storage: multer.memoryStorage() });

  router.post('/api/uploads', upload.single('file'), async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const conversationId =
        (typeof body.conversationId === 'string' && body.conversationId) ||
        (typeof req.query.conversationId === 'string' && req.query.conversationId) ||
        '';
      const token = extractToken(req);

      const auth = await authorizeConversation(deps, token, conversationId);
      if (!auth) {
        res.status(403).json({ error: 'Not authorized for this conversation' });
        return;
      }
      if (auth.actor.type === 'AGENT' && auth.actor.role === 'MANAGER') {
        res.status(403).json({ error: 'Managers have view-only access' });
        return;
      }
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "Missing 'file' field" });
        return;
      }

      const { actor, conversation } = auth;
      const fileId = newId();
      const originalName = (file.originalname || 'file').slice(0, 500);
      const quarantinePath = path.join(quarantineDir, fileId);

      // 1. Quarantine write
      await fs.promises.writeFile(quarantinePath, file.buffer);

      const uploaderType = actor.type;
      const uploaderId = actor.id;
      await deps.db.run(
        `INSERT INTO files
           (id, conversation_id, uploader_type, uploader_id, original_name, mime, size,
            scan_status, stored_path, compressed_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL, ?)`,
        [
          fileId,
          conversation.id,
          uploaderType,
          uploaderId,
          originalName,
          file.mimetype || 'application/octet-stream',
          file.size,
          quarantinePath,
          nowIso(),
        ],
      );

      // 2. Extension + size guard
      const ext = path.extname(originalName).slice(1).toLowerCase();
      let verdict: 'CLEAN' | 'BLOCKED';
      if (BLOCKED_EXTENSIONS.includes(ext)) {
        console.warn(`[files] blocked extension .${ext} (${originalName})`);
        verdict = 'BLOCKED';
      } else if (file.size > MAX_FILE_BYTES) {
        console.warn(`[files] file too large: ${file.size} bytes (${originalName})`);
        verdict = 'BLOCKED';
      } else {
        // 3. Virus scan
        verdict = await scanFile(deps, quarantinePath);
      }

      if (verdict === 'BLOCKED') {
        await fs.promises.rm(quarantinePath, { force: true });
        await deps.db.run(
          "UPDATE files SET scan_status = 'BLOCKED', stored_path = NULL WHERE id = ?",
          [fileId],
        );
        await postMessage(deps, {
          conversationId: conversation.id,
          senderType: 'SYSTEM',
          body: 'File blocked by security scan',
          kind: 'SYSTEM',
        });
        const row = await deps.db.get<FileRow>('SELECT * FROM files WHERE id = ?', [fileId]);
        res.json({ file: row ? toFileMeta(row) : null });
        return;
      }

      // 4. Compress to private storage
      const compressedPath = path.join(privateDir, `${fileId}.gz`);
      await pipeline(
        fs.createReadStream(quarantinePath),
        createGzip(),
        fs.createWriteStream(compressedPath),
      );
      await fs.promises.rm(quarantinePath, { force: true });
      await deps.db.run(
        "UPDATE files SET scan_status = 'CLEAN', stored_path = NULL, compressed_path = ? WHERE id = ?",
        [compressedPath, fileId],
      );

      // 5. FILE chat message
      const message = await postMessage(deps, {
        conversationId: conversation.id,
        senderType: actor.type === 'AGENT' ? 'AGENT' : 'VISITOR',
        senderUserId: actor.type === 'AGENT' ? actor.id : null,
        body: originalName,
        kind: 'FILE',
        fileId,
      });

      const row = await deps.db.get<FileRow>('SELECT * FROM files WHERE id = ?', [fileId]);
      res.json({ file: row ? toFileMeta(row) : null, message });
    } catch (err) {
      console.error('[files] upload failed:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Upload failed' });
    }
  });

  router.get('/api/files/:id/download', async (req: Request, res: Response) => {
    try {
      const row = await deps.db.get<FileRow>('SELECT * FROM files WHERE id = ?', [
        req.params.id,
      ]);
      if (!row) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      const auth = await authorizeConversation(deps, extractToken(req), row.conversation_id);
      if (!auth) {
        res.status(403).json({ error: 'Not authorized for this file' });
        return;
      }
      if (row.scan_status !== 'CLEAN' || !row.compressed_path) {
        res.status(410).json({ error: 'File is not available' });
        return;
      }
      if (!fs.existsSync(row.compressed_path)) {
        res.status(410).json({ error: 'File contents missing from storage' });
        return;
      }

      const safeName = row.original_name.replace(/[\r\n"\\]/g, '_');
      res.setHeader('Content-Type', row.mime || 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
      );
      await pipeline(fs.createReadStream(row.compressed_path), createGunzip(), res);
    } catch (err) {
      console.error('[files] download failed:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
      else res.end();
    }
  });

  return router;
}
