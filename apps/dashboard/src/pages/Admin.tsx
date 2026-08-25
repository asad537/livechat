import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Role, Team, UserPublic, Website } from '@livechat/shared';
import { api, type CreateWebsiteInput } from '../api';
import { useApp } from '../state';
import Avatar from '../components/Avatar';
import { classNames, initials, roleLabel } from '../util';
import { IconCheck, IconCopy, IconPlus, IconUserPlus, IconX } from '../icons';

type Section = 'agents' | 'departments' | 'workflows' | 'integrations';

const SECTION_META: Record<Section, { title: string; sub: string }> = {
  agents: { title: 'Agents', sub: 'Create agents and manage roles & capacity.' },
  departments: { title: 'Departments', sub: 'Group agents into departments and assign leads.' },
  workflows: { title: 'Workflows', sub: 'How chats get routed, and the AI assistant per website.' },
  integrations: { title: 'Integrations', sub: 'Websites, widget embed codes and AI knowledge.' },
};

function embedSnippet(widgetKey: string): string {
  // Same origin as the dashboard — on production that's https://your-domain/widget.js
  return `<script src="${window.location.origin}/widget.js" data-livechat-key="${widgetKey}" async></script>`;
}

// Office allow-list pre-filled in the New user form. Kept in sync with
// DEFAULT_ALLOWED_IPS in apps/server/src/seed-team.ts so a manually-created
// Lead/CSR gets the same policy as a seeded one out of the box.
const DEFAULT_ALLOWED_IPS = '122.129.75.18, 202.166.170.138';

// ─── Website form ────────────────────────────────────────────
interface WebsiteFormProps {
  initial?: Website;
  teams: Team[];
  onSaved(): void;
  onCancel(): void;
}

function WebsiteForm({ initial, teams, onSaved, onCancel }: WebsiteFormProps) {
  const { pushToast } = useApp();
  const [name, setName] = useState(initial?.name ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [domains, setDomains] = useState(initial?.domains?.join(', ') ?? '');
  const [primaryColor, setPrimaryColor] = useState(initial?.primaryColor ?? '#6366f1');
  const [headerColor, setHeaderColor] = useState(initial?.headerColor ?? '');
  const [greeting, setGreeting] = useState(initial?.greeting ?? 'Hi there — how can we help?');
  const [logoUrl, setLogoUrl] = useState(initial?.logoUrl ?? '');
  const [teamId, setTeamId] = useState(initial?.teamId ?? teams[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const payload: CreateWebsiteInput = {
      name: name.trim(),
      label: label.trim() || null,
      domains: domains
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean),
      primaryColor,
      greeting: greeting.trim(),
      logoUrl: logoUrl.trim() || null,
      teamId,
      headerColor: headerColor.trim() || null,
    };
    try {
      if (initial) await api.updateWebsite(initial.id, payload);
      else await api.createWebsite(payload);
      pushToast(initial ? 'Website updated' : 'Website created', undefined, 'success');
      onSaved();
    } catch (err) {
      pushToast('Save failed', err instanceof Error ? err.message : undefined, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
    <form className="modal modal-wide admin-form" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
      <div className="modal-head">
        <h3>{initial ? `Edit ${initial.name}` : 'New website'}</h3>
        <button type="button" className="icon-btn" onClick={onCancel} aria-label="Close">
          <IconX size={16} />
        </button>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Acme Store" />
        </label>
        <label className="field">
          <span>Display name (agent chip)</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Optional — e.g. TCB"
          />
        </label>
        <label className="field">
          <span>Team</span>
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)} required>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-wide">
          <span>Allowed domains (comma separated, empty = allow all)</span>
          <input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="acme.com, shop.acme.com" />
        </label>
        <label className="field">
          <span>Chat color (buttons, bubbles)</span>
          <span className="color-field">
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(primaryColor) ? primaryColor : '#6366f1'}
              onChange={(e) => setPrimaryColor(e.target.value)}
            />
            <input value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} />
          </span>
        </label>
        <label className="field">
          <span>Header color (empty = chat color)</span>
          <span className="color-field">
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(headerColor) ? headerColor : primaryColor}
              onChange={(e) => setHeaderColor(e.target.value)}
            />
            <input
              value={headerColor}
              placeholder="same as chat color"
              onChange={(e) => setHeaderColor(e.target.value)}
            />
          </span>
        </label>
        <label className="field">
          <span>Logo URL (optional)</span>
          <input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://…/logo.png" />
        </label>
        <label className="field field-wide">
          <span>Greeting</span>
          <input value={greeting} onChange={(e) => setGreeting(e.target.value)} placeholder="Hi there — how can we help?" />
        </label>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !teamId}>
          {busy ? 'Saving…' : initial ? 'Save changes' : 'Create website'}
        </button>
      </div>
    </form>
    </div>
  );
}

