import React from 'react';
import type { ChatMessage } from '@livechat/shared';
import { fileDownloadUrl } from '../api';
import { formatBytes, formatTime, linkify } from '../util';
import {
  IconDoubleCheck,
  IconDownload,
  IconFile,
  IconPhone,
  IconSingleCheck,
  IconVideo,
} from '../icons';

interface Props {
  message: ChatMessage;
}

/** Delivery ticks for agent-sent messages: sent / delivered / read. */
function Ticks({ message }: { message: ChatMessage }) {
  if (message.readAt) return <IconDoubleCheck className="tick tick-read" />;
  if (message.deliveredAt) return <IconDoubleCheck className="tick tick-delivered" />;
  if (message.id.startsWith('tmp_')) return <IconSingleCheck className="tick tick-pending" />;
  return <IconSingleCheck className="tick tick-sent" />;
}

function FileCard({ message }: { message: ChatMessage }) {
  const file = message.file;
  if (!file) return <span className="msg-text">{message.body}</span>;
  const clean = file.scanStatus === 'CLEAN';
  const blocked = file.scanStatus === 'BLOCKED';
  return (
    <div className="file-card">
      <div className="file-card-icon">
        <IconFile size={20} />
      </div>
      <div className="file-card-meta">
        <span className="file-card-name" title={file.originalName}>
          {file.originalName}
        </span>
        <span className="file-card-sub">
          {formatBytes(file.size)}
          {blocked && ' · Blocked by security scan'}
          {file.scanStatus === 'PENDING' && ' · Scanning…'}
        </span>
      </div>
      {clean && (
        <a
          className="file-card-download"
          href={fileDownloadUrl(file)}
          target="_blank"
          rel="noreferrer"
          title="Download"
        >
          <IconDownload size={16} />
        </a>
      )}
    </div>
  );
}

function CallCard({ message }: { message: ChatMessage }) {
  const call = message.call;
  const kind = call?.kind ?? 'AUDIO';
  const statusLabel =
    call?.status === 'ENDED'
      ? 'Ended'
      : call?.status === 'DECLINED'
        ? 'Declined'
        : call?.status === 'ACTIVE'
          ? 'In progress'
          : 'Ringing';
  return (
    <div className="call-card">
      <div className="call-card-icon">
        {kind === 'VIDEO' ? <IconVideo size={18} /> : <IconPhone size={18} />}
      </div>
      <div className="call-card-meta">
        <span className="call-card-title">{message.body || (kind === 'VIDEO' ? 'Video call' : 'Audio call')}</span>
        <span className="call-card-sub">{statusLabel}</span>
      </div>
    </div>
  );
}

export default function MessageBubble({ message }: Props) {
  if (message.senderType === 'SYSTEM' || message.kind === 'SYSTEM') {
    return (
      <div className="msg-row msg-row-system">
        <span className="msg-system">{message.body}</span>
      </div>
    );
  }

  const own = message.senderType === 'AGENT';
  return (
    <div className={own ? 'msg-row msg-row-own' : 'msg-row msg-row-other'}>
      <div className={own ? 'msg-bubble msg-bubble-own' : 'msg-bubble msg-bubble-other'}>
        {own && message.sender?.name && <span className="msg-sender">{message.sender.name}</span>}
        {message.kind === 'FILE' ? (
          <FileCard message={message} />
        ) : message.kind === 'CALL' ? (
          <CallCard message={message} />
        ) : (
          <span className="msg-text">{linkify(message.body)}</span>
        )}
        <span className="msg-meta">
          <span className="msg-time">{formatTime(message.createdAt)}</span>
          {own && <Ticks message={message} />}
        </span>
      </div>
    </div>
  );
}
