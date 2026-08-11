import React from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import type { Role } from '@livechat/shared';
import { useApp } from './state';
import { classNames, roleLabel } from './util';
import Login from './pages/Login';
import Inbox from './pages/Inbox';
import Visitors from './pages/Visitors';
import Monitoring from './pages/Monitoring';
import Reports from './pages/Reports';
import Admin from './pages/Admin';
import Profile from './pages/Profile';
import Dashboard from './pages/Dashboard';
import Avatar from './components/Avatar';
import Toasts from './components/Toasts';
import CallOverlay from './components/CallOverlay';
import ChatDock from './components/ChatDock';
import DockedChatWindow from './components/DockedChatWindow';
import {
  IconBriefcase,
  IconChart,
  IconClock,
  IconEye,
  IconHome,
  IconInbox,
  IconLogout,
  IconPlug,
  IconUsers,
  IconWorkflow,
  LogoMark,
} from './icons';

function RequireRole({ roles, children }: { roles: Role[]; children: React.ReactElement }) {
  const { me } = useApp();
  if (!me || !roles.includes(me.role)) return <Navigate to="/" replace />;
  return children;
}

/** "/" — leads/admins land on the Dashboard once per session, then it's the Inbox. */
function Landing() {
  const { me } = useApp();
  const first = !sessionStorage.getItem('lc.landed');
  React.useEffect(() => {
    try {
      sessionStorage.setItem('lc.landed', '1');
    } catch {
      /* ignore */
    }
  }, []);
  if (first && me && me.role !== 'CSR') return <Navigate to="/dashboard" replace />;
  return <Inbox />;
}

