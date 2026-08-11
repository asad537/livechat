// ─── The Custom Boxes team seeder ────────────────────────────
// Run: npm run seed:team -w apps/server   (idempotent — safe to re-run)
//
// Creates the full agent roster (7 Team Leads with their CSRs, 3 Admins,
// 2 Managers), puts every lead/CSR on every existing team so they can
// serve all websites, and removes the old demo/test accounts.

import { loadConfig } from './core/config.js';
import { createDb, newId, nowIso, type Db } from './core/db.js';
import { hashPassword, type UserRow } from './core/auth.js';

const PASSWORD = '12345678';

// [email, display name] — each Team Lead is followed by the CSRs under them.
const TEAMS: Array<{ lead: [string, string]; csrs: Array<[string, string]> }> = [
  {
    lead: ['joshuaross@thecustomboxes.com', 'Joshua Ross'],
    csrs: [
      ['markeast@thecustomboxes.com', 'Mark East'],
      ['danielhale@thecustomboxes.com', 'Daniel Hale'],
      ['jackmiller@thecustomboxes.com', 'Jack Miller'],
      ['coreycobain@thecustomboxes.com', 'Corey Cobain'],
      ['frankwilson@thecustomboxes.com', 'Frank Wilson'],
    ],
  },
  {
    lead: ['deviselton@thecustomboxes.com', 'Devis Elton'],
    csrs: [
      ['ryanparker@thecustomboxes.com', 'Ryan Parker'],
      ['edwardmaslow@thecustomboxes.com', 'Edward Maslow'],
      ['chriscornell@thecustomboxes.com', 'Chris Cornell'],
    ],
  },
  {
    lead: ['jasonwright@thecustomboxes.com', 'Jason Wright'],
    csrs: [
      ['andyjackon@thecustomboxes.com', 'Andy Jackson'],
      ['stevemason@thecustomboxes.com', 'Steve Mason'],
      ['paulcooper@thecustomboxes.com', 'Paul Cooper'],
    ],
  },
  {
    lead: ['seankrueger@thecustomboxes.com', 'Sean Krueger'],
    csrs: [['nickmarshall@thecustomboxes.com', 'Nick Marshall']],
  },
  {
    lead: ['ashleyevans@thecustomboxes.com', 'Ashley Evans'],
    csrs: [
      ['dianabrook@thecustomboxes.com', 'Diana Brook'],
      ['charlottelynch@thecustomboxes.com', 'Charlotte Lynch'],
      ['jenniferwright@thecustomboxes.com', 'Jennifer Wright'],
      ['fionahawkins@thecustomboxes.com', 'Fiona Hawkins'],
    ],
  },
  {
    lead: ['kevinwells@thecustomboxes.com', 'Kevin Wells'],
    csrs: [
      ['harrymartin@thecustomboxes.com', 'Harry Martin'],
      ['ellieshaw@thecustomboxes.com', 'Ellie Shaw'],
    ],
  },
  { lead: ['aaron@thecustomboxes.com', 'Aaron'], csrs: [] },
];

const ADMINS: Array<[string, string]> = [
  ['amir@thecustomboxes.com', 'Amir'],
  ['maxlead@thecustomboxes.com', 'Max Lead'],
  ['bobfadi@thecustomboxes.com', 'Bob Fadi'],
];

const MANAGERS: Array<[string, string]> = [
  ['ben@thecustomboxes.com', 'Ben'],
  ['sam@thecustomboxes.com', 'Sam'],
];

// Old demo + throwaway test accounts to remove.
const REMOVE_EMAILS = [
  'admin@demo.com',
  'lead@demo.com',
  'sara@demo.com',
  'ali@demo.com',
  'mgr@t.com',
  'leada@t.com',
  'leadb@t.com',
  'csra@t.com',
  'csrb@t.com',
  'amir@customboxes.com',
  'maxlead@customboxes.com',
  'bobfadi@customboxes.com',
];

const COLORS = [
  '#5865f2',
  '#0891b2',
  '#16a34a',
  '#ea580c',
  '#dc2626',
  '#7c3aed',
  '#db2777',
  '#0d9488',
  '#f59e0b',
  '#2563eb',
];

function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}

