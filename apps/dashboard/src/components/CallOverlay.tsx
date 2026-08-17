import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CallMeta } from '@livechat/shared';
import { EV } from '@livechat/shared';
import { useApp } from '../state';
import { getSocket } from '../socket';
import { initials } from '../util';
import {
  IconMic,
  IconMicOff,
  IconPhoneOff,
  IconUserPlus,
  IconVideo,
  IconVideoOff,
  IconX,
} from '../icons';

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

/** Human-readable reason for a getUserMedia camera failure. */
function cameraErrorText(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'NotReadableError' || name === 'TrackStartError')
    return 'Camera is in use by another app or tab — close it (Zoom/Meet/other browser) and press the camera button to retry.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError')
    return 'No camera found on this device — joined with audio only.';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError')
    return 'Camera blocked — allow it in the browser (lock icon) AND in system settings (Privacy → Camera), then press the camera button to retry.';
  return 'Camera unavailable — joined with audio only. Press the camera button to retry.';
}

interface PeerState {
  peerId: string;
  label: string;
  stream: MediaStream | null;
}

interface SignalData {
  type?: 'offer' | 'answer' | 'candidate';
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

function VideoTile({ stream, label, muted, video }: { stream: MediaStream | null; label: string; muted?: boolean; video: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (ref.current && stream) ref.current.srcObject = stream;
    if (audioRef.current && stream) audioRef.current.srcObject = stream;
  }, [stream]);
  return (
    <div className="call-tile">
      {video ? (
        <video ref={ref} autoPlay playsInline muted={muted} />
      ) : (
        <>
          <div className="call-tile-avatar">{initials(label)}</div>
          {!muted && <audio ref={audioRef} autoPlay />}
        </>
      )}
      <span className="call-tile-label">{label}</span>
    </div>
  );
}

/**
 * WebRTC mesh call window (BUILTIN provider).
 * The joining peer receives EV.CallPeers and initiates offers to every existing
 * peer; peers notified via the EV.CallJoin broadcast wait for the newcomer's offer.
 */
