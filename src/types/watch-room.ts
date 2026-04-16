// 观影室相关类型定义

export interface Room {
  id: string;
  name: string;
  description: string;
  hasPassword?: boolean;
  password?: string;
  isPublic: boolean;
  roomType: RoomType;
  ownerId: string;
  ownerName: string;
  ownerToken?: string; // 仅创建房间时回传给房主，用于重连时验证身份
  memberCount: number;
  currentState: PlayState | LiveState | ScreenState | null;
  createdAt: number;
  lastOwnerHeartbeat: number;
}

export type RoomType = 'sync' | 'screen';

export interface Member {
  id: string;
  name: string;
  isOwner: boolean;
  lastHeartbeat: number;
  lastClientReportAt?: number;
  lastKnownMediaTime?: number;
  isVisible?: boolean;
  syncStatus?: MemberSyncStatus;
  needsGesture?: boolean;
  currentSource?: string;
  currentSourceName?: string;
  currentVideoId?: string;
  currentVideoName?: string;
}

export type MemberSyncStatus =
  | 'idle'
  | 'waiting_owner'
  | 'syncing'
  | 'in_sync'
  | 'paused_synced'
  | 'waiting_gesture'
  | 'recovering'
  | 'background';

export interface PlayState {
  type: 'play';
  url: string;
  currentTime: number;
  isPlaying: boolean;
  videoId: string;
  videoName: string;
  videoYear?: string;
  searchTitle?: string;
  episode?: number;
  source: string;
  revision?: number;
  anchorMediaTime?: number;
  anchorServerTime?: number;
  targetStartAt?: number;
  targetLatencyMs?: number;
  autoCorrectionEnabled?: boolean;
  driftToleranceMs?: number;
  hardSeekThresholdMs?: number;
  lastBroadcastAt?: number;
}

export interface LiveState {
  type: 'live';
  channelId: string;
  channelName: string;
  channelUrl: string;
}

export interface ScreenState {
  type: 'screen';
  status: 'idle' | 'sharing';
  ownerName: string;
  hasAudio?: boolean;
  startedAt?: number;
}

export interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  content: string;
  type: 'text' | 'emoji';
  timestamp: number;
}

export interface SourceSyncCandidate {
  source: string;
  id: string;
  title: string;
  weight?: number;
}

export interface SourceSyncReportItem extends SourceSyncCandidate {
  available: boolean;
  speedKBps: number;
  totalDurationSeconds?: number;
  playlistFingerprint?: string;
}

export interface SourceSyncResult {
  requestId: string;
  selected?: SourceSyncCandidate;
  error?: string;
}

export interface RoomMemberInfo {
  roomId: string;
  userId: string;
  userName: string;
  isOwner: boolean;
}

// Socket.IO 事件类型
export interface ServerToClientEvents {
  'room:created': (room: Room) => void;
  'room:joined': (data: { room: Room; members: Member[] }) => void;
  'room:left': () => void;
  'room:list': (rooms: Room[]) => void;
  'room:member-joined': (member: Member) => void;
  'room:member-left': (userId: string) => void;
  'room:member-updated': (member: Member) => void;
  'room:deleted': () => void;
  'play:timeline': (state: PlayState) => void;
  'play:update': (state: PlayState) => void;
  'play:seek': (currentTime: number) => void;
  'play:play': () => void;
  'play:pause': () => void;
  'play:change': (state: PlayState) => void;
  'live:change': (state: LiveState) => void;
  'screen:start': (state: ScreenState) => void;
  'screen:stop': () => void;
  'screen:viewer-ready': (data: { userId: string }) => void;
  'screen:offer': (data: { userId: string; offer: RTCSessionDescriptionInit }) => void;
  'screen:answer': (data: { userId: string; answer: RTCSessionDescriptionInit }) => void;
  'screen:ice': (data: { userId: string; candidate: RTCIceCandidateInit }) => void;
  'chat:message': (message: ChatMessage) => void;
  'voice:offer': (data: { userId: string; offer: RTCSessionDescriptionInit }) => void;
  'voice:answer': (data: { userId: string; answer: RTCSessionDescriptionInit }) => void;
  'voice:ice': (data: { userId: string; candidate: RTCIceCandidateInit }) => void;
  'voice:mic-enabled': (data: { userId: string }) => void;
  'voice:audio-chunk': (data: { userId: string; audioData: number[]; sampleRate?: number }) => void;
  'state:cleared': () => void;
  'source:sync-request': (data: {
    requestId: string;
    videoId: string;
    candidates: SourceSyncCandidate[];
  }) => void;
  'source:sync-result': (data: SourceSyncResult) => void;
  'heartbeat:pong': (data: { timestamp: number }) => void;
  'error': (message: string) => void;
}

