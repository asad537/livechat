import React from 'react';
import type { AssignmentRecord } from '@livechat/shared';
import { formatDay, formatTime } from '../util';

interface Props {
  history: AssignmentRecord[];
}

const REASON_LABEL: Record<AssignmentRecord['reason'], string> = {
  AUTO: 'Auto-assigned',
  OFFER: 'Chat offered',
  TRANSFER: 'Transferred',
};

export default function HistoryTimeline({ history }: Props) {
  if (history.length === 0) {
    return <div className="empty-hint">No assignment history yet.</div>;
  }
  return (
    <div className="timeline">
      {history.map((rec) => (
        <div key={rec.id} className="timeline-item">
          <span className={`timeline-dot reason-${rec.reason.toLowerCase()}`} />
          <div className="timeline-body">
            <span className="timeline-title">
              {REASON_LABEL[rec.reason] ?? rec.reason}
              {' → '}
              <strong>{rec.toUser?.name ?? 'Unknown agent'}</strong>
            </span>
            {rec.fromUser && <span className="timeline-sub">from {rec.fromUser.name}</span>}
            <span className="timeline-when">
              {formatDay(rec.createdAt)} · {formatTime(rec.createdAt)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
