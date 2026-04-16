import { NextRequest, NextResponse } from 'next/server';

import {
  getAuthInfoFromCookie,
  toClientAuthInfo,
  verifyAuthSignature,
} from '@/lib/auth';
import { verifyRefreshToken } from '@/lib/refresh-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STORAGE_TYPE =
  (process.env.NEXT_PUBLIC_STORAGE_TYPE as
    | 'localstorage'
    | 'redis'
    | 'upstash'
    | 'kvrocks'
    | undefined) || 'localstorage';

function unauthenticatedResponse(status = 200) {
  return NextResponse.json(
    { authenticated: false, auth: null },
    { status }
  );
}

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);

  if (!authInfo || !process.env.PASSWORD) {
    return unauthenticatedResponse();
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
        process.env.PASSWORD
      );

    if (!hasLegacyPassword && !hasSignedSession) {
      return unauthenticatedResponse(401);
    }

    const normalizedAuthInfo = {
      ...authInfo,
      username: authInfo.username || process.env.USERNAME || 'default',
      role: authInfo.role || 'owner',
    };

    return NextResponse.json({
      authenticated: true,
      auth: toClientAuthInfo(normalizedAuthInfo),
    });
  }

  if (
    !authInfo.username ||
    !authInfo.role ||
    !authInfo.timestamp ||
    !authInfo.signature ||
    !authInfo.tokenId ||
    !authInfo.refreshToken ||
    !authInfo.refreshExpires
  ) {
    return unauthenticatedResponse(401);
  }

  if (Date.now() >= authInfo.refreshExpires) {
    return unauthenticatedResponse(401);
  }

  const isValidSignature = await verifyAuthSignature(
    authInfo.username,
    authInfo.role,
    authInfo.timestamp,
    authInfo.signature,
    process.env.PASSWORD
  );

  if (!isValidSignature) {
    return unauthenticatedResponse(401);
  }

  const isValidRefreshToken = await verifyRefreshToken(
    authInfo.username,
    authInfo.tokenId,
    authInfo.refreshToken
  );

  if (!isValidRefreshToken) {
    return unauthenticatedResponse(401);
  }

  return NextResponse.json({
    authenticated: true,
    auth: toClientAuthInfo(authInfo),
  });
}
