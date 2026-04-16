/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import {
  getAuthCookieOptions,
  getAuthInfoFromCookie,
  isPersistentAuthSession,
  parseAuthInfo,
  toClientAuthInfo,
  verifyAuthSignature,
} from '@/lib/auth';
import { refreshAccessToken } from '@/lib/middleware-auth';
import { TOKEN_CONFIG } from '@/lib/refresh-token';

export const runtime = 'nodejs';

const STORAGE_TYPE =
  (process.env.NEXT_PUBLIC_STORAGE_TYPE as
    | 'localstorage'
    | 'redis'
    | 'upstash'
    | 'kvrocks'
    | undefined) || 'localstorage';

function buildRefreshResponse(authToken?: string | null) {
  const body: Record<string, unknown> = { ok: true };

  if (authToken) {
    const authInfo = parseAuthInfo(authToken);
    if (authInfo) {
      body.auth = toClientAuthInfo(authInfo);
    }
  }

  return NextResponse.json(body);
}

export async function POST(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);

  if (!authInfo) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (STORAGE_TYPE === 'localstorage') {
    const hasLegacyPassword =
      !!authInfo.password && authInfo.password === process.env.PASSWORD;
    const hasSignedSession =
      !!authInfo.username &&
      !!authInfo.role &&
      !!authInfo.signature &&
      !!authInfo.timestamp &&
      await verifyAuthSignature(
        authInfo.username,
        authInfo.role,
        authInfo.timestamp,
        authInfo.signature,
        process.env.PASSWORD || ''
      );

    if (!hasLegacyPassword && !hasSignedSession) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const authCookie = request.cookies.get('auth');
    if (!authCookie?.value) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let authCookieValue = authCookie.value;
    if (hasLegacyPassword) {
      const { password: _password, ...sanitizedAuthInfo } = authInfo;
      authCookieValue = encodeURIComponent(JSON.stringify(sanitizedAuthInfo));
    }

    const response = buildRefreshResponse(authCookieValue);
    const persistent = isPersistentAuthSession(authInfo);
    const expires = persistent
      ? new Date(Date.now() + TOKEN_CONFIG.REFRESH_TOKEN_AGE)
      : undefined;
    response.cookies.set(
      'auth',
      authCookieValue,
      getAuthCookieOptions(request, { persistent, expires })
    );
    return response;
  }

  if (
    !authInfo.username ||
    !authInfo.role ||
    !authInfo.timestamp ||
    !authInfo.tokenId ||
    !authInfo.refreshToken ||
    !authInfo.refreshExpires
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = Date.now();

  // 只检查 Refresh Token 是否过期
  if (now >= authInfo.refreshExpires) {
    return NextResponse.json(
      { error: 'Refresh token expired' },
      { status: 401 }
    );
  }

  // 只要 Refresh Token 有效，就允许刷新（即使 Access Token 已过期）

  const newAuthData = await refreshAccessToken(
    authInfo.username,
    authInfo.role,
    authInfo.tokenId,
    authInfo.refreshToken,
    authInfo.refreshExpires
  );

  if (!newAuthData) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const response = buildRefreshResponse(newAuthData);
  const persistent = isPersistentAuthSession(authInfo);
  const expires = persistent ? new Date(authInfo.refreshExpires) : undefined;
  response.cookies.set(
    'auth',
    newAuthData,
    getAuthCookieOptions(request, { persistent, expires })
  );
  return response;
}