function Sidebar() {
  const { me, logout, connected, conversations } = useApp();
  const navigate = useNavigate();
  if (!me) return null;

  const unread = Object.values(conversations).reduce(
    (sum, c) => (c.status === 'CLOSED' || c.status === 'MISSED' ? sum : sum + (c.unreadCount ?? 0)),
    0,
  );

  const isLeadUp = me.role !== 'CSR'; // LEAD, MANAGER and ADMIN

  const navItem = (icon: React.ReactNode, label: string, badge?: React.ReactNode) => (
    <>
      <span className="nav-icon">{icon}</span>
      <span>{label}</span>
      {badge}
    </>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-logo">
          <LogoMark size={22} />
        </span>
        <span className="sidebar-brand-text">
          <span className="sidebar-brand-name">LiveChat</span>
          <span className="sidebar-brand-sub">Agency workspace</span>
        </span>
      </div>
      <div className="nav-section-label">Workspace</div>
      <nav className="sidebar-nav">
        {isLeadUp && (
          <NavLink to="/dashboard" className={({ isActive }) => classNames('nav-item', isActive && 'active')}>
            {navItem(<IconHome size={17} />, 'Dashboard')}
          </NavLink>
        )}
        <NavLink to="/" end className={({ isActive }) => classNames('nav-item', isActive && 'active')}>
          {navItem(
            <IconInbox size={17} />,
            'Inbox',
            unread > 0 ? <span className="badge nav-badge">{unread}</span> : undefined,
          )}
        </NavLink>
        <NavLink to="/visitors" className={({ isActive }) => classNames('nav-item', isActive && 'active')}>
          {navItem(<IconUsers size={17} />, 'Visitors')}
        </NavLink>
        <NavLink to="/history" className={({ isActive }) => classNames('nav-item', isActive && 'active')}>
          {navItem(<IconClock size={17} />, 'History')}
        </NavLink>
        {isLeadUp && (
          <NavLink to="/monitoring" className={({ isActive }) => classNames('nav-item', isActive && 'active')}>
            {navItem(<IconEye size={17} />, 'Monitoring')}
          </NavLink>
        )}
        {isLeadUp && (
          <NavLink to="/reports" className={({ isActive }) => classNames('nav-item', isActive && 'active')}>
            {navItem(<IconChart size={17} />, 'Reports')}
          </NavLink>
        )}
      </nav>
      {(me.role === 'ADMIN' || me.role === 'MANAGER') && (
        <>
          <div className="nav-section-label nav-section-admin">Admin</div>
          <nav className="sidebar-nav sidebar-nav-admin">
            <NavLink
              to="/admin/agents"
              className={({ isActive }) => classNames('nav-item', isActive && 'active')}
            >
              {navItem(<IconUsers size={17} />, 'Agents')}
            </NavLink>
            <NavLink
              to="/admin/departments"
              className={({ isActive }) => classNames('nav-item', isActive && 'active')}
            >
              {navItem(<IconBriefcase size={17} />, 'Departments')}
            </NavLink>
            <NavLink
              to="/admin/workflows"
              className={({ isActive }) => classNames('nav-item', isActive && 'active')}
            >
              {navItem(<IconWorkflow size={17} />, 'Workflows')}
            </NavLink>
            <NavLink
              to="/admin/integrations"
              className={({ isActive }) => classNames('nav-item', isActive && 'active')}
            >
              {navItem(<IconPlug size={17} />, 'Integrations')}
            </NavLink>
          </nav>
        </>
      )}
      <div className="sidebar-foot">
        {me.role !== 'MANAGER' && <AvailabilityToggle />}
        <div
          className="sidebar-user sidebar-user-link"
          role="button"
          title="My profile"
          onClick={() => navigate('/profile')}
        >
          <Avatar name={me.name} color={me.avatarColor} url={me.avatarUrl} />
          <div className="sidebar-user-meta">
            <span className="sidebar-user-name">{me.name}</span>
            <span className="sidebar-user-role">{roleLabel(me.role)}</span>
          </div>
          <button
            className="icon-btn icon-btn-dark"
            onClick={(e) => {
              e.stopPropagation();
              logout();
            }}
            title="Sign out"
          >
            <IconLogout size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}

/** Agent availability: Online / Away — Away stops new auto-assigned chats. */
function AvailabilityToggle() {
  const { me, setAway, connected } = useApp();
  const [openMenu, setOpenMenu] = React.useState(false);
  if (!me) return null;
  const away = !!me.away;
  const state = !connected ? 'offline' : away ? 'away' : 'online';
  const label = state === 'offline' ? 'Reconnecting…' : state === 'away' ? 'Away' : 'Online';
  return (
    <div className="avail">
      <button className="avail-current" onClick={() => setOpenMenu((v) => !v)} disabled={!connected}>
        <span className={classNames('avail-dot', `avail-${state}`)} />
        <span className="avail-label">{label}</span>
        <span className="avail-caret">⌄</span>
      </button>
      {openMenu && connected && (
        <div className="avail-menu">
          <button
            className="avail-opt"
            onClick={() => {
              setAway(false);
              setOpenMenu(false);
            }}
          >
            <span className="avail-dot avail-online" /> Online
            <span className="avail-opt-sub">Receive new chats</span>
          </button>
          <button
            className="avail-opt"
            onClick={() => {
              setAway(true);
              setOpenMenu(false);
            }}
          >
            <span className="avail-dot avail-away" /> Away
            <span className="avail-opt-sub">Pause new chats</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { authed, booting, me, activeCall } = useApp();

  if (!authed) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if (booting || !me) {
    return (
      <div className="splash">
        <LogoMark size={40} />
        <span>Loading workspace…</span>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="content">
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/visitors" element={<Visitors key="live" />} />
          <Route path="/history" element={<Visitors key="history" initialView="history" />} />
          <Route path="/profile" element={<Profile />} />
          <Route
            path="/monitoring"
            element={
              <RequireRole roles={['LEAD', 'MANAGER', 'ADMIN']}>
                <Monitoring />
              </RequireRole>
            }
          />
          <Route
            path="/reports"
            element={
              <RequireRole roles={['LEAD', 'MANAGER', 'ADMIN']}>
                <Reports />
              </RequireRole>
            }
          />
          <Route
            path="/dashboard"
            element={
              <RequireRole roles={['LEAD', 'MANAGER', 'ADMIN']}>
                <Dashboard />
              </RequireRole>
            }
          />
          <Route path="/admin" element={<Navigate to="/admin/agents" replace />} />
          <Route
            path="/admin/:section"
            element={
              <RequireRole roles={['ADMIN', 'MANAGER']}>
                <Admin />
              </RequireRole>
            }
          />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <DockedChatWindow />
      <ChatDock />
      <Toasts />
      {activeCall && <CallOverlay call={activeCall} />}
    </div>
  );
}
