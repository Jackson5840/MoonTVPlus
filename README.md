# Fork 说明

本仓库是基于上游项目二次开发的自用分支。

- 上游仓库：<https://github.com/mtvpls/MoonTVPlus>
- 上游 README：<https://github.com/mtvpls/MoonTVPlus/blob/main/README.md>

> 说明：  
> 本 README 不再重复维护上游那份完整部署文档、环境变量大全和原始功能说明。  
> **上游原始说明请直接看上面的 README 链接。**  
> 这里仅记录本 Fork 自己新增、改动和收口的部分。

---

## 项目来源

- 本项目基于 **[mtvpls/MoonTVPlus](https://github.com/mtvpls/MoonTVPlus)** 二次开发
- 上游 `MoonTVPlus` 本身又是基于更早的 MoonTV / LunaTV 方向继续演化

如果你要看：

- 原版功能介绍
- 原版部署方式
- 原版环境变量
- 原版弹幕 / OpenList / Emby / TVBox / Cloudflare 等说明

请直接查看上游 README：

- <https://github.com/mtvpls/MoonTVPlus/blob/main/README.md>

---

## 本 Fork 主要更新

下面这些内容是**当前这个仓库**相对上游重点做过的改动。

### 1. 部署方式调整

- `docker-compose.yml` 已改成可直接使用：

```bash
docker compose up -d --build
```

- 当前 compose 默认使用：
  - `kvrocks`
  - 内置观影室服务
  - `3009` 端口

---

### 2. 登录与认证安全加固

#### 已处理

- 修复登录/注册页 `redirect` 未校验问题
  - 只允许站内相对路径
  - 拒绝 `http://`、`https://`、`//`、`javascript:` 等跳转

- 删除“明文记住密码”
  - 不再往 `localStorage` 保存原始密码
  - 改成 **保持登录 60 天**

- 认证模型改成 **HttpOnly-only**
  - 前端不再直接读 `document.cookie`
  - 新增 `/api/me`
  - 前端登录态改由 `/api/me` 返回

- 收紧公开配置暴露
  - `/api/server-config` 只保留最小字段
  - 登录页不再公开版本号
  - 未登录状态下 `window.RUNTIME_CONFIG` 缩到最小

- 增加基础安全头
  - `Content-Security-Policy`
  - `Strict-Transport-Security`
  - `X-Frame-Options`
  - `X-Content-Type-Options`
  - `Referrer-Policy`
  - `Permissions-Policy`

- 移除 `X-Powered-By`

---

### 3. 登录限速 / 防爆破

已新增登录限速逻辑，支持环境变量配置：

- `LOGIN_RATE_LIMIT_WINDOW_MINUTES`
- `LOGIN_RATE_LIMIT_BLOCK_MINUTES`
- `LOGIN_RATE_LIMIT_MAX_FAILURES_PER_IP`
- `LOGIN_RATE_LIMIT_MAX_FAILURES_PER_IP_USERNAME`
- `LOGIN_RATE_LIMIT_PERMANENT_BAN_PER_IP`

当前这套 Fork 里，compose 默认已经收紧成更激进的规则：

- 同一 IP 10 分钟内失败 10 次
- 可配置为永久封禁登录接口

---

### 4. 观影室改造成“同步房优先”

这个 Fork 对观影室动得比较多，方向已经明确偏向：

- **同步观影**
- **iPad Safari 友好**
- **桌面端增强同步**

#### 已做内容

- 弱化 / 隐藏屏幕共享房入口
- 创建房间默认只走 **同步房**
- `/watch-room/screen` 直接回到 `/watch-room`

- 新增权威时间线同步模型
  - 服务端维护 `play:timeline`
  - 支持 `room:snapshot`
  - 成员周期上报 `member:report`

- 播放页新增同步状态条
  - 已同步 / 正在同步 / 等待手势 / 恢复中
  - 成员支持 **重新同步**
  - 房主可看成员源状态

- 新增房间刷新按钮
  - 手动刷新当前房间和成员列表

- 加强 iPad Safari 适配
  - 前后台切换后自动恢复同步
  - 自动播放失败时提示点击开始同步

- 加入桌面端增强同步模式
  - 桌面 Chrome / Edge 支持更平滑追帧

- 自动校正支持房主控制
  - 可开关自动校正
  - 可手动设置偏差阈值

---

### 5. 观影室同步稳定性修复

这个 Fork 额外修过一批同步层问题：

- 同步任务串行化
- 旧同步任务自动失效
- 暂停优先级高于播放
- `snapshot` 同步降噪

目的是减少：

- 成员端反复播放 / 暂停
- `play()` 被 `pause()` 打断
- Safari 自动播放抖动

---

### 6. 观影室安全与生命周期收口

#### 安全侧

- `room:list`
- `room:join`
- `room:snapshot`

现在都做了脱敏处理，不再把这些敏感字段直接发给普通客户端：

- 房间密码
- 房主重连令牌 `ownerToken`

房主令牌现在只在**创建房间时**返回一次，用于后续房主重连。

另外：

- 房间重连信息改成放 `sessionStorage`
- 不再持久化保存房间密码

#### 生命周期

房间生命周期也已经放宽，减少因为刷新/切后台导致的误删：

- 空房删除延长
- 房主离线后清空播放状态延长
- 房主超时删房延长

---

### 7. 同步源能力增强

播放页右上角已加入 **同步源** 能力，逻辑是：

- 房主发起同步源
- 成员各自测速
- 只从**所有参与成员都能访问**的源里选
- 再按：
  1. 优先级最高
  2. 平均速度最快

同时继续做了两层增强：

- 不再把没进播放页的成员也算进去，避免同步源卡死
- 不只看速度，还会校验：
  - 播放列表特征
  - 总时长是否一致

这样能尽量避免“同名源但实际时长不同”的问题。

---

### 8. 播放页换源 UI 改造

播放页右侧面板做过一轮重构：

- 顺序改成：
  - 集数
  - 换源
  - 弹幕

- 换源面板改成：
  - `路线1 / 路线2 / 路线3`
  - 一行 3 个
  - 不显示封面
  - 不显示测速失败的源
  - 只保留：
    - 分辨率
    - 速度（例如 `2.9MB/s`）

- 去掉单独“重新测试”
- 只保留“全部重测”

---

### 9. 普通用户权限收口

对普通用户做了额外限制：

- 隐藏 **生态应用**
- 设置页里，普通用户只开放：
  - **弹幕设置**

其他设置项不再对普通用户开放。

---

### 10. 弹幕默认预设调整

这个 Fork 把弹幕默认行为改成更保守：

- 自动加载弹幕：关闭
- 下集弹幕预加载：关闭
- 弹幕热力图：关闭

新用户首次进入时默认就是关闭状态。

---

### 11. 移动端交互修复

修过一轮移动端点击无响应问题，重点在：

- 长按逻辑不再吞普通点击
- 卡片图片 / 按钮点击恢复正常
- `useLongPress` 对按钮区域识别更准确

---

### 12. 观影室服务端实现统一

本 Fork 已把观影室服务逻辑统一成一份：

- `server/watch-room-server.js`

用途：

- `server.js` 内置观影室
- `server/watch-room-standalone-server.js` 独立观影室

这样后续不会再出现“改到一份没生效，另一份还在跑”的情况。

---

## 本 Fork 额外关注的环境变量

除了上游原本的变量外，这个 Fork 额外值得注意的有：

### 观影室

```env
WATCH_ROOM_ENABLED=true
WATCH_ROOM_SERVER_TYPE=internal
```

### 登录限速

```env
LOGIN_RATE_LIMIT_WINDOW_MINUTES=10
LOGIN_RATE_LIMIT_BLOCK_MINUTES=15
LOGIN_RATE_LIMIT_MAX_FAILURES_PER_IP=10
LOGIN_RATE_LIMIT_MAX_FAILURES_PER_IP_USERNAME=10
LOGIN_RATE_LIMIT_PERMANENT_BAN_PER_IP=true
```

---

## 当前推荐启动方式

### Docker Compose

```bash
docker compose up -d --build
```

当前仓库已经自带 `docker-compose.yml`。

---

## 上游文档入口

如果你需要完整查看：

- 原项目介绍
- 原始部署文档
- Cloudflare / Vercel / Netlify 说明
- 原始环境变量表
- 弹幕后端 / TVBox / Android TV / 外部服务部署

请直接看上游 README：

- <https://github.com/mtvpls/MoonTVPlus/blob/main/README.md>

上游仓库：

- <https://github.com/mtvpls/MoonTVPlus>
