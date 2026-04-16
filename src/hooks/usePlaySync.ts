// React Hook for Play Page Synchronization
'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useWatchRoomContextSafe } from '@/components/WatchRoomProvider';

import type { MemberSyncStatus, PlayState } from '@/types/watch-room';

interface UsePlaySyncOptions {
  artPlayerRef: React.MutableRefObject<any>;
  videoId: string;
  videoName: string;
  videoYear?: string;
  searchTitle?: string;
  currentEpisode?: number;
  currentSource: string;
  currentSourceName?: string;
  videoUrl: string;
  playerReady: boolean;
}

const DEFAULT_DRIFT_TOLERANCE_MS = 300;
const DEFAULT_HARD_SEEK_THRESHOLD_MS = 1000;
const PERIODIC_SYNC_INTERVAL_MS = 3000;
const SNAPSHOT_RESYNC_INTERVAL_MS = 10000;
const DESKTOP_SOFT_CORRECTION_THRESHOLD_MS = 800;
const PLAYBACK_RATE_CORRECTION_DURATION_MS = 1800;
const SNAPSHOT_DENOISE_WINDOW_MS = 4000;
const AUTO_CORRECTION_STORAGE_KEY = 'watch_room_auto_correction_enabled';
const DRIFT_TOLERANCE_STORAGE_KEY = 'watch_room_drift_tolerance_ms';

type SyncProfile = 'ipad_safari' | 'desktop_enhanced' | 'generic';

function detectSyncProfile(): SyncProfile {
  if (typeof navigator === 'undefined') {
    return 'generic';
  }

  const ua = navigator.userAgent;
  const isIPad =
    /iPad/i.test(ua) ||
    (navigator.platform === 'MacIntel' && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1);
  const isSafari =
    /Safari/i.test(ua) &&
    !/Chrome|CriOS|Edg|OPR|Firefox/i.test(ua);
  const isDesktop =
    !/iPhone|iPad|Android|Mobile/i.test(ua);
  const isDesktopChromeOrEdge =
    isDesktop && /Chrome|Edg/i.test(ua) && !/OPR/i.test(ua);

  if (isIPad && isSafari) {
    return 'ipad_safari';
  }

  if (isDesktopChromeOrEdge) {
    return 'desktop_enhanced';
  }

  return 'generic';
}

