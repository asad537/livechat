import type { Server } from 'socket.io';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { PresenceStore } from './presence.js';

/** Bundle of app-wide dependencies passed to every module. */
export interface AppDeps {
  config: Config;
  db: Db;
  presence: PresenceStore;
  io: Server;
}
