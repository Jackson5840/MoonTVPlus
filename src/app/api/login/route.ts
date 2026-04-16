/* eslint-disable no-console,@typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';

import {
  getAuthCookieOptions,
  getExpiredAuthCookieOptions,
  parseAuthInfo,
  toClientAuthInfo,
} from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import {
  checkLoginRateLimit,
  clearLoginRateLimit,
  recordFailedLoginAttempt,
} from '@/lib/login-rate-limit';
import {
  generateRefreshToken,
  generateTokenId,
  storeRefreshToken,
  TOKEN_CONFIG,
} from '@/lib/refresh-token';

export const runtime = 'nodejs';

// 读取存储类型环境变量，默认 localstorage
const STORAGE_TYPE =
  (process.env.NEXT_PUBLIC_STORAGE_TYPE as
    | 'localstorage'
    | 'redis'
    | 'upstash'
    | 'kvrocks'
    | undefined) || 'localstorage';

function buildLoginResponse(authToken?: string | null) {
  const body: Record<string, unknown> = { ok: true };

  if (authToken) {
    const authInfo = parseAuthInfo(authToken);
    if (authInfo) {
      body.auth = toClientAuthInfo(authInfo);
    }
  }

  return NextResponse.json(body);
}

function setAuthCookie(
  response: NextResponse,
  request: NextRequest,
  cookieValue: string,
  persistent: boolean,
  expires?: Date
) {
  response.cookies.set(
    'auth',
    cookieValue,
    getAuthCookieOptions(request, { persistent, expires })
  );
}

function buildTooManyAttemptsResponse(retryAfterSeconds: number, message?: string) {
  const statusCode = retryAfterSeconds > 0 ? 429 : 403;
  const headers: Record<string, string> = {};

  if (statusCode === 429) {
    headers['Retry-After'] = String(retryAfterSeconds);
  }

  return NextResponse.json(
    { error: message || '登录尝试过于频繁，请稍后再试' },
    {
      status: statusCode,
      headers,
    }
  );
}

// 生成签名
async function generateSignature(
  data: string,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(data);

  // 导入密钥
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // 生成签名
  const signature = await crypto.subtle.sign('HMAC', key, messageData);

  // 转换为十六进制字符串
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// 生成认证Cookie（带签名和 Refresh Token）
async function generateAuthCookie(
  username?: string,
  password?: string,
  role?: 'owner' | 'admin' | 'user',
  includePassword = false,
  deviceInfo?: string,
  persistent = true
): Promise<string> {
  const now = Date.now();
  const authData: any = { role: role || 'user', persistent };

  // 只在需要时包含 password
  if (includePassword && password) {
    authData.password = password;
  }

  if (username && process.env.PASSWORD) {
    authData.username = username;
    authData.timestamp = now; // Access Token 时间戳

    // 生成 Refresh Token（仅数据库模式）
    if (!includePassword && STORAGE_TYPE !== 'localstorage') {
      const tokenId = generateTokenId();
      const refreshToken = generateRefreshToken();
      const refreshExpires = now + TOKEN_CONFIG.REFRESH_TOKEN_AGE;

      authData.tokenId = tokenId;
      authData.refreshToken = refreshToken;
      authData.refreshExpires = refreshExpires;

      // 存储到 Redis Hash
      try {
        await storeRefreshToken(username, tokenId, {
          token: refreshToken,
          deviceInfo: deviceInfo || 'Unknown Device',
          createdAt: now,
          expiresAt: refreshExpires,
          lastUsed: now,
        });
      } catch (error) {
        console.error('Failed to store refresh token:', error);
      }
    }

    // 签名所有关键字段（username, role, timestamp）防止篡改
    const dataToSign = JSON.stringify({
      username: authData.username,
      role: authData.role,
      timestamp: authData.timestamp
    });
    const signature = await generateSignature(dataToSign, process.env.PASSWORD);
    authData.signature = signature;
  }

  return encodeURIComponent(JSON.stringify(authData));
}

// 验证Cloudflare Turnstile Token
async function verifyTurnstileToken(token: string, secretKey: string): Promise<boolean> {
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        secret: secretKey,
        response: token,
      }),
    });

    const data = await response.json();
    return data.success === true;
  } catch (error) {
    console.error('Turnstile验证失败:', error);
    return false;
  }
}

// 获取设备信息
function getDeviceInfo(request: NextRequest): string {
  const userAgent = request.headers.get('user-agent') || 'Unknown';

  // 检查是否为 MoonTVPlus APP
  if (userAgent.toLowerCase().includes('moontvplus')) {
    return 'MoonTVPlus APP';
  }

  // 检查是否为 OrionTV
  if (userAgent.toLowerCase().includes('oriontv')) {
    return 'OrionTV';
  }

  // 简单解析 User-Agent
  let browser = 'Unknown Browser';
  let os = 'Unknown OS';

  if (userAgent.includes('Chrome')) browser = 'Chrome';
  else if (userAgent.includes('Firefox')) browser = 'Firefox';
  else if (userAgent.includes('Safari')) browser = 'Safari';
  else if (userAgent.includes('Edge')) browser = 'Edge';

  if (userAgent.includes('Windows')) os = 'Windows';
  else if (userAgent.includes('Mac')) os = 'macOS';
  else if (userAgent.includes('Linux')) os = 'Linux';
  else if (userAgent.includes('Android')) os = 'Android';
  else if (userAgent.includes('iOS')) os = 'iOS';

  return `${browser} on ${os}`;
}

export async function POST(req: NextRequest) {
  try {
    // 获取站点配置
    const adminConfig = await getConfig();
    const siteConfig = adminConfig.SiteConfig;
    const requestBody = (await req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;

    if (!requestBody || typeof requestBody !== 'object') {
      return NextResponse.json({ error: '请求格式无效' }, { status: 400 });
    }

    const username =
      typeof requestBody.username === 'string' ? requestBody.username : undefined;
    const password =
      typeof requestBody.password === 'string' ? requestBody.password : undefined;
    const turnstileToken =
      typeof requestBody.turnstileToken === 'string'
        ? requestBody.turnstileToken
        : undefined;
    const rememberLogin = requestBody.rememberLogin === true;
    const persistent = rememberLogin;

    // 本地 / localStorage 模式——仅校验固定密码
    if (STORAGE_TYPE === 'localstorage') {
      const envPassword = process.env.PASSWORD;

      // 未配置 PASSWORD 时直接放行
      if (!envPassword) {
        const response = buildLoginResponse();

        // 清除可能存在的认证cookie
        response.cookies.set('auth', '', getExpiredAuthCookieOptions(req));

        return response;
      }

      if (typeof password !== 'string') {
        return NextResponse.json({ error: '密码不能为空' }, { status: 400 });
      }

      const rateLimitStatus = await checkLoginRateLimit(req);
      if (!rateLimitStatus.allowed) {
        return buildTooManyAttemptsResponse(
          rateLimitStatus.retryAfterSeconds,
          rateLimitStatus.message
        );
      }

      if (password !== envPassword) {
        const failureResult = await recordFailedLoginAttempt(req);
        if (!failureResult.allowed) {
          return buildTooManyAttemptsResponse(
            failureResult.retryAfterSeconds,
            failureResult.message
          );
        }

        return NextResponse.json(
          { ok: false, error: '密码错误' },
          { status: 401 }
        );
      }

      // 验证成功，设置认证cookie
      const username = process.env.USERNAME || 'default';
      const deviceInfo = getDeviceInfo(req);
      const cookieValue = await generateAuthCookie(
        username,
        password,
        'owner',
        false,
        deviceInfo,
        persistent
      ); // localstorage 模式改为签名认证，不再将 password 写入 cookie
      const response = buildLoginResponse(cookieValue);
      const expires = persistent
        ? new Date(Date.now() + TOKEN_CONFIG.REFRESH_TOKEN_AGE)
        : undefined;

      setAuthCookie(response, req, cookieValue, persistent, expires);
      await clearLoginRateLimit(req);

      return response;
    }

    // 数据库 / redis 模式——校验用户名并尝试连接数据库
    if (!username || typeof username !== 'string') {
      return NextResponse.json({ error: '用户名不能为空' }, { status: 400 });
    }
    if (!password || typeof password !== 'string') {
      return NextResponse.json({ error: '密码不能为空' }, { status: 400 });
    }

    const rateLimitStatus = await checkLoginRateLimit(req, username);
    if (!rateLimitStatus.allowed) {
      return buildTooManyAttemptsResponse(
        rateLimitStatus.retryAfterSeconds,
        rateLimitStatus.message
      );
    }

    // 如果开启了Turnstile验证
    if (siteConfig.LoginRequireTurnstile) {
      if (!turnstileToken) {
        return NextResponse.json(
          { error: '请完成人机验证' },
          { status: 400 }
        );
      }

      if (!siteConfig.TurnstileSecretKey) {
        console.error('Turnstile Secret Key未配置');
        return NextResponse.json(
          { error: '服务器配置错误' },
          { status: 500 }
        );
      }

      // 验证Turnstile Token
      const isValid = await verifyTurnstileToken(turnstileToken, siteConfig.TurnstileSecretKey);
      if (!isValid) {
        return NextResponse.json(
          { error: '人机验证失败，请重试' },
          { status: 400 }
        );
      }
    }

    // 可能是站长，直接读环境变量
    if (
      username === process.env.USERNAME &&
      password === process.env.PASSWORD
    ) {
      // 验证成功，设置认证cookie
      const deviceInfo = getDeviceInfo(req);
      const cookieValue = await generateAuthCookie(
        username,
        password,
        'owner',
        false,
        deviceInfo,
        persistent
      ); // 数据库模式不包含 password
      const response = buildLoginResponse(cookieValue);
      const expires = persistent
        ? new Date(Date.now() + TOKEN_CONFIG.REFRESH_TOKEN_AGE)
        : undefined;

      setAuthCookie(response, req, cookieValue, persistent, expires);
      await clearLoginRateLimit(req, username);

      return response;
    } else if (username === process.env.USERNAME) {
      const failureResult = await recordFailedLoginAttempt(req, username);
      if (!failureResult.allowed) {
        return buildTooManyAttemptsResponse(
          failureResult.retryAfterSeconds,
          failureResult.message
        );
      }

      return NextResponse.json({ error: '用户名或密码错误' }, { status: 401 });
    }

    // 使用新版本的用户验证
    let pass = false;
    let userRole: 'owner' | 'admin' | 'user' = 'user';
    let isBanned = false;

    // 验证用户
    try {
      const userInfoV2 = await db.getUserInfoV2(username);

      if (userInfoV2) {
        // 使用新版本验证
        pass = await db.verifyUserV2(username, password);
        userRole = userInfoV2.role;
        isBanned = userInfoV2.banned;
      }
    } catch (error) {
      console.error('登录接口存储层异常', error);
      return NextResponse.json(
        { error: '登录服务暂时不可用' },
        { status: 503 }
      );
    }

    // 检查用户是否被封禁
    if (isBanned) {
      const failureResult = await recordFailedLoginAttempt(req, username);
      if (!failureResult.allowed) {
        return buildTooManyAttemptsResponse(
          failureResult.retryAfterSeconds,
          failureResult.message
        );
      }

      return NextResponse.json({ error: '用户被封禁' }, { status: 401 });
    }

    if (!pass) {
      const failureResult = await recordFailedLoginAttempt(req, username);
      if (!failureResult.allowed) {
        return buildTooManyAttemptsResponse(
          failureResult.retryAfterSeconds,
          failureResult.message
        );
      }

      return NextResponse.json(
        { error: '用户名或密码错误' },
        { status: 401 }
      );
    }

    // 验证成功，设置认证cookie
    const deviceInfo = getDeviceInfo(req);
    const cookieValue = await generateAuthCookie(
      username,
      password,
      userRole,
      false,
      deviceInfo,
      persistent
    ); // 数据库模式不包含 password
    const response = buildLoginResponse(cookieValue);
    const expires = persistent
      ? new Date(Date.now() + TOKEN_CONFIG.REFRESH_TOKEN_AGE)
      : undefined;

    setAuthCookie(response, req, cookieValue, persistent, expires);
    await clearLoginRateLimit(req, username);

    console.log(`Cookie已设置`);

    return response;
  } catch (error) {
    console.error('登录接口异常', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
