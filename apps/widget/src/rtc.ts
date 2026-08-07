// ─── BUILTIN P2P call session (WebRTC mesh over Socket.IO) ───
// Convention shared with the dashboard client: the peer that
// receives `EV.CallPeers` (i.e. the one that just joined) creates
// offers towards every existing peer; existing peers answer.

import type { Socket } from 'socket.io-client';
import { EV, type CallKind } from '@livechat/shared';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

export interface RemoteTile {
  peerId: string;
  label: string;
  stream: MediaStream;
  hasVideo: boolean;
}

interface SignalData {
  type?: 'offer' | 'answer' | 'candidate';
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

interface PeersPayload {
  callId: string;
  peers: { peerId: string; label: string }[];
}
interface JoinPayload {
  callId: string;
  peerId: string;
  label?: string;
}
interface SignalPayload {
  callId: string;
  from: string;
  data: SignalData;
}
interface LeavePayload {
  callId: string;
  peerId: string;
}

export class CallSession {
  localStream: MediaStream | null = null;
  micOn = true;
  camOn: boolean;

  private pcs = new Map<string, RTCPeerConnection>();
  private streams = new Map<string, MediaStream>();
  private labels = new Map<string, string>();
  private pendingIce = new Map<string, RTCIceCandidateInit[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlers: Array<[string, (...args: any[]) => void]> = [];
  private closed = false;

  constructor(
    private socket: Socket,
    readonly callId: string,
    readonly kind: CallKind,
    private onUpdate: () => void,
  ) {
    this.camOn = kind === 'VIDEO';
  }

  /** Acquire local media. Must resolve before join(). */
  async init(): Promise<void> {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video:
        this.kind === 'VIDEO'
          ? { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' }
          : false,
    });
  }

  /** Bind signaling handlers and announce ourselves to the server. */
  join(): void {
    this.on(EV.CallPeers, (p: PeersPayload) => {
      if (p.callId !== this.callId) return;
      for (const peer of p.peers) void this.connectTo(peer.peerId, peer.label, true);
    });
    this.on(EV.CallJoin, (p: JoinPayload) => {
      if (p.callId !== this.callId || !p.peerId) return;
      // A newcomer joined — it will send us an offer; just remember its label.
      if (p.label) this.labels.set(p.peerId, p.label);
      this.onUpdate();
    });
    this.on(EV.CallSignal, (p: SignalPayload) => {
      if (p.callId !== this.callId) return;
      void this.handleSignal(p.from, p.data);
    });
    this.on(EV.CallLeave, (p: LeavePayload) => {
      if (p.callId !== this.callId) return;
      this.dropPeer(p.peerId);
    });
    this.socket.emit(EV.CallJoin, { callId: this.callId });
  }

  /** Leave the call and tear everything down. */
  leave(emit = true): void {
    if (this.closed) return;
    this.closed = true;
    if (emit && this.socket.connected) this.socket.emit(EV.CallLeave, { callId: this.callId });
    for (const [event, fn] of this.handlers) this.socket.off(event, fn);
    this.handlers = [];
    for (const pc of this.pcs.values()) {
      try {
        pc.close();
      } catch {
        /* already closed */
      }
    }
    this.pcs.clear();
    this.streams.clear();
    this.pendingIce.clear();
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.localStream = null;
    this.onUpdate();
  }

  toggleMic(): boolean {
    this.micOn = !this.micOn;
    for (const t of this.localStream?.getAudioTracks() ?? []) t.enabled = this.micOn;
    this.onUpdate();
    return this.micOn;
  }

  toggleCam(): boolean {
    this.camOn = !this.camOn;
    for (const t of this.localStream?.getVideoTracks() ?? []) t.enabled = this.camOn;
    this.onUpdate();
    return this.camOn;
  }

  tiles(): RemoteTile[] {
    return [...this.pcs.keys()].map((peerId) => {
      const stream = this.streams.get(peerId) ?? new MediaStream();
      return {
        peerId,
        label: this.labels.get(peerId) ?? 'Guest',
        stream,
        hasVideo: stream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted),
      };
    });
  }

  // ── internals ──────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private on(event: string, fn: (...args: any[]) => void): void {
    this.socket.on(event, fn);
    this.handlers.push([event, fn]);
  }

  private signal(to: string, data: SignalData): void {
    this.socket.emit(EV.CallSignal, { callId: this.callId, to, data });
  }

  private async connectTo(peerId: string, label: string | undefined, initiator: boolean): Promise<RTCPeerConnection | null> {
    if (this.closed) return null;
    const existing = this.pcs.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pcs.set(peerId, pc);
    if (label) this.labels.set(peerId, label);
    const stream = new MediaStream();
    this.streams.set(peerId, stream);

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal(peerId, { type: 'candidate', candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      if (!stream.getTracks().some((t) => t.id === e.track.id)) stream.addTrack(e.track);
      e.track.onended = () => this.onUpdate();
      e.track.onmute = () => this.onUpdate();
      e.track.onunmute = () => this.onUpdate();
      this.onUpdate();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.dropPeer(peerId);
      else this.onUpdate();
    };

    if (initiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.signal(peerId, { type: 'offer', sdp: offer });
      } catch (err) {
        console.warn('[livechat] failed to create offer', err);
      }
    }
    this.onUpdate();
    return pc;
  }

  private async handleSignal(from: string, data: SignalData): Promise<void> {
    if (this.closed || !data) return;
    // Tolerant: infer the signal kind when the sender omitted `type`
    // (sdp.type carries offer/answer; a bare candidate is a candidate).
    if (!data.type) {
      if (data.sdp?.type === 'offer' || data.sdp?.type === 'answer') data.type = data.sdp.type;
      else if (data.candidate) data.type = 'candidate';
    }
    try {
      if (data.type === 'offer' && data.sdp) {
        const pc = (await this.connectTo(from, this.labels.get(from), false)) ?? this.pcs.get(from);
        if (!pc) return;
        await pc.setRemoteDescription(data.sdp);
        await this.flushIce(from, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signal(from, { type: 'answer', sdp: answer });
      } else if (data.type === 'answer' && data.sdp) {
        const pc = this.pcs.get(from);
        if (!pc) return;
        await pc.setRemoteDescription(data.sdp);
        await this.flushIce(from, pc);
      } else if (data.type === 'candidate' && data.candidate) {
        const pc = this.pcs.get(from);
        if (pc && pc.remoteDescription) {
          await pc.addIceCandidate(data.candidate);
        } else {
          const queue = this.pendingIce.get(from) ?? [];
          queue.push(data.candidate);
          this.pendingIce.set(from, queue);
        }
      }
    } catch (err) {
      console.warn('[livechat] signaling error', err);
    }
  }

  private async flushIce(peerId: string, pc: RTCPeerConnection): Promise<void> {
    const queue = this.pendingIce.get(peerId);
    if (!queue) return;
    this.pendingIce.delete(peerId);
    for (const candidate of queue) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn('[livechat] failed to add ICE candidate', err);
      }
    }
  }

  private dropPeer(peerId: string): void {
    const pc = this.pcs.get(peerId);
    if (!pc) return;
    try {
      pc.close();
    } catch {
      /* noop */
    }
    this.pcs.delete(peerId);
    this.streams.delete(peerId);
    this.labels.delete(peerId);
    this.pendingIce.delete(peerId);
    this.onUpdate();
  }
}