// ─── Websites tab ────────────────────────────────────────────
function WebsitesTab({ teams }: { teams: Team[] }) {
  const { pushToast, refreshDirectory, me } = useApp();
  const readOnly = me?.role === 'MANAGER';
  const [websites, setWebsites] = useState<Website[]>([]);
  const [editing, setEditing] = useState<Website | null>(null);
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [stats, setStats] = useState<
    Record<string, { chats: number; open: number; aiPages: number; aiUrls: number; aiLastScan: string | null }>
  >({});

  const load = useCallback(async () => {
    try {
      setWebsites(await api.websites());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async (site: Website) => {
    try {
      await navigator.clipboard.writeText(embedSnippet(site.widgetKey));
      setCopiedId(site.id);
      window.setTimeout(() => setCopiedId((c) => (c === site.id ? null : c)), 2000);
    } catch {
      pushToast('Copy failed', 'Clipboard is not available in this browser.', 'error');
    }
  };

  const loadStats = useCallback(async () => {
    try {
      setStats(await api.websiteStats());
    } catch {
      /* stats are decorative */
    }
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const remove = async (site: Website) => {
    const st = stats[site.id];
    const warning =
      `Delete "${site.name}" PERMANENTLY?\n\n` +
      `This removes the website, its widget key${st ? `, ${st.chats} conversation(s)` : ', all conversations'}, ` +
      `messages, calls, files and AI knowledge. This cannot be undone.`;
    if (!window.confirm(warning)) return;
    if (!window.confirm(`Really delete "${site.name}"? Last chance.`)) return;
    setDeletingId(site.id);
    try {
      const result = await api.deleteWebsite(site.id);
      pushToast('Website deleted', `${site.name} + ${result.deletedConversations} conversation(s) removed.`, 'success');
      void load();
      void loadStats();
      void refreshDirectory();
    } catch (err) {
      pushToast('Delete failed', err instanceof Error ? err.message : 'Could not delete website', 'error');
    } finally {
      setDeletingId(null);
    }
  };

  const scan = async (site: Website) => {
    const suggested = site.domains[0] ? `https://${site.domains[0]}` : 'https://';
    const url = window.prompt(
      'Website URL to scan for AI answers (products, pricing, policies):',
      suggested,
    );
    if (!url) return;
    setScanningId(site.id);
    try {
      const result = await api.scanWebsite(site.id, url.trim());
      pushToast(
        'Website scanned for AI',
        `${result.pages} pages + ${result.urls ?? 0} product links indexed — the AI now answers (and links) from this site's live content.`,
        'success',
      );
      void loadStats();
    } catch (err) {
      pushToast('Scan failed', err instanceof Error ? err.message : 'Could not scan website', 'error');
    } finally {
      setScanningId(null);
    }
  };

  const onSaved = () => {
    setEditing(null);
    setCreating(false);
    void load();
    void refreshDirectory();
  };

  return (
    <div className="admin-tab">
      {!creating && !editing && !readOnly && (
        <button className="btn btn-primary btn-sm admin-add" onClick={() => setCreating(true)}>
          <IconPlus size={15} /> New website
        </button>
      )}
      {(creating || editing) && (
        <WebsiteForm
          initial={editing ?? undefined}
          teams={teams}
          onSaved={onSaved}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
      <div className="admin-list">
        {websites.map((site) => (
          <div key={site.id} className="card website-card">
            <div className="website-card-head">
              <span className="website-swatch" style={{ background: site.primaryColor }} />
              <div className="website-card-meta">
                <span className="website-card-name">{site.name}</span>
                <span className="website-card-sub">
                  {site.domains.length > 0 ? site.domains.join(', ') : 'All domains allowed'}
                  {' · team '}
                  {teams.find((t) => t.id === site.teamId)?.name ?? '—'}
                </span>
              </div>
              {!readOnly && (
                <>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(site)}>
                    Edit
                  </button>
                  <button
                    className="btn btn-ghost btn-sm btn-danger"
                    disabled={deletingId === site.id}
                    onClick={() => void remove(site)}
                    title="Delete this website and all of its data"
                  >
                    {deletingId === site.id ? 'Deleting…' : 'Delete'}
                  </button>
                </>
              )}
            </div>
            <div className="website-card-greeting">“{site.greeting}”</div>
            {stats[site.id] && (
              <div className="website-card-stats">
                <span className="chip">💬 {stats[site.id].chats} chats</span>
                {stats[site.id].open > 0 && <span className="chip chip-open">{stats[site.id].open} open</span>}
                <span className="chip">
                  {stats[site.id].aiPages > 0
                    ? `🤖 AI: ${stats[site.id].aiPages} pages + ${stats[site.id].aiUrls} links`
                    : '🤖 AI: not scanned yet'}
                </span>
              </div>
            )}
            <div className="embed-row">
              <div className="embed-meta">
                <span className="embed-label">Widget key</span>
                <code className="embed-key">{site.widgetKey}</code>
              </div>
              <pre className="embed-snippet">{embedSnippet(site.widgetKey)}</pre>
              <button className="btn btn-ghost btn-sm" onClick={() => void copy(site)}>
                {copiedId === site.id ? <IconCheck size={14} /> : <IconCopy size={14} />}
                {copiedId === site.id ? ' Copied' : ' Copy embed code'}
              </button>
              {!readOnly && (
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={scanningId === site.id}
                  onClick={() => void scan(site)}
                  title="Crawl this website so the AI assistant answers from its live content"
                >
                  {scanningId === site.id ? 'Scanning…' : '🤖 Scan website for AI'}
                </button>
              )}
            </div>
          </div>
        ))}
        {websites.length === 0 && <div className="empty-hint">No websites yet — create the first one.</div>}
      </div>
    </div>
  );
}

// ─── Teams tab ───────────────────────────────────────────────
function TeamsTab({ users }: { users: UserPublic[] }) {
  const { pushToast, online, awayMap, refreshDirectory, me } = useApp();
  const readOnly = me?.role === 'MANAGER';
  const [teams, setTeams] = useState<Team[]>([]);
  const [newName, setNewName] = useState('');
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [addUserId, setAddUserId] = useState('');
  const [addIsLead, setAddIsLead] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTeams(await api.teams());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await api.createTeam(name);
      setNewName('');
      pushToast('Team created', undefined, 'success');
      await load();
      void refreshDirectory();
    } catch (err) {
      pushToast('Create failed', err instanceof Error ? err.message : undefined, 'error');
    } finally {
      setBusy(false);
    }
  };

  const addMember = async (teamId: string) => {
    if (!addUserId || busy) return;
    setBusy(true);
    try {
      await api.addTeamMember(teamId, addUserId, addIsLead);
      setAddingTo(null);
      setAddUserId('');
      setAddIsLead(false);
      await load();
      void refreshDirectory();
    } catch (err) {
      pushToast('Add member failed', err instanceof Error ? err.message : undefined, 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (teamId: string, userId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.removeTeamMember(teamId, userId);
      await load();
      void refreshDirectory();
    } catch (err) {
      pushToast('Remove failed', err instanceof Error ? err.message : undefined, 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleLead = async (teamId: string, member: UserPublic & { isLead: boolean }) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.removeTeamMember(teamId, member.id);
      await api.addTeamMember(teamId, member.id, !member.isLead);
      await load();
      void refreshDirectory();
    } catch (err) {
      pushToast('Update failed', err instanceof Error ? err.message : undefined, 'error');
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-tab">
      {!readOnly && (
        <form className="admin-inline-form" onSubmit={createTeam}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New department name"
          />
          <button className="btn btn-primary btn-sm" type="submit" disabled={!newName.trim() || busy}>
            <IconPlus size={15} /> Create department
          </button>
        </form>
      )}
      <div className="admin-list">
        {teams.map((team) => {
          const memberIds = new Set((team.members ?? []).map((m) => m.id));
          const candidates = users.filter((u) => !memberIds.has(u.id));
          return (
            <div key={team.id} className="card team-card">
              <div className="team-card-head">
                <h3>{team.name}</h3>
                {!readOnly && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setAddingTo(addingTo === team.id ? null : team.id);
                      setAddUserId(candidates[0]?.id ?? '');
                      setAddIsLead(false);
                    }}
                  >
                    <IconUserPlus size={15} /> Add member
                  </button>
                )}
              </div>
              {addingTo === team.id && (
                <div className="team-add-row">
                  <select value={addUserId} onChange={(e) => setAddUserId(e.target.value)}>
                    {candidates.length === 0 && <option value="">Everyone is already a member</option>}
                    {candidates.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} ({u.role})
                      </option>
                    ))}
                  </select>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={addIsLead}
                      onChange={(e) => setAddIsLead(e.target.checked)}
                    />
                    Lead
                  </label>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={!addUserId || busy}
                    onClick={() => void addMember(team.id)}
                  >
                    Add
                  </button>
                </div>
              )}
              <div className="team-members">
                {(team.members ?? []).map((m) => (
                  <div key={m.id} className="team-member-row">
                    <Avatar name={m.name} color={m.avatarColor} url={m.avatarUrl} size="sm" />
                    <span className="team-member-name">
                      {m.name}
                      <span
                        className={classNames(
                          'dot',
                          online[m.id] ? (awayMap[m.id] ? 'dot-away' : 'dot-online') : 'dot-offline',
                        )}
                        title={online[m.id] ? (awayMap[m.id] ? 'Away' : 'Online') : 'Offline'}
                      />
                    </span>
                    <span className="team-member-role">{roleLabel(m.role)}</span>
                    <label className="check-field" title="Team lead">
                      <input
                        type="checkbox"
                        checked={m.isLead}
                        disabled={busy || readOnly}
                        onChange={() => void toggleLead(team.id, m)}
                      />
                      Lead
                    </label>
                    {!readOnly && (
                      <button
                        className="icon-btn icon-btn-danger"
                        title="Remove from team"
                        disabled={busy}
                        onClick={() => void removeMember(team.id, m.id)}
                      >
                        <IconX size={14} />
                      </button>
                    )}
                  </div>
                ))}
                {(team.members ?? []).length === 0 && (
                  <div className="empty-hint">No members yet.</div>
                )}
              </div>
            </div>
          );
        })}
        {teams.length === 0 && <div className="empty-hint">No teams yet.</div>}
      </div>
    </div>
  );
}

// ─── Users tab ───────────────────────────────────────────────
const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'CSR', label: 'CSR' },
  { value: 'LEAD', label: 'Team Lead' },
  { value: 'MANAGER', label: 'Manager' },
  { value: 'ADMIN', label: 'Admin' },
];

