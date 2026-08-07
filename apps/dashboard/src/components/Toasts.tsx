import React from 'react';
import { useApp } from '../state';
import { classNames } from '../util';
import { IconPhone, IconVideo, IconX } from '../icons';

/** Toast stack + persistent incoming-call card, rendered at app level. */
export default function Toasts() {
  const { toasts, dismissToast, incomingCall, acceptIncomingCall, declineIncomingCall } = useApp();

  return (
    <div className="toast-stack">
      {incomingCall && (
        <div className="toast toast-call">
          <div className="toast-call-icon">
            {incomingCall.call.kind === 'VIDEO' ? <IconVideo size={18} /> : <IconPhone size={18} />}
          </div>
          <div className="toast-body">
            <span className="toast-title">
              Incoming {incomingCall.call.kind === 'VIDEO' ? 'video' : 'audio'} call
            </span>
            <span className="toast-sub">{incomingCall.from} is inviting you to join</span>
            <div className="toast-actions">
              <button className="btn btn-primary btn-sm" onClick={acceptIncomingCall}>
                Join
              </button>
              <button className="btn btn-ghost btn-sm" onClick={declineIncomingCall}>
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
      {toasts.map((t) => (
        <div key={t.id} className={classNames('toast', `toast-${t.kind}`)}>
          <div className="toast-body">
            <span className="toast-title">{t.title}</span>
            {t.body && <span className="toast-sub">{t.body}</span>}
          </div>
          <button className="icon-btn toast-close" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <IconX size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
