type ClientAuthInfo = {
  username?: string;
  role?: 'owner' | 'admin' | 'user';
  timestamp?: number;
  refreshExpires?: number;
  persistent?: boolean;
};

type ClientAuthState = {
  authInfo: ClientAuthInfo | null;
  loading: boolean;
};

type AuthStore = {
  state: ClientAuthState;
  listeners: Set<() => void>;
};

const globalStoreKey = Symbol.for('__MOONTV_CLIENT_AUTH_STORE__');

type GlobalClientAuthStore = typeof globalThis & {
  [globalStoreKey]?: AuthStore;
};

const globalClientAuthStore = globalThis as GlobalClientAuthStore;

if (!globalClientAuthStore[globalStoreKey]) {
  globalClientAuthStore[globalStoreKey] = {
    state: {
      authInfo: null,
      loading: true,
    },
    listeners: new Set(),
  };
}

function getStore(): AuthStore {
  return globalClientAuthStore[globalStoreKey] as AuthStore;
}

function emitChange(): void {
  const store = getStore();
  store.listeners.forEach((listener) => listener());
}

export function subscribeClientAuth(listener: () => void): () => void {
  const store = getStore();
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

export function getClientAuthState(): ClientAuthState {
  return getStore().state;
}

export function getClientAuthInfo(): ClientAuthInfo | null {
  return getStore().state.authInfo;
}

export function setClientAuthState(nextState: ClientAuthState): void {
  const store = getStore();
  store.state = nextState;
  emitChange();
}

export function patchClientAuthState(
  partialState: Partial<ClientAuthState>
): void {
  const store = getStore();
  store.state = {
    ...store.state,
    ...partialState,
  };
  emitChange();
}

export function clearClientAuthState(): void {
  setClientAuthState({
    authInfo: null,
    loading: false,
  });
}

export type { ClientAuthInfo, ClientAuthState };
