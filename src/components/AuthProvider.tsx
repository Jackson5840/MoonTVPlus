'use client';

import { ReactNode, useEffect, useSyncExternalStore } from 'react';

import {
  clearClientAuthState,
  getClientAuthState,
  patchClientAuthState,
  setClientAuthState,
  subscribeClientAuth,
} from '@/lib/client-auth';

async function loadAuthState(): Promise<void> {
  patchClientAuthState({ loading: true });

  try {
    const response = await window.fetch('/api/me', {
      credentials: 'include',
      cache: 'no-store',
    });

    if (response.ok) {
      const data = await response.json().catch(() => null);
      setClientAuthState({
        authInfo: data?.authenticated ? (data.auth ?? null) : null,
        loading: false,
      });
      return;
    }

    if (response.status === 401 || response.status === 403) {
      clearClientAuthState();
      return;
    }
  } catch (error) {
    console.error('[AuthProvider] Failed to load auth state:', error);
  }

  patchClientAuthState({ loading: false });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    loadAuthState();
  }, []);

  return <>{children}</>;
}

export function useAuth() {
  const snapshot = useSyncExternalStore(
    subscribeClientAuth,
    getClientAuthState,
    getClientAuthState
  );

  return {
    authInfo: snapshot.authInfo,
    isAuthenticated: !!snapshot.authInfo,
    isLoading: snapshot.loading,
    refreshAuth: loadAuthState,
  };
}

export { loadAuthState as refreshClientAuth };
