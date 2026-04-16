// 观影室 Socket.IO 服务实现（内部服务器 / 独立服务器共用）

const EMPTY_ROOM_DELETE_DELAY_MS = 2 * 60 * 1000;
const OWNER_STATE_CLEAR_TIMEOUT_MS = 2 * 60 * 1000;
const OWNER_ROOM_DELETE_TIMEOUT_MS = 15 * 60 * 1000;
const MEMBER_REPORT_STALE_MS = 15 * 1000;
const SOURCE_DURATION_TOLERANCE_SECONDS = 3;

class WatchRoomServer {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    this.members = new Map();
    this.socketToRoom = new Map();
    this.screenHelpers = new Map();
    this.helperToRoom = new Map();
    this.sourceSyncSessions = new Map();
    this.roomDeletionTimers = new Map();
    this.cleanupInterval = null;
    this.setupEventHandlers();
    this.startCleanupTimer();
  }

  serializeRoom(room, options = {}) {
    const {
      includeOwnerToken = false,
    } = options;

    const serialized = {
      ...room,
      hasPassword: !!room.password,
    };

    delete serialized.password;

    if (!includeOwnerToken) {
      delete serialized.ownerToken;
    }

    return serialized;
  }

  getResolvedPlayPosition(state, referenceTime = Date.now()) {
    if (!state || state.type !== 'play') {
      return 0;
    }

    const anchorMediaTime =
      typeof state.anchorMediaTime === 'number'
        ? state.anchorMediaTime
        : state.currentTime || 0;
    const anchorServerTime =
      typeof state.anchorServerTime === 'number'
        ? state.anchorServerTime
        : referenceTime;

    if (state.isPlaying) {
      return anchorMediaTime + Math.max(0, referenceTime - anchorServerTime) / 1000;
    }

    return anchorMediaTime;
  }

  buildTimelineState(previousState, partialState, options = {}) {
    const now = Date.now();
    const currentTime =
      typeof partialState.currentTime === 'number'
        ? partialState.currentTime
        : typeof partialState.anchorMediaTime === 'number'
          ? partialState.anchorMediaTime
          : this.getResolvedPlayPosition(previousState, now);
    const anchorMediaTime =
      typeof partialState.anchorMediaTime === 'number'
        ? partialState.anchorMediaTime
        : currentTime;
    const targetLatencyMs =
      partialState.targetLatencyMs ||
      previousState?.targetLatencyMs ||
      1500;
    const autoCorrectionEnabled =
      partialState.autoCorrectionEnabled !== undefined
        ? partialState.autoCorrectionEnabled
        : previousState?.autoCorrectionEnabled !== undefined
          ? previousState.autoCorrectionEnabled
          : true;
    const driftToleranceMs =
      partialState.driftToleranceMs ||
      previousState?.driftToleranceMs ||
      300;
    const hardSeekThresholdMs =
      partialState.hardSeekThresholdMs ||
      previousState?.hardSeekThresholdMs ||
      1000;
    const revision = (previousState?.revision || 0) + 1;
    const targetStartAt = options.scheduleStart
      ? now + (options.delayMs || targetLatencyMs)
      : undefined;

    return {
      ...(previousState || {}),
      ...partialState,
      currentTime,
      anchorMediaTime,
      anchorServerTime: partialState.anchorServerTime || now,
      targetStartAt,
      targetLatencyMs,
      autoCorrectionEnabled,
      driftToleranceMs,
      hardSeekThresholdMs,
      revision,
      lastBroadcastAt: now,
    };
  }

  isSourceMetadataConsistent(items) {
    if (items.length <= 1) {
      return true;
    }

    const fingerprints = items
      .map((item) => item.playlistFingerprint)
      .filter((value) => typeof value === 'string' && value.length > 0);

    if (fingerprints.length === items.length) {
      return new Set(fingerprints).size === 1;
    }

    const durations = items
      .map((item) => item.totalDurationSeconds)
      .filter((value) => Number.isFinite(value));

    if (durations.length === items.length) {
      const min = Math.min(...durations);
      const max = Math.max(...durations);
      return max - min <= SOURCE_DURATION_TOLERANCE_SECONDS;
    }

    return false;
  }

  resolveSourceSyncSession(roomId, requestId) {
    const key = `${roomId}:${requestId}`;
    const session = this.sourceSyncSessions.get(key);
    if (!session || session.resolved) {
      return;
    }

    session.resolved = true;
    clearTimeout(session.timeoutId);
    this.sourceSyncSessions.delete(key);

    const reports = Array.from(session.reports.values());
    if (reports.length === 0) {
      this.io.to(roomId).emit('source:sync-result', {
        requestId,
        error: '没有收到任何测速结果',
      });
      return;
    }

    const candidateStats = new Map();
    reports.forEach((report) => {
      report.results.forEach((item) => {
        const candidateKey = `${item.source}::${item.id}`;
        if (!candidateStats.has(candidateKey)) {
          candidateStats.set(candidateKey, {
            item,
            availableCount: 0,
            totalSpeed: 0,
            metadataItems: [],
          });
        }

        const stat = candidateStats.get(candidateKey);
        if (item.available) {
          stat.availableCount += 1;
          stat.totalSpeed += item.speedKBps;
          stat.metadataItems.push(item);
        }
      });
    });

    const requiredCount = session.expectedUserIds.size;
    const commonCandidates = Array.from(candidateStats.values())
      .filter((stat) => stat.availableCount === requiredCount)
      .filter((stat) => this.isSourceMetadataConsistent(stat.metadataItems))
      .map((stat) => ({
        ...stat.item,
        averageSpeedKBps: stat.totalSpeed / requiredCount,
      }));

    if (commonCandidates.length === 0) {
      this.io.to(roomId).emit('source:sync-result', {
        requestId,
        error: '没有找到所有参与成员都可用且时长一致的同一播放源',
      });
      return;
    }

    commonCandidates.sort((a, b) => {
      const weightA = a.weight ?? 0;
      const weightB = b.weight ?? 0;
      if (weightB !== weightA) {
        return weightB - weightA;
      }
      return b.averageSpeedKBps - a.averageSpeedKBps;
    });

    const selected = commonCandidates[0];
    this.io.to(roomId).emit('source:sync-result', {
      requestId,
      selected: {
        source: selected.source,
        id: selected.id,
        title: selected.title,
        weight: selected.weight,
      },
    });
  }

  setupEventHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`[WatchRoom] Client connected: ${socket.id}`);

      socket.on('room:create', (data, callback) => {
        try {
          const roomId = this.generateRoomId();
          const userId = socket.id;
          const ownerToken = this.generateRoomId();

          const room = {
            id: roomId,
            name: data.name,
            description: data.description,
            password: data.password,
            isPublic: data.isPublic,
            roomType: data.roomType || 'sync',
            ownerId: userId,
            ownerName: data.userName,
            ownerToken,
            memberCount: 1,
            currentState: null,
            createdAt: Date.now(),
            lastOwnerHeartbeat: Date.now(),
          };

          const member = {
            id: userId,
            name: data.userName,
            isOwner: true,
            lastHeartbeat: Date.now(),
          };

          this.rooms.set(roomId, room);
          this.members.set(roomId, new Map([[userId, member]]));
          this.socketToRoom.set(socket.id, {
            roomId,
            userId,
            userName: data.userName,
            isOwner: true,
          });

          socket.join(roomId);

          console.log(`[WatchRoom] Room created: ${roomId} by ${data.userName}`);
          callback({
            success: true,
            room: this.serializeRoom(room, { includeOwnerToken: true }),
          });
        } catch (error) {
          console.error('[WatchRoom] Error creating room:', error);
          callback({ success: false, error: '创建房间失败' });
        }
      });

      socket.on('room:join', (data, callback) => {
        try {
          const room = this.rooms.get(data.roomId);
          if (!room) {
            return callback({ success: false, error: '房间不存在' });
          }

          const userId = socket.id;
          let isOwner = false;

          if (data.ownerToken && data.ownerToken === room.ownerToken) {
            isOwner = true;
            room.ownerId = userId;
            room.lastOwnerHeartbeat = Date.now();
            this.rooms.set(data.roomId, room);
            console.log(`[WatchRoom] Owner ${data.userName} reconnected to room ${data.roomId}`);
          }

          if (!isOwner && room.password && room.password !== data.password) {
            return callback({ success: false, error: '密码错误' });
          }

          if (this.roomDeletionTimers.has(data.roomId)) {
            console.log(`[WatchRoom] Cancelling deletion timer for room ${data.roomId}`);
            clearTimeout(this.roomDeletionTimers.get(data.roomId));
            this.roomDeletionTimers.delete(data.roomId);
          }

          const member = {
            id: userId,
            name: data.userName,
            isOwner,
            lastHeartbeat: Date.now(),
          };

          const roomMembers = this.members.get(data.roomId);
          if (roomMembers) {
            if (isOwner) {
              Array.from(roomMembers.entries()).forEach(([memberId, existingMember]) => {
                if (existingMember.isOwner && memberId !== userId) {
                  roomMembers.delete(memberId);
                }
              });
            }

            roomMembers.set(userId, member);
            room.memberCount = roomMembers.size;
            this.rooms.set(data.roomId, room);
          }

          this.socketToRoom.set(socket.id, {
            roomId: data.roomId,
            userId,
            userName: data.userName,
            isOwner,
          });

          socket.join(data.roomId);
          socket.to(data.roomId).emit('room:member-joined', member);

          console.log(`[WatchRoom] User ${data.userName} joined room ${data.roomId}${isOwner ? ' (as owner)' : ''}`);

          const members = Array.from(roomMembers?.values() || []);
          callback({
            success: true,
            room: this.serializeRoom(room),
            members,
          });
        } catch (error) {
          console.error('[WatchRoom] Error joining room:', error);
          callback({ success: false, error: '加入房间失败' });
        }
      });

      socket.on('room:leave', () => {
        this.handleLeaveRoom(socket, { explicit: true });
      });

      socket.on('room:list', (callback) => {
        const publicRooms = Array.from(this.rooms.values())
          .filter((room) => room.isPublic)
          .map((room) => this.serializeRoom(room));
        callback(publicRooms);
      });

      socket.on('room:snapshot', (callback) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) {
          callback({ success: false, error: '未加入房间' });
          return;
        }

        const room = this.rooms.get(roomInfo.roomId);
        if (!room) {
          callback({ success: false, error: '房间不存在' });
          return;
        }

        const members = Array.from(this.members.get(roomInfo.roomId)?.values() || []);
        callback({
          success: true,
          room: this.serializeRoom(room),
          members,
          serverTime: Date.now(),
        });
      });

      socket.on('play:update', (state) => {
        console.log(`[WatchRoom] Received play:update from ${socket.id}:`, state);
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) {
          return;
        }

        const room = this.rooms.get(roomInfo.roomId);
        if (room && state?.type === 'play') {
          const timelineState = this.buildTimelineState(room.currentState, {
            ...state,
            type: 'play',
            currentTime: state.currentTime || 0,
            anchorMediaTime: state.currentTime || 0,
          });
          room.currentState = timelineState;
          this.rooms.set(roomInfo.roomId, room);
          this.io.to(roomInfo.roomId).emit('play:update', timelineState);
          this.io.to(roomInfo.roomId).emit('play:timeline', timelineState);
        }
      });

      socket.on('play:seek', (currentTime) => {
        console.log(`[WatchRoom] Received play:seek from ${socket.id}:`, currentTime);
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) {
          return;
        }

        const room = this.rooms.get(roomInfo.roomId);
        if (!room || room.currentState?.type !== 'play') {
          return;
        }

        const nextTime = Number(currentTime) || 0;
        const timelineState = this.buildTimelineState(
          room.currentState,
          {
            currentTime: nextTime,
            anchorMediaTime: nextTime,
            isPlaying: room.currentState.isPlaying,
          },
          {
            scheduleStart: room.currentState.isPlaying,
            delayMs: 900,
          }
        );

        room.currentState = timelineState;
        this.rooms.set(roomInfo.roomId, room);
        this.io.to(roomInfo.roomId).emit('play:seek', nextTime);
        this.io.to(roomInfo.roomId).emit('play:timeline', timelineState);
      });

      socket.on('play:play', () => {
        console.log(`[WatchRoom] Received play:play from ${socket.id}`);
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) {
          return;
        }

        const room = this.rooms.get(roomInfo.roomId);
        if (!room || room.currentState?.type !== 'play') {
          return;
        }

        const resolvedTime = this.getResolvedPlayPosition(room.currentState);
        const timelineState = this.buildTimelineState(
          room.currentState,
          {
            isPlaying: true,
            currentTime: resolvedTime,
            anchorMediaTime: resolvedTime,
          },
          {
            scheduleStart: true,
            delayMs: 1200,
          }
        );

        room.currentState = timelineState;
        this.rooms.set(roomInfo.roomId, room);
        this.io.to(roomInfo.roomId).emit('play:play');
        this.io.to(roomInfo.roomId).emit('play:timeline', timelineState);
      });

      socket.on('play:pause', () => {
        console.log(`[WatchRoom] Received play:pause from ${socket.id}`);
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) {
          return;
        }

        const room = this.rooms.get(roomInfo.roomId);
        if (!room || room.currentState?.type !== 'play') {
          return;
        }

        const resolvedTime = this.getResolvedPlayPosition(room.currentState);
        const timelineState = this.buildTimelineState(room.currentState, {
          isPlaying: false,
          currentTime: resolvedTime,
          anchorMediaTime: resolvedTime,
        });

        room.currentState = timelineState;
        this.rooms.set(roomInfo.roomId, room);
        this.io.to(roomInfo.roomId).emit('play:pause');
        this.io.to(roomInfo.roomId).emit('play:timeline', timelineState);
      });

      socket.on('play:change', (state) => {
        console.log(`[WatchRoom] Received play:change from ${socket.id}:`, state);
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) {
          return;
        }

        const room = this.rooms.get(roomInfo.roomId);
        if (room) {
          const timelineState = this.buildTimelineState(
            room.currentState?.type === 'play' ? room.currentState : null,
            {
              ...state,
              type: 'play',
              currentTime: state.currentTime || 0,
              anchorMediaTime: state.currentTime || 0,
            },
            {
              scheduleStart: state.isPlaying !== false,
              delayMs: 1800,
            }
          );
          room.currentState = timelineState;
          this.rooms.set(roomInfo.roomId, room);
          this.io.to(roomInfo.roomId).emit('play:change', timelineState);
          this.io.to(roomInfo.roomId).emit('play:timeline', timelineState);
        }
      });

      socket.on('live:change', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (room) {
          room.currentState = state;
          this.rooms.set(roomInfo.roomId, room);
          socket.to(roomInfo.roomId).emit('live:change', state);
        }
      });

      socket.on('screen:helper-register', (data, callback) => {
        try {
          const room = this.rooms.get(data.roomId);
          if (!room) {
            callback({ success: false, error: '房间不存在' });
            return;
          }

          if (room.ownerToken !== data.ownerToken) {
            callback({ success: false, error: '房主身份验证失败' });
            return;
          }

          const oldHelperSocketId = this.screenHelpers.get(data.roomId);
          if (oldHelperSocketId && oldHelperSocketId !== socket.id) {
            this.helperToRoom.delete(oldHelperSocketId);
          }

          this.screenHelpers.set(data.roomId, socket.id);
          this.helperToRoom.set(socket.id, data.roomId);
          callback({ success: true });
        } catch (error) {
          console.error('[WatchRoom] Error registering screen helper:', error);
          callback({ success: false, error: '注册共享控制窗口失败' });
        }
      });

      socket.on('screen:start', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        const helperRoomId = this.helperToRoom.get(socket.id);
        const roomId = roomInfo?.roomId || helperRoomId;
        if (!roomId) return;
        if (helperRoomId && this.screenHelpers.get(helperRoomId) !== socket.id) return;
        if (roomInfo && !roomInfo.isOwner) return;

        const room = this.rooms.get(roomId);
        if (room) {
          room.currentState = state;
          this.rooms.set(roomId, room);
          this.io.to(roomId).emit('screen:start', state);
        }
      });

      socket.on('screen:stop', () => {
        const roomInfo = this.socketToRoom.get(socket.id);
        const helperRoomId = this.helperToRoom.get(socket.id);
        const roomId = roomInfo?.roomId || helperRoomId;
        if (!roomId) return;
        if (helperRoomId && this.screenHelpers.get(helperRoomId) !== socket.id) return;
        if (roomInfo && !roomInfo.isOwner) return;

        const room = this.rooms.get(roomId);
        if (room) {
          room.currentState = null;
          this.rooms.set(roomId, room);
          this.io.to(roomId).emit('screen:stop');
        }
      });

      socket.on('screen:viewer-ready', () => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (!room || roomInfo.isOwner || room.currentState?.type !== 'screen') return;

        const targetSocketId = this.screenHelpers.get(roomInfo.roomId) || room.ownerId;
        this.io.to(targetSocketId).emit('screen:viewer-ready', {
          userId: socket.id,
        });
      });

      socket.on('screen:offer', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        const helperRoomId = this.helperToRoom.get(socket.id);
        if (!roomInfo && !helperRoomId) return;

        this.io.to(data.targetUserId).emit('screen:offer', {
          userId: socket.id,
          offer: data.offer,
        });
      });

      socket.on('screen:answer', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        const helperRoomId = this.helperToRoom.get(socket.id);
        if (!roomInfo && !helperRoomId) return;

        this.io.to(data.targetUserId).emit('screen:answer', {
          userId: socket.id,
          answer: data.answer,
        });
      });

      socket.on('screen:ice', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        const helperRoomId = this.helperToRoom.get(socket.id);
        if (!roomInfo && !helperRoomId) return;

        this.io.to(data.targetUserId).emit('screen:ice', {
          userId: socket.id,
          candidate: data.candidate,
        });
      });

      socket.on('chat:message', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;

        const message = {
          id: this.generateMessageId(),
          userId: roomInfo.userId,
          userName: roomInfo.userName,
          content: data.content,
          type: data.type,
          timestamp: Date.now(),
        };

        this.io.to(roomInfo.roomId).emit('chat:message', message);
      });

      socket.on('member:report', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;

        const roomMembers = this.members.get(roomInfo.roomId);
        const member = roomMembers?.get(roomInfo.userId);
        if (!member) return;

        member.lastHeartbeat = Date.now();
        member.lastClientReportAt = Date.now();
        member.lastKnownMediaTime = data.currentTime;
        member.isVisible = data.visible;
        member.syncStatus = data.syncStatus;
        member.needsGesture = data.needsGesture === true;
        member.currentSource = data.currentSource;
        member.currentSourceName = data.currentSourceName;
        member.currentVideoId = data.currentVideoId;
        member.currentVideoName = data.currentVideoName;
        roomMembers.set(roomInfo.userId, member);
        this.io.to(roomInfo.roomId).emit('room:member-updated', member);
      });

      socket.on('source:sync-request', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) return;

        const room = this.rooms.get(roomInfo.roomId);
        const roomMembers = this.members.get(roomInfo.roomId);
        const expectedUserIds = new Set([roomInfo.userId]);

        Array.from(roomMembers?.values() || []).forEach((member) => {
          if (member.isOwner) {
            return;
          }

          const isFresh =
            typeof member.lastClientReportAt === 'number'
              ? Date.now() - member.lastClientReportAt <= MEMBER_REPORT_STALE_MS
              : false;
          const isWatchingSameVideo = member.currentVideoId === data.videoId;

          if (isFresh && isWatchingSameVideo) {
            expectedUserIds.add(member.id);
          }
        });

        const key = `${roomInfo.roomId}:${data.requestId}`;

        if (this.sourceSyncSessions.has(key)) {
          const existing = this.sourceSyncSessions.get(key);
          clearTimeout(existing.timeoutId);
          this.sourceSyncSessions.delete(key);
        }

        const timeoutId = setTimeout(() => {
          this.resolveSourceSyncSession(roomInfo.roomId, data.requestId);
        }, 12000);

        this.sourceSyncSessions.set(key, {
          roomId: roomInfo.roomId,
          requestId: data.requestId,
          videoId: data.videoId,
          expectedUserIds,
          reports: new Map(),
          timeoutId,
          resolved: false,
        });

        if (room && room.currentState?.type === 'play' && room.currentState.videoId === data.videoId) {
          this.io.to(roomInfo.userId).emit('source:sync-request', data);
        }
        Array.from(roomMembers?.values() || []).forEach((member) => {
          if (member.id !== roomInfo.userId && expectedUserIds.has(member.id)) {
            this.io.to(member.id).emit('source:sync-request', data);
          }
        });
      });

      socket.on('source:sync-report', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;

        const key = `${roomInfo.roomId}:${data.requestId}`;
        const session = this.sourceSyncSessions.get(key);
        if (!session || session.resolved) return;
        if (session.videoId !== data.videoId) return;
        if (!session.expectedUserIds.has(socket.id)) return;

        session.reports.set(socket.id, {
          userId: socket.id,
          results: data.results,
        });

        if (session.reports.size >= session.expectedUserIds.size) {
          this.resolveSourceSyncSession(roomInfo.roomId, data.requestId);
        }
      });

      socket.on('voice:offer', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;
        this.io.to(data.targetUserId).emit('voice:offer', {
          userId: socket.id,
          offer: data.offer,
        });
      });

      socket.on('voice:answer', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;
        this.io.to(data.targetUserId).emit('voice:answer', {
          userId: socket.id,
          answer: data.answer,
        });
      });

      socket.on('voice:ice', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;
        this.io.to(data.targetUserId).emit('voice:ice', {
          userId: socket.id,
          candidate: data.candidate,
        });
      });

      socket.on('voice:audio-chunk', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;

        socket.to(roomInfo.roomId).emit('voice:audio-chunk', {
          userId: socket.id,
          audioData: data.audioData,
          sampleRate: data.sampleRate || 16000,
        });
      });

      socket.on('heartbeat', () => {
        const roomInfo = this.socketToRoom.get(socket.id);

        if (roomInfo) {
          const roomMembers = this.members.get(roomInfo.roomId);
          const member = roomMembers?.get(roomInfo.userId);
          if (member) {
            member.lastHeartbeat = Date.now();
            roomMembers?.set(roomInfo.userId, member);
          }

          if (roomInfo.isOwner) {
            const room = this.rooms.get(roomInfo.roomId);
            if (room) {
              room.lastOwnerHeartbeat = Date.now();
              this.rooms.set(roomInfo.roomId, room);
            }
          }
        }

        socket.emit('heartbeat:pong', { timestamp: Date.now() });
      });

      socket.on('disconnect', () => {
        console.log(`[WatchRoom] Client disconnected: ${socket.id}`);
        const helperRoomId = this.helperToRoom.get(socket.id);
        if (helperRoomId) {
          this.helperToRoom.delete(socket.id);
          if (this.screenHelpers.get(helperRoomId) === socket.id) {
            this.screenHelpers.delete(helperRoomId);
            const room = this.rooms.get(helperRoomId);
            if (room && room.currentState?.type === 'screen') {
              room.currentState = null;
              this.rooms.set(helperRoomId, room);
              this.io.to(helperRoomId).emit('screen:stop');
            }
          }
        }
        this.handleLeaveRoom(socket, { explicit: false });
      });
    });
  }

  handleLeaveRoom(socket, options = { explicit: false }) {
    const roomInfo = this.socketToRoom.get(socket.id);
    if (!roomInfo) return;

    const { roomId, userId, isOwner } = roomInfo;
    const room = this.rooms.get(roomId);
    const roomMembers = this.members.get(roomId);

    if (roomMembers) {
      roomMembers.delete(userId);

      if (room) {
        room.memberCount = roomMembers.size;
        this.rooms.set(roomId, room);
      }

      socket.to(roomId).emit('room:member-left', userId);

      if (isOwner && options.explicit) {
        console.log(`[WatchRoom] Owner actively left room ${roomId}, disbanding room`);

        socket.to(roomId).emit('room:deleted', { reason: 'owner_left' });

        const members = Array.from(roomMembers.keys());
        members.forEach((memberId) => {
          this.socketToRoom.delete(memberId);
        });

        this.deleteRoom(roomId, true);

        if (this.roomDeletionTimers.has(roomId)) {
          clearTimeout(this.roomDeletionTimers.get(roomId));
          this.roomDeletionTimers.delete(roomId);
        }
      } else {
        if (isOwner) {
          console.log(`[WatchRoom] Owner disconnected from room ${roomId}, keeping room for reconnection`);
          if (room) {
            room.lastOwnerHeartbeat = Date.now();
            this.rooms.set(roomId, room);
          }
        }

        if (roomMembers.size === 0) {
          console.log(`[WatchRoom] Room ${roomId} is now empty, will delete in ${EMPTY_ROOM_DELETE_DELAY_MS / 1000} seconds if no one rejoins`);

          const deletionTimer = setTimeout(() => {
            const currentRoomMembers = this.members.get(roomId);
            if (currentRoomMembers && currentRoomMembers.size === 0) {
              console.log(`[WatchRoom] Room ${roomId} deletion timer expired, deleting room`);
              this.deleteRoom(roomId);
              this.roomDeletionTimers.delete(roomId);
            }
          }, EMPTY_ROOM_DELETE_DELAY_MS);

          this.roomDeletionTimers.set(roomId, deletionTimer);
        }
      }
    }

    socket.leave(roomId);
    this.socketToRoom.delete(socket.id);
  }

  deleteRoom(roomId, skipNotify = false) {
    console.log(`[WatchRoom] Deleting room ${roomId}`);

    if (!skipNotify) {
      this.io.to(roomId).emit('room:deleted');
    }

    this.rooms.delete(roomId);
    this.members.delete(roomId);
    Array.from(this.sourceSyncSessions.keys()).forEach((key) => {
      if (key.startsWith(`${roomId}:`)) {
        const session = this.sourceSyncSessions.get(key);
        if (session) {
          clearTimeout(session.timeoutId);
        }
        this.sourceSyncSessions.delete(key);
      }
    });
    const helperSocketId = this.screenHelpers.get(roomId);
    if (helperSocketId) {
      this.helperToRoom.delete(helperSocketId);
      this.screenHelpers.delete(roomId);
    }
  }

  startCleanupTimer() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();

      for (const [roomId, room] of this.rooms.entries()) {
        const timeSinceHeartbeat = now - room.lastOwnerHeartbeat;

        if (timeSinceHeartbeat > OWNER_STATE_CLEAR_TIMEOUT_MS && room.currentState !== null) {
          console.log(`[WatchRoom] Room ${roomId} owner inactive for ${OWNER_STATE_CLEAR_TIMEOUT_MS / 1000}s, clearing play state`);
          room.currentState = null;
          this.rooms.set(roomId, room);
          this.io.to(roomId).emit('state:cleared');
        }

        if (timeSinceHeartbeat > OWNER_ROOM_DELETE_TIMEOUT_MS) {
          console.log(`[WatchRoom] Room ${roomId} owner timeout, deleting...`);
          this.deleteRoom(roomId);
        }
      }
    }, 10000);
  }

  generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  generateMessageId() {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    for (const timer of this.roomDeletionTimers.values()) {
      clearTimeout(timer);
    }
    this.roomDeletionTimers.clear();
  }
}

module.exports = {
  WatchRoomServer,
};
