import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Role, Team, UserPublic, Website } from '@livechat/shared';
import { DEFAULT_MAX_CHATS } from '@livechat/shared';
import { api, type CreateWebsiteInput } from '../api';
import { useApp } from '../state';
import { classNames, initials } from '../util';
import { IconCheck, IconCopy, IconPlus, IconUserPlus, IconX } from '../icons';

type Tab = 'websites' | 'teams' | 'users';

function embedSnippet(widgetKey: string): string {
  return `<script src="http://localhost:4000/widget.js" data-livechat-key="${widgetKey}" async></script>`;
}

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
  const [domains, setDomains] = useState(initial?.domains?.join(', ') ?? '');
  const [primaryColor, setPrimaryColor] = useState(initial?.primaryColor ?? '#6366f1');
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
      domains: domains
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean),
      primaryColor,
      greeting: greeting.trim(),
      logoUrl: logoUrl.trim() || null,
      teamId,
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
    <form className="card admin-form" onSubmit={submit}>
      <h3>{initial ? `Edit ${initial.name}` : 'New website'}</h3>
      <div className="form-grid">
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Acme Store" />
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
          <span>Brand color</span>
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
  );
}

// ─── Websites tab ────────────────────────────────────────────
function WebsitesTab({ teams }: { teams: Team[] }) {
  const { pushToast, refreshDirectory } = useApp();
  const [websites, setWebsites] = useState<Website[]>([]);
  const [editing, setEditing] = useState<Website | null>(null);
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

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

  const onSaved = () => {
    setEditing(null);
    setCreating(false);
    void load();
    void refreshDirectory();
  };

  return (
    <div className="admin-tab">
      {!creating && !editing && (
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
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(site)}>
                Edit
              </button>
            </div>
            <div className="website-card-greeting">“{site.greeting}”</div>
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
  const { pushToast, online, refreshDirectory } = useApp();
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
      <form className="admin-inline-form" onSubmit={createTeam}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New team name"
        />
        <button className="btn btn-primary btn-sm" type="submit" disabled={!newName.trim() || busy}>
          <IconPlus size={15} /> Create team
        </button>
      </form>
      <div className="admin-list">
        {teams.map((team) => {
          const memberIds = new Set((team.members ?? []).map((m) => m.id));
          const candidates = users.filter((u) => !memberIds.has(u.id));
          return (
            <div key={team.id} className="card team-card">
              <div className="team-card-head">
                <h3>{team.name}</h3>
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
                    <span className="avatar avatar-sm" style={{ background: m.avatarColor }}>
                      {initials(m.name)}
                    </span>
                    <span className="team-member-name">
                      {m.name}
                      <span className={classNames('dot', online[m.id] ? 'dot-online' : 'dot-offline')} />
                    </span>
                    <span className="team-member-role">{m.role}</span>
                    <label className="check-field" title="Team lead">
                      <input
                        type="checkbox"
                        checked={m.isLead}
                        disabled={busy}
                        onChange={() => void toggleLead(team.id, m)}
                      />
                      Lead
                    </label>
                    <button
                      className="icon-btn icon-btn-danger"
                      title="Remove from team"
                      disabled={busy}
                      onClick={() => void removeMember(team.id, m.id)}
                    >
                      <IconX size={14} />
                    </button>
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
function UsersTab({ users, reload }: { users: UserPublic[]; reload(): void }) {
  const { pushToast, online } = useApp();
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('CSR');
  const [maxChats, setMaxChats] = useState(DEFAULT_MAX_CHATS);
  const [busy, setBusy] = useState(false);

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
        maxChats,
      });
      pushToast('User created', `${name.trim()} can now sign in.`, 'success');
      setShowForm(false);
      setEmail('');
      setName('');
      setPassword('');
      setRole('CSR');
      setMaxChats(DEFAULT_MAX_CHATS);
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
          <IconPlus size={15} /> New user
        </button>
      )}
      {showForm && (
        <form className="card admin-form" onSubmit={submit}>
          <h3>New user</h3>
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
                <option value="CSR">CSR</option>
                <option value="LEAD">LEAD</option>
                <option value="ADMIN">ADMIN</option>
              </select>
            </label>
            <label className="field">
              <span>Max concurrent chats</span>
              <input
                type="number"
                min={1}
                max={20}
                value={maxChats}
                onChange={(e) => setMaxChats(Math.max(1, Number(e.target.value) || 1))}
              />
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
      )}
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Email</th>
              <th>Role</th>
              <th className="num">Max chats</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <span className="cell-user">
                    <span className="avatar avatar-sm" style={{ background: u.avatarColor }}>
                      {initials(u.name)}
                    </span>
                    {u.name}
                  </span>
                </td>
                <td>{u.email}</td>
                <td>
                  <span className={`role-badge role-${u.role.toLowerCase()}`}>{u.role}</span>
                </td>
                <td className="num">{u.maxChats}</td>
                <td>
                  <span className={classNames('dot', online[u.id] ? 'dot-online' : 'dot-offline')} />
                  {online[u.id] ? ' Online' : ' Offline'}
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={5} className="empty-hint">
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

// ─── Page ────────────────────────────────────────────────────
export default function Admin() {
  const [tab, setTab] = useState<Tab>('websites');
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

  const tabs = useMemo(
    () =>
      [
        { id: 'websites' as Tab, label: 'Websites' },
        { id: 'teams' as Tab, label: 'Teams' },
        { id: 'users' as Tab, label: 'Users' },
      ] as const,
    [],
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Admin</h2>
          <p className="page-sub">Manage websites, teams and users.</p>
        </div>
        <div className="seg-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={classNames('seg-tab', tab === t.id && 'active')}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'websites' && <WebsitesTab teams={teams} />}
      {tab === 'teams' && <TeamsTab users={users} />}
      {tab === 'users' && <UsersTab users={users} reload={() => void loadUsers()} />}
    </div>
  );
}