/** Insert or update a user by email; returns the user id. */
async function upsertUser(
  db: Db,
  email: string,
  name: string,
  role: 'ADMIN' | 'MANAGER' | 'LEAD' | 'CSR',
  teamLeadId: string | null,
  maxChats: number,
  allowedIps: string | null = null,
): Promise<string> {
  const row = await db.get<UserRow>('SELECT * FROM users WHERE email = ?', [email]);
  if (row) {
    await db.run(
      'UPDATE users SET name = ?, role = ?, team_lead_id = ?, max_chats = ?, allowed_ips = ? WHERE id = ?',
      [name, role, teamLeadId, maxChats, allowedIps, row.id],
    );
    return row.id;
  }
  const id = newId();
  await db.run(
    `INSERT INTO users (id, email, name, password_hash, role, max_chats, avatar_color, team_lead_id, allowed_ips, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, email, name, hashPassword(PASSWORD), role, maxChats, colorFor(id), teamLeadId, allowedIps, nowIso()],
  );
  return id;
}

/** Put a user on a team (idempotent via the UNIQUE(team_id,user_id) key). */
async function ensureMember(db: Db, teamId: string, userId: string, isLead: boolean): Promise<void> {
  const existing = await db.get<{ id: string }>(
    'SELECT id FROM team_members WHERE team_id = ? AND user_id = ?',
    [teamId, userId],
  );
  if (existing) {
    await db.run('UPDATE team_members SET is_lead = ? WHERE id = ?', [isLead ? 1 : 0, existing.id]);
    return;
  }
  await db.run('INSERT INTO team_members (id, team_id, user_id, is_lead) VALUES (?, ?, ?, ?)', [
    newId(),
    teamId,
    userId,
    isLead ? 1 : 0,
  ]);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await createDb(config);

  // Website access flows through team membership — make sure a team exists.
  let teams = await db.all<{ id: string; name: string }>('SELECT id, name FROM teams');
  if (teams.length === 0) {
    const id = newId();
    await db.run('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)', [
      id,
      'Customer Support',
      nowIso(),
    ]);
    teams = [{ id, name: 'Customer Support' }];
  }

  const DEFAULT_ALLOWED_IPS = '122.129.75.18, 202.166.170.138';

  // 1. Admins + Managers (global access — unrestricted IP, no team membership needed).
  for (const [email, name] of ADMINS) {
    await upsertUser(db, email, name, 'ADMIN', null, 10, null);
    console.log(`  ADMIN     ${name} <${email}>`);
  }
  for (const [email, name] of MANAGERS) {
    await upsertUser(db, email, name, 'MANAGER', null, 5, null);
    console.log(`  MANAGER   ${name} <${email}>`);
  }

  // 2. Team Leads, then their CSRs linked via team_lead_id (restricted to office IPs).
  let leads = 0;
  let csrs = 0;
  for (const group of TEAMS) {
    const [leadEmail, leadName] = group.lead;
    const leadId = await upsertUser(db, leadEmail, leadName, 'LEAD', null, 5, DEFAULT_ALLOWED_IPS);
    leads++;
    for (const t of teams) await ensureMember(db, t.id, leadId, true);
    console.log(`  TEAM LEAD ${leadName} <${leadEmail}> — ${group.csrs.length} CSR(s)`);
    for (const [email, name] of group.csrs) {
      const csrId = await upsertUser(db, email, name, 'CSR', leadId, 3, DEFAULT_ALLOWED_IPS);
      csrs++;
      for (const t of teams) await ensureMember(db, t.id, csrId, false);
      console.log(`      CSR   ${name} <${email}>`);
    }
  }

  // 3. Remove the old demo/test accounts (after the new admins exist).
  let removed = 0;
  for (const email of REMOVE_EMAILS) {
    const row = await db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [email]);
    if (!row) continue;
    await db.run('DELETE FROM team_members WHERE user_id = ?', [row.id]);
    await db.run('DELETE FROM users WHERE id = ?', [row.id]);
    removed++;
    console.log(`  removed   ${email}`);
  }

  const total = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
  console.log(
    `\nDone: ${ADMINS.length} admins, ${MANAGERS.length} managers, ${leads} team leads, ${csrs} CSRs seeded; ` +
      `${removed} old account(s) removed. Users in DB: ${Number(total?.n ?? 0)}. ` +
      `All seeded logins use password "${PASSWORD}".`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed-team] failed:', err);
  process.exit(1);
});