function TeamLeadSelect({
  leads,
  value,
  onChange,
}: {
  leads: UserPublic[];
  value: string;
  onChange(v: string): void;
}) {
  return (
    <label className="field">
      <span>Team Lead (this CSR reports to)</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— No team lead —</option>
        {leads.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function UsersTab({ users, reload }: { users: UserPublic[]; reload(): void }) {
  const { pushToast, online, awayMap, me } = useApp();
  // Managers may ADD agents (team leads + CSRs only) but never edit anyone.
  const isManager = me?.role === 'MANAGER';
  const canEdit = me?.role === 'ADMIN';
  const roleOptions = isManager
    ? ROLE_OPTIONS.filter((o) => o.value === 'LEAD' || o.value === 'CSR')
    : ROLE_OPTIONS;
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('CSR');
  const [teamLeadId, setTeamLeadId] = useState('');
  // Default office allow-list pre-filled so a manually-created Lead/CSR
  // matches the seed policy out of the box. Admin can edit or clear per user.
  const [allowedIps, setAllowedIps] = useState(DEFAULT_ALLOWED_IPS);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<UserPublic | null>(null);

  const leads = users.filter((u) => u.role === 'LEAD');
  const leadName = (id: string | null | undefined) =>
    id ? (users.find((u) => u.id === id)?.name ?? '—') : '—';

  // Hierarchy view: Admins → Managers → each Team Lead followed by their CSRs.
  const sorted = React.useMemo(() => {
    const byName = (a: UserPublic, b: UserPublic) => a.name.localeCompare(b.name);
    const admins = users.filter((u) => u.role === 'ADMIN').sort(byName);
    const managers = users.filter((u) => u.role === 'MANAGER').sort(byName);
    const leadRows = users.filter((u) => u.role === 'LEAD').sort(byName);
    const csrs = users.filter((u) => u.role === 'CSR');
    const out: UserPublic[] = [...admins, ...managers];
    for (const l of leadRows) {
      out.push(l);
      out.push(...csrs.filter((c) => c.teamLeadId === l.id).sort(byName));
    }
    // CSRs with no (or a deleted) team lead go last so admin spots them.
    out.push(
      ...csrs
        .filter((c) => !c.teamLeadId || !leadRows.some((l) => l.id === c.teamLeadId))
        .sort(byName),
    );
    return out;
  }, [users]);

  const remove = async (u: UserPublic) => {
    if (!window.confirm(`Delete ${u.name} (${u.email})?\n\nTheir open chats return to the queue; closed chat history is kept.`)) return;
    try {
      await api.deleteUser(u.id);
      pushToast('User deleted', `${u.name} has been removed.`, 'success');
      reload();
    } catch (err) {
      pushToast('Delete failed', err instanceof Error ? err.message : undefined, 'error');
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await api.createUser({
        email: email.trim(),
        name: name.trim(),
        password,
        role,
        teamLeadId: role === 'CSR' && teamLeadId ? teamLeadId : null,
        allowedIps: allowedIps.trim() || null,
      });
      pushToast('User created', `${name.trim()} can now sign in.`, 'success');
      setShowForm(false);
      setEmail('');
      setName('');
      setPassword('');
      setRole('CSR');
      setTeamLeadId('');
      setAllowedIps(DEFAULT_ALLOWED_IPS);
      reload();
    } catch (err) {
      pushToast('Create failed', err instanceof Error ? err.message : undefined, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-tab">
      {!showForm && (
        <button className="btn btn-primary btn-sm admin-add" onClick={() => setShowForm(true)}>
          <IconPlus size={15} /> {isManager ? 'New agent' : 'New user'}
        </button>
      )}
      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
        <form className="modal modal-wide admin-form" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
          <div className="modal-head">
            <h3>{isManager ? 'New agent' : 'New user'}</h3>
            <button type="button" className="icon-btn" onClick={() => setShowForm(false)} aria-label="Close">
              <IconX size={16} />
            </button>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>Full name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Jane Smith" />
            </label>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="jane@company.com"
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                placeholder="At least 6 characters"
              />
            </label>
            <label className="field">
              <span>Role</span>
              <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {roleOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {role === 'CSR' && (
              <TeamLeadSelect leads={leads} value={teamLeadId} onChange={setTeamLeadId} />
            )}
            <label className="field field-wide">
              <span>Allowed IP addresses (optional)</span>
              <input
                type="text"
                value={allowedIps}
                onChange={(e) => setAllowedIps(e.target.value)}
                placeholder="e.g. 203.0.113.10, 203.0.113.0/24"
              />
              <small className="field-hint">
                Leave blank for no restriction. If set, this user can ONLY sign in from these IPs
                (comma-separated; ranges like 203.0.113.0/24 allowed).
              </small>
            </label>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </form>
        </div>
      )}
      {editing && (
        <EditUserForm
          user={editing}
          leads={leads.filter((l) => l.id !== editing.id)}
          onDone={(changed) => {
            setEditing(null);
            if (changed) reload();
          }}
        />
      )}
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Email</th>
              <th>Role</th>
              <th>Team lead</th>
              <th>Status</th>
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {sorted.map((u) => (
              <tr key={u.id}>
                <td>
                  <span className={classNames('cell-user', u.role === 'CSR' && u.teamLeadId && 'cell-user-nested')}>
                    {u.role === 'CSR' && u.teamLeadId && <span className="nest-arrow">↳</span>}
                    <Avatar name={u.name} color={u.avatarColor} url={u.avatarUrl} size="sm" />
                    {u.name}
                  </span>
                </td>
                <td>{u.email}</td>
                <td>
                  <span className={`role-badge role-${u.role.toLowerCase()}`}>{roleLabel(u.role)}</span>
                </td>
                <td>{u.role === 'CSR' ? leadName(u.teamLeadId) : '—'}</td>
                <td>
                  {online[u.id] ? (
                    awayMap[u.id] ? (
                      <>
                        <span className="dot dot-away" /> Away
                      </>
                    ) : (
                      <>
                        <span className="dot dot-online" /> Online
                      </>
                    )
                  ) : (
                    <>
                      <span className="dot dot-offline" /> Offline
                    </>
                  )}
                </td>
                {canEdit && (
                  <td className="num">
                    <span className="row-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing(u)}>
                        Edit
                      </button>
                      {u.id !== me?.id && (
                        <button
                          className="btn btn-ghost btn-sm btn-danger"
                          title="Delete this user"
                          onClick={() => void remove(u)}
                        >
                          Delete
                        </button>
                      )}
                    </span>
                  </td>
                )}
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={canEdit ? 6 : 5} className="empty-hint">
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Edit user (role / team lead / capacity / password) ──────
function EditUserForm({
  user,
  leads,
  onDone,
}: {
  user: UserPublic;
  leads: UserPublic[];
  onDone(changed: boolean): void;
}) {
  const { pushToast } = useApp();
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState<Role>(user.role);
  const [teamLeadId, setTeamLeadId] = useState(user.teamLeadId ?? '');
  const [password, setPassword] = useState('');
  const [allowedIps, setAllowedIps] = useState(user.allowedIps ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await api.updateUser(user.id, {
        name: name.trim(),
        role,
        teamLeadId: role === 'CSR' && teamLeadId ? teamLeadId : null,
        allowedIps: allowedIps.trim() || null,
        ...(password ? { password } : {}),
      });
      pushToast('User updated', `${name.trim()} saved.`, 'success');
      onDone(true);
    } catch (err) {
      pushToast('Update failed', err instanceof Error ? err.message : undefined, 'error');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => onDone(false)}>
    <form className="modal modal-wide admin-form" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
      <div className="modal-head">
        <h3>Edit {user.name}</h3>
        <button type="button" className="icon-btn" onClick={() => onDone(false)} aria-label="Close">
          <IconX size={16} />
        </button>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>Full name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {role === 'CSR' && (
          <TeamLeadSelect leads={leads} value={teamLeadId} onChange={setTeamLeadId} />
        )}
        <label className="field">
          <span>New password (optional)</span>
          <input
            type="password"
            value={password}
            minLength={6}
            placeholder="Leave blank to keep current"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="field field-wide">
          <span>Allowed IP addresses</span>
          <input
            type="text"
            value={allowedIps}
            onChange={(e) => setAllowedIps(e.target.value)}
            placeholder="e.g. 203.0.113.10, 203.0.113.0/24"
          />
          <small className="field-hint">
            Blank = no restriction. If set, this user can ONLY sign in from these IPs.
          </small>
        </label>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={() => onDone(false)}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
    </div>
  );
}

// ─── Workflows tab ───────────────────────────────────────────
function WorkflowsTab() {
  const { pushToast, refreshDirectory, me } = useApp();
  const readOnly = me?.role === 'MANAGER';
  const [websites, setWebsites] = useState<Website[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setWebsites(await api.websites());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleAi = async (site: Website) => {
    setBusyId(site.id);
    try {
      await api.updateWebsite(site.id, { aiEnabled: !(site.aiEnabled ?? true) });
      await load();
      void refreshDirectory();
      pushToast(
        'Workflow updated',
        `AI assistant ${site.aiEnabled ?? true ? 'turned off' : 'turned on'} for ${site.name}.`,
        'success',
      );
    } catch (err) {
      pushToast('Update failed', err instanceof Error ? err.message : undefined, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const steps = [
    { icon: '💬', title: 'Visitor starts a chat', sub: 'From the widget on any of your websites' },
    { icon: '⚡', title: 'Auto-assigned to an agent', sub: 'Least-busy online agent with spare capacity (per-agent max chats)' },
    { icon: '🤖', title: 'Queue + AI assistant', sub: 'No agent free? The AI answers from the scanned website while the visitor waits' },
    { icon: '👋', title: 'Type-to-join', sub: 'Any allowed agent can just start typing to take a queued chat' },
    { icon: '⏰', title: 'Missed after 10 minutes', sub: 'Unanswered queued chats are marked missed; a transcript email goes out on close' },
  ];

  return (
    <div className="admin-tab">
      <div className="card admin-form">
        <h3>Chat routing pipeline</h3>
        <div className="wf-steps">
          {steps.map((s, i) => (
            <div className="wf-step" key={s.title}>
              <span className="wf-step-icon">{s.icon}</span>
              <div className="wf-step-meta">
                <span className="wf-step-title">{s.title}</span>
                <span className="wf-step-sub">{s.sub}</span>
              </div>
              {i < steps.length - 1 && <span className="wf-step-arrow">→</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="card admin-form">
        <h3>AI assistant per website</h3>
        <p className="wf-hint">
          When on, the AI greets and answers queued visitors using that website&apos;s scanned
          content (run “Scan website for AI” under Integrations).
        </p>
        {websites.map((site) => (
          <div className="wf-site-row" key={site.id}>
            <span className="chip-dot" style={{ background: site.primaryColor }} />
            <span className="wf-site-name">{site.name}</span>
            <button
              className={classNames('switch', (site.aiEnabled ?? true) && 'on')}
              disabled={busyId === site.id || readOnly}
              onClick={() => void toggleAi(site)}
              aria-label={`AI assistant for ${site.name}`}
            >
              <span className="switch-knob" />
            </button>
            <span className="wf-site-state">{(site.aiEnabled ?? true) ? 'AI on' : 'AI off'}</span>
          </div>
        ))}
        {websites.length === 0 && <div className="empty-hint">No websites yet.</div>}
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────
export default function Admin() {
  const params = useParams<{ section?: string }>();
  const section: Section = (
    ['agents', 'departments', 'workflows', 'integrations'] as Section[]
  ).includes(params.section as Section)
    ? (params.section as Section)
    : 'agents';

  const [users, setUsers] = useState<UserPublic[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);

  const loadUsers = useCallback(async () => {
    try {
      setUsers(await api.users());
    } catch {
      /* ignore */
    }
  }, []);

  const loadTeams = useCallback(async () => {
    try {
      setTeams(await api.teams());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadUsers();
    void loadTeams();
  }, [loadUsers, loadTeams]);

  const meta = SECTION_META[section];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>{meta.title}</h2>
          <p className="page-sub">{meta.sub}</p>
        </div>
      </div>

      {section === 'integrations' && <WebsitesTab teams={teams} />}
      {section === 'departments' && <TeamsTab users={users} />}
      {section === 'agents' && <UsersTab users={users} reload={() => void loadUsers()} />}
      {section === 'workflows' && <WorkflowsTab />}
    </div>
  );
}