export interface ClientToServerEvents {
  'room:create': (data: {
    name: string;
    description: string;
    password?: string;
    isPublic: boolean;
    roomType: RoomType;
    userName: string;
  }, callback: (response: { success: boolean; room?: Room; error?: string }) => void) => void;

  'room:join': (data: {
    roomId: string;
    password?: string;
    userName: string;
    ownerToken?: string; // 房主令牌，用于重连时恢复房主身份
  }, callback: (response: { success: boolean; room?: Room; members?: Member[]; error?: string }) => void) => void;

  'room:leave': () => void;

  'room:list': (callback: (rooms: Room[]) => void) => void;
  'room:snapshot': (callback: (response: {
    success: boolean;
    room?: Room;
    members?: Member[];
    serverTime?: number;
    error?: string;
  }) => void) => void;

  'play:update': (state: PlayState) => void;
  'play:seek': (currentTime: number) => void;
  'play:play': () => void;
  'play:pause': () => void;
  'play:change': (state: PlayState) => void;

  'live:change': (state: LiveState) => void;
  'screen:helper-register': (data: {
    roomId: string;
    ownerToken: string;
  }, callback: (response: { success: boolean; error?: string }) => void) => void;
  'screen:start': (state: ScreenState) => void;
  'screen:stop': () => void;
  'screen:viewer-ready': () => void;
  'screen:offer': (data: { targetUserId: string; offer: RTCSessionDescriptionInit }) => void;
  'screen:answer': (data: { targetUserId: string; answer: RTCSessionDescriptionInit }) => void;
  'screen:ice': (data: { targetUserId: string; candidate: RTCIceCandidateInit }) => void;

  'chat:message': (data: { content: string; type: 'text' | 'emoji' }) => void;
  'member:report': (data: {
    currentTime: number;
    paused: boolean;
    visible: boolean;
    syncStatus: MemberSyncStatus;
    needsGesture?: boolean;
    currentSource?: string;
    currentSourceName?: string;
    currentVideoId?: string;
    currentVideoName?: string;
  }) => void;
  'source:sync-request': (data: {
    requestId: string;
    videoId: string;
    candidates: SourceSyncCandidate[];
  }) => void;
  'source:sync-report': (data: {
    requestId: string;
    videoId: string;
    results: SourceSyncReportItem[];
  }) => void;

  'voice:offer': (data: { targetUserId: string; offer: RTCSessionDescriptionInit }) => void;
  'voice:answer': (data: { targetUserId: string; answer: RTCSessionDescriptionInit }) => void;
  'voice:ice': (data: { targetUserId: string; candidate: RTCIceCandidateInit }) => void;
  'voice:audio-chunk': (data: { roomId: string; audioData: number[]; sampleRate?: number }) => void;

  'state:clear': (callback?: (response: { success: boolean; error?: string }) => void) => void;

  'heartbeat': () => void;
}

// 配置类型
export interface WatchRoomConfig {
  enabled: boolean;
  serverType: 'internal' | 'external';
  externalServerUrl?: string;
  externalServerAuth?: string; // 通过 /api/watch-room-auth 接口获取（需要登录）
}

// LocalStorage 存储的房间信息
export interface StoredRoomInfo {
  roomId: string;
  roomName: string;
  isOwner: boolean;
  userName: string;
  ownerToken?: string; // 房主令牌
  timestamp: number;
}
