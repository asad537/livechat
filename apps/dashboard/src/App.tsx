import React from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import type { Role } from '@livechat/shared';
import { useApp } from './state';
import { classNames, initials } from './util';
import Login from './pages/Login';
import Inbox from './pages/Inbox';
import Visitors from './pages/Visitors';
import Monitoring from './pages/Monitoring';
import Reports from './pages/Reports';
import Admin from './pages/Admin';
import Toasts from './components/Toasts';
import CallOverlay from './components/CallOverlay';
import ChatDock from './components/ChatDock';
import DockedChatWindow from './components/DockedChatWindow';
import {
  IconChart,
  IconEye,
  IconInbox,
  IconLogout,
  IconSettings,
  IconUsers,
  LogoMark,
} from './icons';

function RequireRole({ roles, children }: { roles: Role[]; children: React.ReactElement }) {
  const { me } = useApp();
  if (!me || !roles.includes(me.role)) return <Navigate to="/" replace />;
  return children;
}

function Sidebar() {
  const { me, logout, connected, conversations } = useApp();
  if (!me) return null;

  const unread = Object.values(conversations).reduce(
    (sum, c) => (c.status === 'CLOSED' || c.status === 'MISSED' ? sum : sum + (c.unreadCount ?? 0)),
    0,
  );

  const isLeadUp = me.role === 'LEAD' || me.role === 'ADMIN';

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
        {me.role === 'ADMIN' && (
          <NavLink to="/admin" className={({ isActive }) => classNames('nav-item', isActive && 'active')}>
            {navItem(<IconSettings size={17} />, 'Admin')}
          </NavLink>
        )}
      </nav>
      <div className="sidebar-foot">
        <div className="sidebar-user">
          <span className="avatar" style={{ background: me.avatarColor }}>
            {initials(me.name)}
          </span>
          <div className="sidebar-user-meta">
            <span className="sidebar-user-name">
              {me.name}
              <span
                className={classNames('dot', connected ? 'dot-online' : 'dot-offline')}
                title={connected ? 'Connected' : 'Reconnecting…'}
              />
            </span>
            <span className="sidebar-user-role">{me.role}</span>
          </div>
          <button className="icon-btn icon-btn-dark" onClick={logout} title="Sign out">
            <IconLogout size={16} />
          </button>
        </div>
      </div>
    </aside>
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
          <Route path="/" element={<Inbox />} />
          <Route path="/visitors" element={<Visitors />} />
          <Route
            path="/monitoring"
            element={
              <RequireRole roles={['LEAD', 'ADMIN']}>
                <Monitoring />
              </RequireRole>
            }
          />
          <Route
            path="/reports"
            element={
              <RequireRole roles={['LEAD', 'ADMIN']}>
                <Reports />
              </RequireRole>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireRole roles={['ADMIN']}>
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
