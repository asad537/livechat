import React from 'react';
import type { Visitor } from '@livechat/shared';
import { classNames, formatWhen, initials } from '../util';
import { IconMessage } from '../icons';

interface Props {
  visitor: Visitor;
  accentColor: string;
  onStartChat(visitor: Visitor): void;
}

export default function VisitorCard({ visitor, accentColor, onStartChat }: Props) {
  const name = visitor.name || `Visitor ${visitor.id.slice(0, 6)}`;
  return (
    <div className="visitor-card card">
      <div className="visitor-card-top">
        <span className="avatar avatar-lg" style={{ background: accentColor }}>
          {initials(name)}
        </span>
        <div className="visitor-card-meta">
          <span className="visitor-card-name">
            {name}
            <span className={classNames('dot', visitor.online ? 'dot-online' : 'dot-offline')} />
          </span>
          <span className="visitor-card-sub">{visitor.email || 'No email'}</span>
        </div>
      </div>
      <div className="visitor-card-body">
        {visitor.currentPage ? (
          <div className="visitor-card-page" title={visitor.currentPage}>
            <span className="visitor-card-page-label">Viewing</span>
            <span className="visitor-card-page-url">{visitor.currentPage}</span>
          </div>
        ) : (
          <div className="visitor-card-page visitor-card-page-idle">
            {visitor.online ? 'Browsing' : `Last seen ${formatWhen(visitor.lastSeenAt) || 'a while ago'}`}
          </div>
        )}
      </div>
      <button className="btn btn-primary btn-sm visitor-card-cta" onClick={() => onStartChat(visitor)}>
        <IconMessage size={15} /> Start chat
      </button>
    </div>
  );
}
