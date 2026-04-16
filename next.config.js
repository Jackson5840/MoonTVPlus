/** @type {import('next').NextConfig} */
/* eslint-disable @typescript-eslint/no-var-requires */

// 检测是否为 Cloudflare Pages 构建
const isCloudflare = process.env.CF_PAGES === '1' || process.env.BUILD_TARGET === 'cloudflare';
const isProduction = process.env.NODE_ENV === 'production';

const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  'https://challenges.cloudflare.com',
];

if (!isProduction) {
  scriptSrc.push("'unsafe-eval'");
}

const appConnectSrc = [
  "'self'",
  'https:',
  'wss:',
];

if (!isProduction) {
  appConnectSrc.push('http:', 'ws:');
}

const appContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  `script-src ${scriptSrc.join(' ')}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: http: https:",
  "media-src 'self' data: blob: http: https:",
  `connect-src ${appConnectSrc.join(' ')}`,
  "font-src 'self' data: https://fonts.gstatic.com",
  "frame-src https://challenges.cloudflare.com",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
].join('; ');

const publicPageContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "connect-src 'self' https://challenges.cloudflare.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "frame-src https://challenges.cloudflare.com",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
].join('; ');

const baseSecurityHeaders = [
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
];

if (isProduction) {
  baseSecurityHeaders.push({
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains; preload',
  });
}

const nextConfig = {
  // Cloudflare Pages 不支持 standalone，使用默认输出
  output: isCloudflare ? undefined : 'standalone',
  poweredByHeader: false,
  eslint: {
    dirs: ['src'],
    // 在生产构建时忽略 ESLint 错误
    ignoreDuringBuilds: true,
  },

  reactStrictMode: false,
  swcMinify: true,

  experimental: {
    instrumentationHook: process.env.NODE_ENV === 'production' && !isCloudflare,
  },

  // Uncoment to add domain whitelist
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },

  async headers() {
    return [
      {
        source: '/((?!login$|register$|warning$).*)',
        headers: [
          ...baseSecurityHeaders,
          {
            key: 'Content-Security-Policy',
            value: appContentSecurityPolicy,
          },
        ],
      },
      {
        source: '/login',
        headers: [
          ...baseSecurityHeaders,
          {
            key: 'Content-Security-Policy',
            value: publicPageContentSecurityPolicy,
          },
        ],
      },
      {
        source: '/register',
        headers: [
          ...baseSecurityHeaders,
          {
            key: 'Content-Security-Policy',
            value: publicPageContentSecurityPolicy,
          },
        ],
      },
      {
        source: '/warning',
        headers: [
          ...baseSecurityHeaders,
          {
            key: 'Content-Security-Policy',
            value: publicPageContentSecurityPolicy,
          },
        ],
      },
    ];
  },

  webpack(config, { isServer }) {
    // Grab the existing rule that handles SVG imports
    const fileLoaderRule = config.module.rules.find((rule) =>
      rule.test?.test?.('.svg')
    );

    config.module.rules.push(
      // Reapply the existing rule, but only for svg imports ending in ?url
      {
        ...fileLoaderRule,
        test: /\.svg$/i,
        resourceQuery: /url/, // *.svg?url
      },
      // Convert all other *.svg imports to React components
      {
        test: /\.svg$/i,
        issuer: { not: /\.(css|scss|sass)$/ },
        resourceQuery: { not: /url/ }, // exclude if *.svg?url
        loader: '@svgr/webpack',
        options: {
          dimensions: false,
          titleProp: true,
        },
      }
    );

    // Modify the file loader rule to ignore *.svg, since we have it handled now.
    fileLoaderRule.exclude = /\.svg$/i;

    config.resolve.fallback = {
      ...config.resolve.fallback,
      net: false,
      tls: false,
      crypto: false,
    };

    // Exclude better-sqlite3, D1, and Postgres modules from client-side bundle
    if (!isServer) {
      config.externals = config.externals || [];
      config.externals.push({
        'better-sqlite3': 'commonjs better-sqlite3',
        '@vercel/postgres': 'commonjs @vercel/postgres',
        'pg': 'commonjs pg',
      });

      config.resolve.alias = {
        ...config.resolve.alias,
        'better-sqlite3': false,
        '@/lib/d1.db': false,
        '@/lib/d1-adapter': false,
        '@/lib/postgres.db': false,
        '@/lib/postgres-adapter': false,
      };
    }

    return config;
  },
};

const withPWA = require('next-pwa')({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  register: true,
  skipWaiting: true,
});

module.exports = withPWA(nextConfig);
