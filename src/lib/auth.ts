import { NextRequest } from 'next/server';

import {
  clearClientAuthState,
  getClientAuthInfo,
} from './client-auth';

export type AuthInfo = {
  password?: string;
  username?: string;
  signature?: string;
  timestamp?: number;
  role?: 'owner' | 'admin' | 'user';
  tokenId?: string;
  refreshToken?: string;
  refreshExpires?: number;
  persistent?: boolean;
};

type CookieRequest = Pick<NextRequest, 'headers' | 'nextUrl'>;

export function shouldUseSecureCookies(request: CookieRequest): boolean {
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto) {
    return forwardedProto.split(',')[0].trim() === 'https';
  }

  return request.nextUrl.protocol === 'https:';
}

export function getAuthCookieOptions(
  request: CookieRequest,
  options: {
    persistent?: boolean;
    expires?: Date;
  } = {}
) {
  const cookieOptions = {
    path: '/',
    sameSite: 'lax' as const,
    httpOnly: true,
    secure: shouldUseSecureCookies(request),
  };

  if (options.persistent && options.expires) {
    return {
      ...cookieOptions,
      expires: options.expires,
    };
  }

  return cookieOptions;
}

export function getExpiredAuthCookieOptions(request: CookieRequest) {
  return {
    ...getAuthCookieOptions(request),
    expires: new Date(0),
  };
}

export function isPersistentAuthSession(
  authInfo: AuthInfo | null | undefined
): boolean {
  return authInfo?.persistent !== false;
}

export function toClientAuthInfo(authInfo: AuthInfo | null | undefined) {
  if (!authInfo?.username || !authInfo?.role) {
    return null;
  }

  return {
    username: authInfo.username,
    role: authInfo.role,
    timestamp: authInfo.timestamp,
    refreshExpires: authInfo.refreshExpires,
    persistent: authInfo.persistent,
  };
}

export async function verifyAuthSignature(
  username: string,
  role: string,
  timestamp: number,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const dataToSign = JSON.stringify({
    username,
    role,
    timestamp,
  });
  const messageData = encoder.encode(dataToSign);

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signatureBuffer = new Uint8Array(
      signature.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
    );

    return await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBuffer,
      messageData
    );
  } catch (error) {
    console.error('签名验证失败:', error);
    return false;
  }
}

function getAuthTokenFromHeader(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const bearerMatch = trimmed.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    return bearerMatch[1].trim();
  }

  const tokenMatch = trimmed.match(/^Token\s+(.+)$/i);
  if (tokenMatch) {
    return tokenMatch[1].trim();
  }

  return trimmed;
}

export function parseAuthInfo(value?: string | null): AuthInfo | null {
  if (!value) {
    return null;
  }

  let decoded = value;

  try {
    decoded = decodeURIComponent(decoded);
  } catch (error) {
    decoded = value;
  }

  if (decoded.includes('%')) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch (error) {
      decoded = value;
    }
  }

  try {
    return JSON.parse(decoded) as AuthInfo;
  } catch (error) {
    return null;
  }
}

// 从cookie获取认证信息 (服务端使用)
export function getAuthInfoFromCookie(request: NextRequest): AuthInfo | null {
  const authHeader = request.headers.get('authorization');
  if (authHeader) {
    const headerValue = getAuthTokenFromHeader(authHeader);
    const headerAuthInfo = parseAuthInfo(headerValue);
    if (headerAuthInfo) {
      return headerAuthInfo;
    }
  }

  const authCookie = request.cookies.get('auth');

  if (!authCookie) {
    return null;
  }

  return parseAuthInfo(authCookie.value);
}

// 从cookie获取认证信息 (客户端使用)
export function getAuthInfoFromBrowserCookie(): AuthInfo | null {
  return getClientAuthInfo() as AuthInfo | null;
}

// 清除浏览器中的认证cookie (客户端使用)
export function clearAuthCookie(): void {
  clearClientAuthState();
}