export function usePlaySync({
  artPlayerRef,
  videoId,
  videoName,
  videoYear,
  searchTitle,
  currentEpisode,
  currentSource,
  currentSourceName,
  videoUrl,
  playerReady,
}: UsePlaySyncOptions) {
  const router = useRouter();
  const watchRoom = useWatchRoomContextSafe();
  const lastSyncTimeRef = useRef(0);
  const isHandlingRemoteCommandRef = useRef(false);
  const scheduledSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestTimelineRef = useRef<PlayState | null>(null);
  const playbackRateResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncJobIdRef = useRef(0);
  const desiredPlaybackStateRef = useRef<'play' | 'pause'>('pause');
  const lastRealtimeTimelineAtRef = useRef(0);
  const lastBroadcastRef = useRef<{
    videoId: string;
    source: string;
    episode: number;
  } | null>(null);
  const lastRoomStateRef = useRef<{ isOwner: boolean; roomId: string | null }>({
    isOwner: false,
    roomId: null,
  });

  const [syncStatus, setSyncStatus] = useState<MemberSyncStatus>('idle');
  const [syncMessage, setSyncMessage] = useState('未加入观影室');
  const [driftMs, setDriftMs] = useState<number | null>(null);
  const [needsManualSync, setNeedsManualSync] = useState(false);
  const [syncProfile] = useState<SyncProfile>(() => detectSyncProfile());
  const [ownerAutoCorrectionEnabled, setOwnerAutoCorrectionEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return localStorage.getItem(AUTO_CORRECTION_STORAGE_KEY) !== 'false';
  });
  const [ownerDriftToleranceMs, setOwnerDriftToleranceMs] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_DRIFT_TOLERANCE_MS;
    const saved = Number(localStorage.getItem(DRIFT_TOLERANCE_STORAGE_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_DRIFT_TOLERANCE_MS;
  });

  const isInRoom = !!(watchRoom && watchRoom.currentRoom);
  const isOwner = watchRoom?.isOwner || false;
  const currentRoom = watchRoom?.currentRoom;
  const socket = watchRoom?.socket;
  const ownerAutoCorrectionEnabledRef = useRef(ownerAutoCorrectionEnabled);
  const ownerDriftToleranceMsRef = useRef(ownerDriftToleranceMs);

  const clearScheduledSync = useCallback(() => {
    if (scheduledSyncTimerRef.current) {
      clearTimeout(scheduledSyncTimerRef.current);
      scheduledSyncTimerRef.current = null;
    }
  }, []);

  const resetPlaybackRate = useCallback(() => {
    if (playbackRateResetTimerRef.current) {
      clearTimeout(playbackRateResetTimerRef.current);
      playbackRateResetTimerRef.current = null;
    }

    const player = artPlayerRef.current;
    if (player && typeof player.playbackRate === 'number') {
      player.playbackRate = 1;
    }
  }, [artPlayerRef]);

  const beginNewSyncJob = useCallback((desiredState: 'play' | 'pause') => {
    syncJobIdRef.current += 1;
    desiredPlaybackStateRef.current = desiredState;
    clearScheduledSync();
    resetPlaybackRate();
    return syncJobIdRef.current;
  }, [clearScheduledSync, resetPlaybackRate]);

  const isSyncJobActive = useCallback((jobId: number) => {
    return syncJobIdRef.current === jobId;
  }, []);

  const updateSyncState = useCallback(
    (nextStatus: MemberSyncStatus, message: string, nextDriftMs?: number | null) => {
      setSyncStatus(nextStatus);
      setSyncMessage(message);
      if (nextDriftMs !== undefined) {
        setDriftMs(nextDriftMs);
      }
    },
    []
  );

  const calculateTargetMediaTime = useCallback((state: PlayState, now = Date.now()) => {
    const anchorMediaTime =
      typeof state.anchorMediaTime === 'number'
        ? state.anchorMediaTime
        : state.currentTime || 0;
    const anchorServerTime =
      typeof state.anchorServerTime === 'number'
        ? state.anchorServerTime
        : now;

    if (!state.isPlaying) {
      return anchorMediaTime;
    }

    const effectiveNow =
      state.targetStartAt && now < state.targetStartAt ? state.targetStartAt : now;

    return anchorMediaTime + Math.max(0, effectiveNow - anchorServerTime) / 1000;
  }, []);

  const buildLocalPlayState = useCallback((): PlayState | null => {
    const player = artPlayerRef.current;
    if (!player || !videoId || !videoUrl) {
      return null;
    }

    const currentTime = player.currentTime || 0;

    return {
      type: 'play',
      url: videoUrl,
      currentTime,
      anchorMediaTime: currentTime,
      anchorServerTime: Date.now(),
      isPlaying: player.playing || false,
      videoId,
      videoName,
      videoYear,
      searchTitle,
      episode: currentEpisode,
      source: currentSource,
      autoCorrectionEnabled: ownerAutoCorrectionEnabledRef.current,
      driftToleranceMs: ownerDriftToleranceMsRef.current,
    };
  }, [
    artPlayerRef,
    currentEpisode,
    currentSource,
    searchTitle,
    videoId,
    videoName,
    videoUrl,
    videoYear,
  ]);

  useEffect(() => {
    ownerAutoCorrectionEnabledRef.current = ownerAutoCorrectionEnabled;
  }, [ownerAutoCorrectionEnabled]);

  useEffect(() => {
    ownerDriftToleranceMsRef.current = ownerDriftToleranceMs;
  }, [ownerDriftToleranceMs]);

  const broadcastPlayState = useCallback(
    (force = false) => {
      if (!socket || !watchRoom || !isInRoom || !isOwner) return;

      const state = buildLocalPlayState();
      if (!state) return;

      const now = Date.now();
      if (!force && now - lastSyncTimeRef.current < 800) return;
      lastSyncTimeRef.current = now;

      watchRoom.updatePlayState(state);
    },
    [buildLocalPlayState, isInRoom, isOwner, socket, watchRoom]
  );

  const forceBroadcastCurrentState = useCallback(() => {
    if (!watchRoom || !isInRoom || !isOwner) {
      return;
    }

    const state = buildLocalPlayState();
    if (!state) {
      return;
    }

    watchRoom.changeVideo(state);
    watchRoom.updatePlayState(state);
  }, [buildLocalPlayState, isInRoom, isOwner, watchRoom]);

  const requestRoomSnapshot = useCallback(async (): Promise<PlayState | null> => {
    if (!socket || !isInRoom) {
      return null;
    }

    return new Promise((resolve) => {
      socket.emit('room:snapshot', (response) => {
        if (response.success && response.room?.currentState?.type === 'play') {
          resolve(response.room.currentState);
          return;
        }

        resolve(null);
      });
    });
  }, [isInRoom, socket]);

  const broadcastCurrentTimeToChat = useCallback(() => {
    if (!watchRoom || !isInRoom || !isOwner) return;

    const player = artPlayerRef.current;
    if (!player) return;

    const currentTime = Number(player.currentTime || 0);
    const hours = Math.floor(currentTime / 3600);
    const minutes = Math.floor((currentTime % 3600) / 60);
    const seconds = Math.floor(currentTime % 60);
    const formatted =
      hours > 0
        ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds
            .toString()
            .padStart(2, '0')}`
        : `${minutes}:${seconds.toString().padStart(2, '0')}`;

    watchRoom.sendChatMessage(`房主当前播放到 ${formatted}`, 'text');
  }, [artPlayerRef, isInRoom, isOwner, watchRoom]);

  const reportMemberState = useCallback(
    (statusOverride?: MemberSyncStatus) => {
      if (!socket || !isInRoom || isOwner || !playerReady) return;

      const player = artPlayerRef.current;
      if (!player) return;

      socket.emit('member:report', {
        currentTime: player.currentTime || 0,
        paused: !player.playing,
        visible: typeof document === 'undefined' ? true : document.visibilityState === 'visible',
        syncStatus: statusOverride || syncStatus,
        needsGesture: needsManualSync,
        currentSource,
        currentSourceName: currentSourceName || currentSource,
        currentVideoId: videoId,
        currentVideoName: videoName,
      });
    },
    [
      artPlayerRef,
      currentSource,
      currentSourceName,
      videoId,
      videoName,
      isInRoom,
      isOwner,
      needsManualSync,
      playerReady,
      socket,
      syncStatus,
    ]
  );

  const syncToTimeline = useCallback(
    async (state: PlayState, reason: 'timeline' | 'snapshot' | 'manual' | 'recover') => {
      if (
        reason === 'timeline' &&
        typeof state.revision === 'number'
      ) {
        const currentRevision = latestTimelineRef.current?.revision;
        if (
          typeof currentRevision === 'number' &&
          state.revision < currentRevision
        ) {
          return;
        }
        lastRealtimeTimelineAtRef.current = Date.now();
      }

      if (
        reason === 'snapshot' &&
        latestTimelineRef.current &&
        Date.now() - lastRealtimeTimelineAtRef.current < SNAPSHOT_DENOISE_WINDOW_MS
      ) {
        const incomingRevision = state.revision ?? 0;
        const currentRevision = latestTimelineRef.current.revision ?? 0;
        if (incomingRevision <= currentRevision) {
          return;
        }
      }

      latestTimelineRef.current = state;

      if (isOwner || !isInRoom) {
        return;
      }

      if (!playerReady || !artPlayerRef.current) {
        updateSyncState('syncing', '播放器准备中，等待同步...');
        return;
      }

      // 如果视频尚未切换到房主当前播放的视频，等待 play:change 导航完成
      if (state.videoId !== videoId || state.source !== currentSource) {
        updateSyncState('syncing', '等待切换到房主当前剧集...');
        return;
      }

      const player = artPlayerRef.current;
      const jobId = beginNewSyncJob(state.isPlaying ? 'play' : 'pause');

      const applySync = async (currentJobId: number) => {
        if (!isSyncJobActive(currentJobId)) return;

        const now = Date.now();
        const targetMediaTime = calculateTargetMediaTime(state, now);
        const diffMs = Math.round((targetMediaTime - (player.currentTime || 0)) * 1000);
        const driftToleranceMs = state.driftToleranceMs || DEFAULT_DRIFT_TOLERANCE_MS;
        const hardSeekThresholdMs = state.hardSeekThresholdMs || DEFAULT_HARD_SEEK_THRESHOLD_MS;
        const autoCorrectionEnabled =
          reason === 'manual' || reason === 'recover'
            ? true
            : state.autoCorrectionEnabled !== false;
        const shouldUseSoftCorrection =
          autoCorrectionEnabled &&
          syncProfile === 'desktop_enhanced' &&
          Math.abs(diffMs) > driftToleranceMs &&
          Math.abs(diffMs) <= Math.min(hardSeekThresholdMs, DESKTOP_SOFT_CORRECTION_THRESHOLD_MS) &&
          state.isPlaying;

        isHandlingRemoteCommandRef.current = true;
        setDriftMs(diffMs);

        try {
          if (!isSyncJobActive(currentJobId)) return;

          if (shouldUseSoftCorrection) {
            const nextPlaybackRate = diffMs > 0 ? 1.04 : 0.96;
            if (typeof player.playbackRate === 'number') {
              player.playbackRate = nextPlaybackRate;
              if (playbackRateResetTimerRef.current) {
                clearTimeout(playbackRateResetTimerRef.current);
              }
              playbackRateResetTimerRef.current = setTimeout(() => {
                player.playbackRate = 1;
                playbackRateResetTimerRef.current = null;
              }, PLAYBACK_RATE_CORRECTION_DURATION_MS);
            }
          } else if (autoCorrectionEnabled && Math.abs(diffMs) > driftToleranceMs) {
            resetPlaybackRate();
            player.currentTime = targetMediaTime;
          } else {
            resetPlaybackRate();
          }

          if (!isSyncJobActive(currentJobId)) return;

          if (state.isPlaying) {
            try {
              await player.play();
              if (
                !isSyncJobActive(currentJobId) ||
                desiredPlaybackStateRef.current === 'pause'
              ) {
                player.pause();
                return;
              }
              setNeedsManualSync(false);
              updateSyncState('in_sync', '已与房主同步', diffMs);
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              const expectedAbort =
                !isSyncJobActive(currentJobId) ||
                desiredPlaybackStateRef.current === 'pause' ||
                errorMessage.includes('interrupted by a call to pause') ||
                (error instanceof DOMException && error.name === 'AbortError');

              if (expectedAbort) {
                return;
              }

              console.warn('[PlaySync] Auto play blocked, waiting for gesture:', error);
              setNeedsManualSync(true);
              updateSyncState('waiting_gesture', '点击“重新同步”开始播放', diffMs);
              reportMemberState('waiting_gesture');
              return;
            }
          } else {
            player.pause();
            if (!isSyncJobActive(currentJobId)) return;
            setNeedsManualSync(false);
            updateSyncState(
              'paused_synced',
              autoCorrectionEnabled ? '已与房主暂停同步' : '房主已关闭自动校正（暂停状态已同步）',
              diffMs
            );
          }

          const resolvedStatus =
            !autoCorrectionEnabled && Math.abs(diffMs) > driftToleranceMs
              ? 'syncing'
              : Math.abs(diffMs) > hardSeekThresholdMs
                ? 'recovering'
                : state.isPlaying
                  ? 'in_sync'
                  : 'paused_synced';

          if (!autoCorrectionEnabled && Math.abs(diffMs) > driftToleranceMs && state.isPlaying) {
            updateSyncState('syncing', '房主已关闭自动校正，可手动重新同步', diffMs);
          } else if (state.isPlaying) {
            updateSyncState('in_sync', '已与房主同步', diffMs);
          }

          reportMemberState(resolvedStatus);
        } finally {
          if (isSyncJobActive(currentJobId)) {
            setTimeout(() => {
              if (isSyncJobActive(currentJobId)) {
                isHandlingRemoteCommandRef.current = false;
              }
            }, 400);
          }
        }
      };

      if (state.isPlaying && state.targetStartAt && state.targetStartAt > Date.now() + 150) {
        updateSyncState('syncing', reason === 'recover' ? '正在恢复并等待统一开播...' : '正在等待统一开播...');
        scheduledSyncTimerRef.current = setTimeout(() => {
          void applySync(jobId);
        }, Math.max(0, state.targetStartAt - Date.now()));
        return;
      }

      if (reason === 'recover') {
        updateSyncState('recovering', '正在恢复同步...');
      } else if (reason === 'manual') {
        updateSyncState('recovering', '正在重新同步...');
      } else {
        updateSyncState('syncing', '正在同步播放...');
      }

      await applySync(jobId);
    },
    [
      artPlayerRef,
      beginNewSyncJob,
      calculateTargetMediaTime,
      currentSource,
      isInRoom,
      isSyncJobActive,
      isOwner,
      playerReady,
      reportMemberState,
      resetPlaybackRate,
      syncProfile,
      updateSyncState,
      videoId,
    ]
  );

  const manualResync = useCallback(async () => {
    if (!isInRoom || isOwner) return;

    updateSyncState('recovering', '正在重新同步...');
    const snapshotState = await requestRoomSnapshot();
    const targetState =
      snapshotState ||
      (currentRoom?.currentState?.type === 'play' ? currentRoom.currentState : null) ||
      latestTimelineRef.current;

    if (!targetState) {
      updateSyncState('waiting_owner', '等待房主开始播放...');
      return;
    }

    await syncToTimeline(targetState, 'manual');
  }, [currentRoom?.currentState, isInRoom, isOwner, requestRoomSnapshot, syncToTimeline, updateSyncState]);

  useEffect(() => {
    if (!isInRoom) {
      clearScheduledSync();
      latestTimelineRef.current = null;
      setNeedsManualSync(false);
      setDriftMs(null);
      updateSyncState('idle', '未加入观影室', null);
      return;
    }

    if (isOwner) {
      setNeedsManualSync(false);
      if (currentRoom?.currentState?.type === 'play') {
        setOwnerAutoCorrectionEnabled(currentRoom.currentState.autoCorrectionEnabled !== false);
        setOwnerDriftToleranceMs(currentRoom.currentState.driftToleranceMs || DEFAULT_DRIFT_TOLERANCE_MS);
      }
      updateSyncState('in_sync', '您是房主，正在广播播放时间线', 0);
      return;
    }

    if (!currentRoom?.currentState || currentRoom.currentState.type !== 'play') {
      updateSyncState('waiting_owner', '等待房主开始播放...');
    }
  }, [clearScheduledSync, currentRoom?.currentState, isInRoom, isOwner, updateSyncState]);

  // 成员：如果因为浏览器策略需要手势，监听一次用户交互并自动重同步
  useEffect(() => {
    if (!needsManualSync || isOwner || !isInRoom) {
      return;
    }

    const handleUserGesture = () => {
      void manualResync();
    };

    window.addEventListener('pointerdown', handleUserGesture, {
      passive: true,
      once: true,
      capture: true,
    });
    window.addEventListener('keydown', handleUserGesture, {
      passive: true,
      once: true,
      capture: true,
    });

    return () => {
      window.removeEventListener('pointerdown', handleUserGesture, true);
      window.removeEventListener('keydown', handleUserGesture, true);
    };
  }, [isInRoom, isOwner, manualResync, needsManualSync]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(
      AUTO_CORRECTION_STORAGE_KEY,
      String(ownerAutoCorrectionEnabled)
    );
  }, [ownerAutoCorrectionEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(
      DRIFT_TOLERANCE_STORAGE_KEY,
      String(ownerDriftToleranceMs)
    );
  }, [ownerDriftToleranceMs]);

  const updateOwnerAutoCorrectionEnabled = useCallback((enabled: boolean) => {
    ownerAutoCorrectionEnabledRef.current = enabled;
    setOwnerAutoCorrectionEnabled(enabled);
    if (isOwner) {
      setTimeout(() => {
        forceBroadcastCurrentState();
      }, 0);
    }
  }, [forceBroadcastCurrentState, isOwner]);

  const updateOwnerDriftToleranceMs = useCallback((nextToleranceMs: number) => {
    ownerDriftToleranceMsRef.current = nextToleranceMs;
    setOwnerDriftToleranceMs(nextToleranceMs);
    if (isOwner) {
      setTimeout(() => {
        forceBroadcastCurrentState();
      }, 0);
    }
  }, [forceBroadcastCurrentState, isOwner]);

  // 成员：监听时间线事件并自动同步
  useEffect(() => {
    if (!socket || !currentRoom || !isInRoom) {
      return;
    }

    const handleTimeline = (state: PlayState) => {
      if (state.type !== 'play') return;
      void syncToTimeline(state, 'timeline');
    };

    const handleChangeCommand = (state: PlayState) => {
      if (isOwner || state.type !== 'play') {
        return;
      }

      const params = new URLSearchParams({
        id: state.videoId,
        source: state.source,
        episode: String(state.episode || 1),
      });

      if (state.videoName) params.set('title', state.videoName);
      if (state.videoYear) params.set('year', state.videoYear);
      if (state.searchTitle) params.set('stitle', state.searchTitle);

      router.push(`/play?${params.toString()}`);
    };

    const handleStateCleared = () => {
      clearScheduledSync();
      latestTimelineRef.current = null;
      setNeedsManualSync(false);
      setDriftMs(null);
      updateSyncState('waiting_owner', '等待房主开始播放...');
    };

    socket.on('play:timeline', handleTimeline);
    socket.on('play:change', handleChangeCommand);
    socket.on('state:cleared', handleStateCleared);

    return () => {
      socket.off('play:timeline', handleTimeline);
      socket.off('play:change', handleChangeCommand);
      socket.off('state:cleared', handleStateCleared);
    };
  }, [
    clearScheduledSync,
    currentRoom,
    isInRoom,
    isOwner,
    router,
    socket,
    syncToTimeline,
    updateSyncState,
  ]);

  // 成员：播放器准备好后主动拉一次快照
  useEffect(() => {
    if (!playerReady || !isInRoom || isOwner) {
      return;
    }

    const timer = setTimeout(async () => {
      const snapshotState = await requestRoomSnapshot();
      if (snapshotState) {
        await syncToTimeline(snapshotState, 'snapshot');
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [isInRoom, isOwner, playerReady, requestRoomSnapshot, syncToTimeline]);

  // 成员：前后台切换后自动恢复同步
  useEffect(() => {
    if (!isInRoom || isOwner) {
      return;
    }

    const handleVisibilityRecover = () => {
      if (document.visibilityState === 'hidden') {
        updateSyncState('background', '页面在后台，返回前台后将自动同步...');
        reportMemberState('background');
        return;
      }

      void (async () => {
        updateSyncState('recovering', '页面已恢复，正在重新同步...');
        const snapshotState = await requestRoomSnapshot();
        if (snapshotState) {
          await syncToTimeline(snapshotState, 'recover');
        }
      })();
    };

    const handlePageShow = () => {
      void manualResync();
    };

    const handleFocus = () => {
      void manualResync();
    };

    document.addEventListener('visibilitychange', handleVisibilityRecover);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityRecover);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('focus', handleFocus);
    };
  }, [
    isInRoom,
    isOwner,
    manualResync,
    reportMemberState,
    requestRoomSnapshot,
    syncToTimeline,
    updateSyncState,
  ]);

  // 成员：定期向服务端汇报同步状态
  useEffect(() => {
    if (!isInRoom || isOwner || !playerReady) {
      return;
    }

    const interval = setInterval(() => {
      reportMemberState();
    }, PERIODIC_SYNC_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isInRoom, isOwner, playerReady, reportMemberState]);

  // 成员：周期性拉一次房间快照，修正潜在漂移
  useEffect(() => {
    if (!isInRoom || isOwner || !playerReady) {
      return;
    }

    const interval = setInterval(async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }

      const snapshotState = await requestRoomSnapshot();
      if (snapshotState) {
        await syncToTimeline(snapshotState, 'snapshot');
      }
    }, SNAPSHOT_RESYNC_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isInRoom, isOwner, playerReady, requestRoomSnapshot, syncToTimeline]);

  // 房主：监听播放器事件并广播权威时间线
  useEffect(() => {
    if (!socket || !currentRoom || !isInRoom || !watchRoom || !playerReady) {
      return;
    }

    const player = artPlayerRef.current;
    if (!player) {
      return;
    }

    const handlePlay = () => {
      if (isHandlingRemoteCommandRef.current || !isOwner) return;
      watchRoom.play();
    };

    const handlePause = () => {
      if (isHandlingRemoteCommandRef.current || !isOwner) return;
      watchRoom.pause();
    };

    const handleSeeked = () => {
      if (isHandlingRemoteCommandRef.current || !isOwner) return;
      watchRoom.seekPlayback(player.currentTime);
    };

    player.on('play', handlePlay);
    player.on('pause', handlePause);
    player.on('seeked', handleSeeked);

    const syncInterval = setInterval(() => {
      if (!player.playing || !isOwner) return;
      broadcastPlayState();
    }, PERIODIC_SYNC_INTERVAL_MS);

    return () => {
      player.off('play', handlePlay);
      player.off('pause', handlePause);
      player.off('seeked', handleSeeked);
      clearInterval(syncInterval);
    };
  }, [
    artPlayerRef,
    broadcastPlayState,
    currentRoom,
    isInRoom,
    isOwner,
    playerReady,
    socket,
    watchRoom,
  ]);

  // 房主：监听视频/集数/源变化并广播切换命令
  useEffect(() => {
    if (!isOwner || !socket || !currentRoom || !isInRoom || !watchRoom) {
      lastBroadcastRef.current = null;
      return;
    }
    if (!videoId || !videoUrl) return;

    const currentState = {
      videoId,
      source: currentSource,
      episode: currentEpisode || 1,
    };

    const shouldBroadcast =
      !lastBroadcastRef.current ||
      lastBroadcastRef.current.videoId !== currentState.videoId ||
      lastBroadcastRef.current.source !== currentState.source ||
      lastBroadcastRef.current.episode !== currentState.episode;

    if (!shouldBroadcast) {
      return;
    }

    const timer = setTimeout(() => {
      const state = buildLocalPlayState();
      if (!state) return;

      watchRoom.changeVideo(state);
      lastBroadcastRef.current = currentState;
    }, 500);

    return () => clearTimeout(timer);
  }, [
    buildLocalPlayState,
    currentEpisode,
    currentRoom,
    currentSource,
    isInRoom,
    isOwner,
    socket,
    videoId,
    videoUrl,
    watchRoom,
  ]);

  // 房主：加入房间时立即广播当前播放状态
  useEffect(() => {
    const currentRoomId = currentRoom?.id || null;
    const prevRoomState = lastRoomStateRef.current;
    const justBecameOwner = !prevRoomState.isOwner && isOwner;
    const justJoinedRoom = !prevRoomState.roomId && currentRoomId;

    lastRoomStateRef.current = { isOwner, roomId: currentRoomId };

    if (!isOwner || !socket || !currentRoom || !isInRoom || !watchRoom) return;
    if (!videoId || !videoUrl) return;
    if (!justBecameOwner && !justJoinedRoom) return;

    const timer = setTimeout(() => {
      const state = buildLocalPlayState();
      if (!state) return;

      watchRoom.changeVideo(state);
      lastBroadcastRef.current = {
        videoId,
        source: currentSource,
        episode: currentEpisode || 1,
      };
    }, 300);

    return () => clearTimeout(timer);
  }, [
    buildLocalPlayState,
    currentEpisode,
    currentRoom,
    currentSource,
    isInRoom,
    isOwner,
    socket,
    videoId,
    videoUrl,
    watchRoom,
  ]);

  useEffect(() => {
    return () => {
      clearScheduledSync();
      resetPlaybackRate();
    };
  }, [clearScheduledSync, resetPlaybackRate]);

  return {
    isInRoom,
    isOwner,
    shouldDisableControls: isInRoom && !isOwner,
    broadcastPlayState,
    forceBroadcastCurrentState,
    syncStatus,
    syncMessage,
    driftMs,
    needsManualSync,
    manualResync,
    syncProfile,
    ownerAutoCorrectionEnabled,
    ownerDriftToleranceMs,
    setOwnerAutoCorrectionEnabled: updateOwnerAutoCorrectionEnabled,
    setOwnerDriftToleranceMs: updateOwnerDriftToleranceMs,
    broadcastCurrentTimeToChat,
  };
}
