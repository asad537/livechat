import { Router, type NextFunction, type Request, type Response } from 'express';
import type { AppDeps } from '../core/deps.js';
import { buildFilesRouter } from '../features/files/index.js';
import { buildCallsRouter } from '../features/calls/index.js';
import { buildKnowledgeRouter } from '../features/knowledge/index.js';
import { HttpError } from './helpers.js';
import { buildAuthRouter } from './routes/auth.js';
import { buildUsersRouter } from './routes/users.js';
import { buildTeamsRouter } from './routes/teams.js';
import { buildWebsitesRouter } from './routes/websites.js';
import { buildConversationsRouter } from './routes/conversations.js';
import { buildVisitorsRouter } from './routes/visitors.js';
import { buildReportsRouter } from './routes/reports.js';
import { buildWidgetRouter } from './routes/widget.js';

/**
 * Assembles the full REST API. Every sub-router mounts absolute `/api/...`
 * paths, so ordering only matters for the trailing error handler.
 */
export function buildApiRouter(deps: AppDeps): Router {
  const router = Router();

  router.use(buildAuthRouter(deps)); // /api/auth/login, /api/me
  router.use(buildWidgetRouter(deps)); // /api/widget/boot (public)
  router.use(buildUsersRouter(deps)); // /api/users
  router.use(buildTeamsRouter(deps)); // /api/teams
  router.use(buildWebsitesRouter(deps)); // /api/websites (+ /:id/visitors)
  router.use(buildConversationsRouter(deps)); // /api/conversations
  router.use(buildVisitorsRouter(deps)); // /api/visitors/:id (profile, CRM, past chats)
  router.use(buildReportsRouter(deps)); // /api/reports/overview

  router.use(buildFilesRouter(deps)); // /api/uploads, /api/files/:id/download
  router.use(buildCallsRouter(deps)); // /api/calls/daily-webhook
  router.use(buildKnowledgeRouter(deps)); // /api/websites/:id/scan (AI knowledge)

  // Central error handler for everything mounted above.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[api] unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return router;
}
