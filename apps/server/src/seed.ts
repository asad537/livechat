import type { Config } from './core/config.js';
import { hashPassword } from './core/auth.js';
import { newId, nowIso, type Db } from './core/db.js';

/**
 * Seeds demo data on first boot (empty users table).
 *
 * Demo logins (dashboard):
 *   admin@demo.com / admin123   — ADMIN (sees every website, team, chat, call, file)
 *   lead@demo.com  / lead123    — LEAD of "Customer Support" (monitors team chats)
 *   sara@demo.com  / csr123     — CSR
 *   ali@demo.com   / csr123     — CSR
 *
 * Demo websites (multi-tenant):
 *   Acme Store  — widget key wk_acme_demo  (green branding)
 *   TechCorp    — widget key wk_tech_demo  (blue branding)
 */
export async function ensureSeed(db: Db, _config: Config): Promise<void> {
  const existing = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
  if (existing && Number(existing.n) > 0) return;

  const t = nowIso();
  const teamId = newId();
  await db.run('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)', [
    teamId,
    'Customer Support',
    t,
  ]);

  const users: Array<[string, string, string, string, string, number]> = [
    // email, name, password, role, avatarColor, maxChats
    ['admin@demo.com', 'Ayesha Admin', 'admin123', 'ADMIN', '#7c3aed', 10],
    ['lead@demo.com', 'Lena Lead', 'lead123', 'LEAD', '#ea580c', 5],
    ['sara@demo.com', 'Sara Khan', 'csr123', 'CSR', '#0891b2', 3],
    ['ali@demo.com', 'Ali Raza', 'csr123', 'CSR', '#16a34a', 3],
  ];

  for (const [email, name, password, role, color, maxChats] of users) {
    const id = newId();
    await db.run(
      'INSERT INTO users (id, email, name, password_hash, role, max_chats, avatar_color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, email, name, hashPassword(password), role, maxChats, color, t],
    );
    if (role !== 'ADMIN') {
      await db.run(
        'INSERT INTO team_members (id, team_id, user_id, is_lead) VALUES (?, ?, ?, ?)',
        [newId(), teamId, id, role === 'LEAD' ? 1 : 0],
      );
    }
  }

  const websites: Array<[string, string, string, string]> = [
    // name, widgetKey, primaryColor, greeting
    ['Acme Store', 'wk_acme_demo', '#16a34a', 'Welcome to Acme Store! Need help with an order?'],
    ['TechCorp', 'wk_tech_demo', '#2563eb', 'Hi! Questions about TechCorp Cloud? We are here.'],
  ];

  for (const [name, widgetKey, primaryColor, greeting] of websites) {
    await db.run(
      'INSERT INTO websites (id, name, widget_key, domains, team_id, logo_url, primary_color, greeting, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [newId(), name, widgetKey, '', teamId, null, primaryColor, greeting, t],
    );
  }

  console.log('[seed] demo data created — login: admin@demo.com/admin123, lead@demo.com/lead123, sara@demo.com/csr123, ali@demo.com/csr123');
}
