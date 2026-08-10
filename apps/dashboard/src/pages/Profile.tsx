import React, { useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../state';
import Avatar from '../components/Avatar';

const COLORS = [
  '#7c3aed',
  '#db2777',
  '#2563eb',
  '#0d9488',
  '#16a34a',
  '#f59e0b',
  '#ea580c',
  '#e11d48',
  '#6366f1',
  '#0ea5e9',
];

export default function Profile() {
  const { me, setMeUser, pushToast } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(me?.name ?? '');
  const [color, setColor] = useState(me?.avatarColor ?? COLORS[0]);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [uploading, setUploading] = useState(false);

  if (!me) return null;

  const saveProfile = async () => {
    if (savingProfile) return;
    setSavingProfile(true);
    try {
      const { user } = await api.updateMe({ name: name.trim(), avatarColor: color });
      setMeUser(user);
      pushToast('Profile updated', 'Your name and avatar color were saved.', 'success');
    } catch (e) {
      pushToast('Could not save profile', e instanceof Error ? e.message : undefined, 'error');
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async () => {
    if (savingPassword) return;
    if (newPassword.length < 8) {
      pushToast('Password too short', 'Use at least 8 characters.', 'error');
      return;
    }
    if (newPassword !== confirmPassword) {
      pushToast('Passwords do not match', 'Retype the new password.', 'error');
      return;
    }
    setSavingPassword(true);
    try {
      const { user } = await api.updateMe({ currentPassword, newPassword });
      setMeUser(user);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      pushToast('Password changed', 'Use the new password next time you sign in.', 'success');
    } catch (e) {
      pushToast('Could not change password', e instanceof Error ? e.message : undefined, 'error');
    } finally {
      setSavingPassword(false);
    }
  };

  const uploadPic = async (file: File) => {
    setUploading(true);
    try {
      const user = await api.uploadMyAvatar(file);
      setMeUser(user);
      pushToast('Photo updated', 'Looking good! 📸', 'success');
    } catch (e) {
      pushToast('Upload failed', e instanceof Error ? e.message : undefined, 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removePic = async () => {
    try {
      const { user } = await api.deleteMyAvatar();
      setMeUser(user);
      pushToast('Photo removed', 'Back to initials.', 'success');
    } catch (e) {
      pushToast('Could not remove photo', e instanceof Error ? e.message : undefined, 'error');
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>My profile</h2>
          <p className="page-sub">Your name, photo and password — visible to customers in the chat.</p>
        </div>
      </div>

      <div className="profile-grid">
        {/* ── Photo ── */}
        <div className="card report-card">
          <h3>Profile photo</h3>
          <div className="profile-photo-row">
            <Avatar name={me.name} color={me.avatarColor} url={me.avatarUrl} size="lg" className="profile-photo" />
            <div className="profile-photo-actions">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadPic(f);
                }}
              />
              <button
                className="btn btn-primary btn-sm"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? 'Uploading…' : me.avatarUrl ? 'Change photo' : 'Upload photo'}
              </button>
              {me.avatarUrl && (
                <button className="btn btn-ghost btn-sm" onClick={() => void removePic()}>
                  Remove
                </button>
              )}
              <p className="profile-hint">PNG, JPG, WebP or GIF — up to 2 MB.</p>
            </div>
          </div>
        </div>

        {/* ── Name + color ── */}
        <div className="card report-card">
          <h3>Display name &amp; color</h3>
          <label className="field">
            <span>Name (customers see this)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={255} />
          </label>
          <div className="field">
            <span>Avatar color (used when there is no photo)</span>
            <div className="profile-colors">
              {COLORS.map((c) => (
                <button
                  key={c}
                  className={`profile-swatch ${c === color ? 'active' : ''}`}
                  style={{ background: c }}
                  aria-label={c}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>
          <div className="vd-form-actions">
            <button
              className="btn btn-primary btn-sm"
              disabled={savingProfile || name.trim().length < 2}
              onClick={() => void saveProfile()}
            >
              {savingProfile ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>

        {/* ── Password ── */}
        <div className="card report-card">
          <h3>Change password</h3>
          <label className="field">
            <span>Current password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </label>
          <div className="profile-pass-grid">
            <label className="field">
              <span>New password (min 8)</span>
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Confirm new password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>
          </div>
          <div className="vd-form-actions">
            <button
              className="btn btn-primary btn-sm"
              disabled={savingPassword || !currentPassword || !newPassword}
              onClick={() => void savePassword()}
            >
              {savingPassword ? 'Saving…' : 'Change password'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
