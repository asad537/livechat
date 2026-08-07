// ─── Call UI: incoming invite card + in-call overlay ─────────
import type { CallMeta } from '@livechat/shared';
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { CallSession } from './rtc';
import { initials } from './util';
import { IconCam, IconHangup, IconMic, IconPhone, IconVideo } from './messages';

// ─── Incoming call card ──────────────────────────────────────

export interface Invite {
  call: CallMeta;
  from: { name: string } | null;
}

export function IncomingCallCard({
  invite,
  onAccept,
  onDecline,
}: {
  invite: Invite;
  onAccept: () => void;
  onDecline: () => void;
}): JSX.Element {
  const video = invite.call.kind === 'VIDEO';
  return (
    <div class="lc-invite">
      <div class="lc-invite-head">
        <div class="lc-invite-icon">{video ? <IconVideo size={20} /> : <IconPhone size={20} />}</div>
        <div>
          <div class="lc-invite-title">Incoming {video ? 'video' : 'audio'} call</div>
          <div class="lc-invite-sub">{invite.from?.name ?? 'Support agent'} is calling you</div>
        </div>
      </div>
      <div class="lc-invite-actions">
        <button type="button" class="lc-decline" onClick={onDecline}>
          <IconHangup /> Decline
        </button>
        <button type="button" class="lc-accept" onClick={onAccept}>
          {video ? <IconVideo /> : <IconPhone />} Accept
        </button>
      </div>
    </div>
  );
}

// ─── Media tile ──────────────────────────────────────────────

function Tile({
  stream,
  label,
  muted,
  hasVideo,
  color,
}: {
  stream: MediaStream | null;
  label: string;
  muted: boolean;
  hasVideo: boolean;
  color: string;
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) {
      el.srcObject = stream;
      void el.play().catch(() => undefined);
    }
  }, [stream]);
  return (
    <div class="lc-tile">
      <video ref={ref} autoplay playsinline muted={muted} style={hasVideo ? undefined : 'visibility:hidden'} />
      {!hasVideo && (
        <div class="lc-tile-avatar">
          <div class="lc-bigdot" style={`background:${color}`}>{initials(label)}</div>
        </div>
      )}
      <div class="lc-tile-label">{label}</div>
    </div>
  );
}

// ─── In-call overlay ─────────────────────────────────────────

export function CallOverlay({
  session,
  meta,
  selfLabel,
  brandColor,
  onHangup,
}: {
  session: CallSession;
  meta: CallMeta;
  selfLabel: string;
  brandColor: string;
  onHangup: () => void;
  /** bump-only prop so the overlay re-renders on session updates */
  tick?: number;
}): JSX.Element {
  const remote = session.tiles();
  const video = meta.kind === 'VIDEO';
  const count = remote.length + 1;
  const localHasVideo =
    session.camOn && (session.localStream?.getVideoTracks().some((t) => t.readyState === 'live') ?? false);

  return (
    <div class="lc-callwin">
      <div class="lc-callhead">
        <span style={`color:${brandColor}`}>{video ? <IconVideo /> : <IconPhone />}</span>
        <span class="lc-callhead-title">{video ? 'Video call' : 'Audio call'}</span>
        <span class="lc-callhead-status">
          <span class="lc-livedot" />
          {meta.status === 'ACTIVE' ? (remote.length > 0 ? 'Connected' : 'Connecting…') : 'Ringing…'}
        </span>
      </div>
      <div class={`lc-tiles ${count > 2 ? 'lc-tiles-many' : ''}`}>
        <Tile stream={session.localStream} label={`${selfLabel} (you)`} muted hasVideo={localHasVideo} color={brandColor} />
        {remote.map((t) => (
          <Tile key={t.peerId} stream={t.stream} label={t.label} muted={false} hasVideo={t.hasVideo} color="#6366f1" />
        ))}
      </div>
      <div class="lc-callbar">
        <button
          type="button"
          class={`lc-ctl ${session.micOn ? '' : 'lc-ctl-off'}`}
          title={session.micOn ? 'Mute microphone' : 'Unmute microphone'}
          onClick={() => session.toggleMic()}
        >
          <IconMic off={!session.micOn} />
        </button>
        {video && (
          <button
            type="button"
            class={`lc-ctl ${session.camOn ? '' : 'lc-ctl-off'}`}
            title={session.camOn ? 'Turn camera off' : 'Turn camera on'}
            onClick={() => session.toggleCam()}
          >
            <IconCam off={!session.camOn} />
          </button>
        )}
        <button type="button" class="lc-ctl lc-ctl-end" title="Hang up" onClick={onHangup}>
          <IconHangup />
        </button>
      </div>
    </div>
  );
}
