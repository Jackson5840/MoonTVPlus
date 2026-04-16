// Next.js 自定义服务器 + Socket.IO
const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { Server } = require('socket.io');
const { WatchRoomServer } = require('./server/watch-room-server');
const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = parseInt(process.env.PORT || '3009', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// 读取观影室配置的辅助函数
async function getWatchRoomConfig() {
  // 观影室配置现在统一从环境变量读取
  const config = {
    enabled: process.env.WATCH_ROOM_ENABLED === 'true',
    serverType: (process.env.WATCH_ROOM_SERVER_TYPE || 'internal'),
    externalServerUrl: process.env.WATCH_ROOM_EXTERNAL_SERVER_URL,
    externalServerAuth: process.env.WATCH_ROOM_EXTERNAL_SERVER_AUTH,
  };

  console.log(`[WatchRoom] Watch room ${config.enabled ? 'enabled' : 'disabled'} via environment variable.`);
  return config;
}

app.prepare().then(async () => {
  const httpServer = createServer(async (req, res) => {
    try {
      const originalSetHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) => {
        if (typeof name === 'string' && name.toLowerCase() === 'x-powered-by') {
          return res;
        }
        return originalSetHeader(name, value);
      };
      res.removeHeader('X-Powered-By');
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });

  // 读取观影室配置
  const watchRoomConfig = await getWatchRoomConfig();
  console.log('[WatchRoom] Config:', watchRoomConfig);

  let watchRoomServer = null;

  // 只在启用观影室且使用内部服务器时初始化 Socket.IO
  if (watchRoomConfig.enabled && watchRoomConfig.serverType === 'internal') {
    console.log('[WatchRoom] Initializing Socket.IO server...');

    // 初始化 Socket.IO
    const io = new Server(httpServer, {
      path: '/socket.io',
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    // 初始化观影室服务器
    watchRoomServer = new WatchRoomServer(io);
    console.log('[WatchRoom] Socket.IO server initialized');
  } else {
    if (!watchRoomConfig.enabled) {
      console.log('[WatchRoom] Watch room is disabled');
    } else if (watchRoomConfig.serverType === 'external') {
      console.log('[WatchRoom] Using external watch room server');
    }
  }

  httpServer
    .once('error', (err) => {
      console.error(err);
      process.exit(1);
    })
    .listen(port, () => {
      console.log(`> Ready on http://${hostname}:${port}`);
      if (watchRoomConfig.enabled && watchRoomConfig.serverType === 'internal') {
        console.log(`> Socket.IO ready on ws://${hostname}:${port}`);
      }
    });

  // 优雅关闭
  process.on('SIGINT', () => {
    console.log('\n[Server] Shutting down...');
    if (watchRoomServer) {
      watchRoomServer.destroy();
    }
    httpServer.close(() => {
      console.log('[Server] Server closed');
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    console.log('\n[Server] Shutting down...');
    if (watchRoomServer) {
      watchRoomServer.destroy();
    }
    httpServer.close(() => {
      console.log('[Server] Server closed');
      process.exit(0);
    });
  });
});