export default function CallOverlay({ call }: { call: CallMeta }) {
  const { me, teams, online, clearActiveCall, pushToast } = useApp();
  const [peers, setPeers] = useState<Record<string, PeerState>>({});
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const labelsRef = useRef<Map<string, string>>(new Map());
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const endedRef = useRef(false);
  const isVideo = call.kind === 'VIDEO';

  const teardown = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    for (const pc of pcsRef.current.values()) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    pcsRef.current.clear();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
  }, []);

  const hangup = useCallback(() => {
    const socket = getSocket();
    socket?.emit(EV.CallLeave, { callId: call.id });
    teardown();
    clearActiveCall();
  }, [call.id, teardown, clearActiveCall]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    let disposed = false;

    const sendSignal = (to: string, data: SignalData) => {
      socket.emit(EV.CallSignal, { callId: call.id, to, data });
    };

    const createPeer = (peerId: string, label: string, initiator: boolean): RTCPeerConnection => {
      labelsRef.current.set(peerId, label);
      const existing = pcsRef.current.get(peerId);
      if (existing) return existing;
      const pc = new RTCPeerConnection(ICE_SERVERS);
      pcsRef.current.set(peerId, pc);
      setPeers((prev) => ({ ...prev, [peerId]: { peerId, label, stream: prev[peerId]?.stream ?? null } }));

      const stream = localStreamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
      }

      pc.onicecandidate = (e) => {
        if (e.candidate) sendSignal(peerId, { type: 'candidate', candidate: e.candidate.toJSON() });
      };
      pc.ontrack = (e) => {
        const remote = e.streams[0] ?? null;
        setPeers((prev) => {
          const entry = prev[peerId] ?? { peerId, label, stream: null };
          return { ...prev, [peerId]: { ...entry, stream: remote } };
        });
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          setPeers((prev) => {
            const entry = prev[peerId];
            if (!entry) return prev;
            return { ...prev, [peerId]: { ...entry, stream: null } };
          });
        }
      };

      if (initiator) {
        void (async () => {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            if (pc.localDescription) {
              sendSignal(peerId, { type: 'offer', sdp: pc.localDescription.toJSON() });
            }
          } catch {
            /* peer might have left mid-negotiation */
          }
        })();
      }
      return pc;
    };

    const flushPendingIce = async (peerId: string, pc: RTCPeerConnection) => {
      const queue = pendingIceRef.current.get(peerId);
      if (!queue) return;
      pendingIceRef.current.delete(peerId);
      for (const candidate of queue) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch {
          /* stale candidate */
        }
      }
    };

    const removePeer = (peerId: string) => {
      const pc = pcsRef.current.get(peerId);
      if (pc) {
        try {
          pc.close();
        } catch {
          /* ignore */
        }
        pcsRef.current.delete(peerId);
      }
      setPeers((prev) => {
        if (!(peerId in prev)) return prev;
        const next = { ...prev };
        delete next[peerId];
        return next;
      });
    };

    const onPeers = (payload: { callId: string; peers: { peerId: string; label: string }[] }) => {
      if (payload.callId !== call.id) return;
      for (const p of payload.peers ?? []) createPeer(p.peerId, p.label, true);
    };

    const onJoin = (payload: { callId: string; peerId: string; label: string }) => {
      if (payload.callId !== call.id || !payload.peerId) return;
      // Newcomer initiates toward us — just prepare the slot.
      createPeer(payload.peerId, payload.label ?? 'Participant', false);
    };

    const onSignal = (payload: { callId: string; from: string; data: SignalData }) => {
      if (payload.callId !== call.id || !payload.from) return;
      const pc = createPeer(payload.from, labelsRef.current.get(payload.from) ?? 'Participant', false);
      void (async () => {
        try {
          if (payload.data.sdp) {
            await pc.setRemoteDescription(new RTCSessionDescription(payload.data.sdp));
            await flushPendingIce(payload.from, pc);
            if (payload.data.sdp.type === 'offer') {
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              if (pc.localDescription) {
                sendSignal(payload.from, { type: 'answer', sdp: pc.localDescription.toJSON() });
              }
            }
          } else if (payload.data.candidate) {
            if (pc.remoteDescription) {
              await pc.addIceCandidate(new RTCIceCandidate(payload.data.candidate));
            } else {
              // Remote description not set yet — queue and flush later.
              const queue = pendingIceRef.current.get(payload.from) ?? [];
              queue.push(payload.data.candidate);
              pendingIceRef.current.set(payload.from, queue);
            }
          }
        } catch {
          /* stale signal for a closed connection */
        }
      })();
    };

    const onLeave = (payload: { callId: string; peerId: string }) => {
      if (payload.callId !== call.id) return;
      removePeer(payload.peerId);
    };

    socket.on(EV.CallPeers, onPeers);
    socket.on(EV.CallJoin, onJoin);
    socket.on(EV.CallSignal, onSignal);
    socket.on(EV.CallLeave, onLeave);

    void (async () => {
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo });
      } catch (camErr) {
        if (isVideo) {
          // Camera busy/blocked — degrade to audio-only instead of no media.
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            setCamOff(true);
            setMediaError(cameraErrorText(camErr));
          } catch {
            setMediaError(
              'Mic/camera blocked — click the lock icon in the address bar, allow Camera & Microphone, then reload and call again.',
            );
          }
        } else {
          setMediaError(
            'Microphone blocked — click the lock icon in the address bar, allow Microphone, then reload and call again.',
          );
        }
      }
      if (stream) {
        if (disposed) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStreamRef.current = stream;
        setLocalStream(stream);
      }
      if (!disposed) socket.emit(EV.CallJoin, { callId: call.id });
    })();

    return () => {
      disposed = true;
      socket.off(EV.CallPeers, onPeers);
      socket.off(EV.CallJoin, onJoin);
      socket.off(EV.CallSignal, onSignal);
      socket.off(EV.CallLeave, onLeave);
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.id]);

  const toggleMute = () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    setMuted(next);
  };

  const toggleCam = async () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const videoTracks = stream.getVideoTracks();

    if (videoTracks.length > 0) {
      const next = !camOff;
      videoTracks.forEach((t) => {
        t.enabled = !next;
      });
      setCamOff(next);
      return;
    }

    // Joined audio-only — try to acquire the camera now and renegotiate.
    try {
      const cam = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' },
      });
      const track = cam.getVideoTracks()[0];
      if (!track) return;
      stream.addTrack(track);
      setLocalStream(new MediaStream(stream.getTracks()));
      const socket = getSocket();
      for (const [peerId, pc] of pcsRef.current) {
        pc.addTrack(track, stream);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          if (pc.localDescription && socket) {
            socket.emit(EV.CallSignal, {
              callId: call.id,
              to: peerId,
              data: { type: 'offer', sdp: pc.localDescription.toJSON() },
            });
          }
        } catch {
          /* peer left mid-renegotiation */
        }
      }
      setCamOff(false);
      setMediaError(null);
    } catch (err) {
      setMediaError(cameraErrorText(err));
    }
  };

  const inviteCandidates = useMemo(() => {
    const seen = new Set<string>();
    const list: { id: string; name: string; avatarColor: string; role: string }[] = [];
    for (const team of teams) {
      for (const m of team.members ?? []) {
        if (m.id === me?.id || seen.has(m.id) || !online[m.id]) continue;
        seen.add(m.id);
        list.push({ id: m.id, name: m.name, avatarColor: m.avatarColor, role: m.role });
      }
    }
    return list;
  }, [teams, online, me]);

  const invite = (userId: string) => {
    const socket = getSocket();
    socket?.emit(EV.AgentCallInvite, { callId: call.id, userId });
    pushToast('Invitation sent', undefined, 'success');
    setShowInvite(false);
  };

  const peerList = Object.values(peers);
  const ringing = call.status === 'INVITED' && peerList.length === 0;

  return (
    <div className="call-overlay">
      <div className="call-overlay-head">
        <span className="call-overlay-title">
          {isVideo ? <IconVideo size={16} /> : <IconMic size={16} />}
          {isVideo ? 'Video call' : 'Audio call'}
          <span className={`pill ${ringing ? 'pill-waiting' : 'pill-active'}`}>
            {ringing ? 'ringing' : 'live'}
          </span>
        </span>
        <button className="icon-btn icon-btn-dark" onClick={() => setShowInvite((v) => !v)} title="Add participant">
          <IconUserPlus size={16} />
        </button>
      </div>

      {mediaError && <div className="call-media-error">{mediaError}</div>}

      <div className={`call-grid ${isVideo ? 'call-grid-video' : 'call-grid-audio'}`}>
        <VideoTile stream={localStream} label={`${me?.name ?? 'Me'} (you)`} muted video={isVideo && !camOff} />
        {peerList.map((p) => (
          <VideoTile key={p.peerId} stream={p.stream} label={p.label} video={isVideo} />
        ))}
        {ringing && <div className="call-ringing">Waiting for others to join…</div>}
      </div>

      <div className="call-controls">
        <button
          className={`call-btn ${muted ? 'call-btn-off' : ''}`}
          onClick={toggleMute}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <IconMicOff size={18} /> : <IconMic size={18} />}
        </button>
        {isVideo && (
          <button
            className={`call-btn ${camOff ? 'call-btn-off' : ''}`}
            onClick={toggleCam}
            title={camOff ? 'Camera on' : 'Camera off'}
          >
            {camOff ? <IconVideoOff size={18} /> : <IconVideo size={18} />}
          </button>
        )}
        <button className="call-btn call-btn-hangup" onClick={hangup} title="Hang up">
          <IconPhoneOff size={18} />
        </button>
      </div>

      {showInvite && (
        <div className="call-invite-pop">
          <div className="call-invite-head">
            <span>Add participant</span>
            <button className="icon-btn icon-btn-dark" onClick={() => setShowInvite(false)}>
              <IconX size={14} />
            </button>
          </div>
          {inviteCandidates.length === 0 && <div className="empty-hint">No one else is online.</div>}
          {inviteCandidates.map((c) => (
            <button key={c.id} className="call-invite-row" onClick={() => invite(c.id)}>
              <span className="avatar avatar-sm" style={{ background: c.avatarColor }}>
                {initials(c.name)}
              </span>
              <span>{c.name}</span>
              <span className="call-invite-role">{c.role}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
