# Snapoto

基于 `docs/Snapoto_PRD_V2.0.docx` 的现场相机与照片后处理应用。包含原生 Android、团队管理网页、客户验证页和 Node.js API。

## 本地运行

要求 Node.js 22.18+。项目没有 Python 依赖。

```bash
npm ci
npm start
```

打开 http://localhost:4310，创建账号；在 Settings 中授权该空间上传原图，然后拍照或上传。创建团队后邀请成员，Personal 与 Team 使用不同的数据空间。

可选配置使用 `.env.example` 中的变量。将配置保存到本机 `.env` 后：

```bash
node --env-file=.env server/index.mjs
```

不配置第三方服务，也可运行账号、照片、水印、验证、分享、确认和导出。AI 功能会明确报告未配置；连接器不会假装发送成功。

## Android

```bash
cd android
./gradlew :app:assembleDebug :app:lintDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`。本机 SDK 路径只放在被忽略的 `android/local.properties`。

首次打开默认 Camera。账号未登录时照片只保存在设备，不会因为随后登录自动转入团队。Me 中登录后选择空间，并单独授权后台上传；团队管理员也必须在网页开启云存储。

- 原图先写入应用私有目录并执行 fsync，再持久化元数据。
- WorkManager 在网络恢复后重试；使用 512 KB 分片、已保存偏移和最终 SHA-256 校验。
- 水印生成单独文件，团队锁定字段不能通过本地设置关闭。
- 前后摄模式为同一次操作中的**先后拍摄**，记录真实时间差，不声称同步曝光或身份核验。
- 视频无音轨，最长 30 秒、20 MB；语音说明单独录制，最长 60 秒。
- Release 版本要求 HTTPS；Debug 允许本地 HTTP。

模拟器只能通过 `heavy start emu` 启动，并在使用完后 `heavy stop emu`。当前不应强行停止其他会话的 ComfyUI。

## 架构

- `server/index.mjs`：账号、RBAC、照片、模板、规则、分享和报表 API。
- `server/store.mjs`：SQLite WAL 持久化；加密连接器凭据；审计记录。
- `server/assets.mjs` / `uploads.mjs`：原图持久化、断点续传、幂等完成。
- `server/render.mjs`：画面内水印、Logo、二维码和可选自拍画中画。
- `server/signing.mjs`：Ed25519 验证清单，公开验证密钥。
- `server/engine.mjs`：确定性处理队列、唯一客户匹配、外发配额与去重。
- `server/ai.mjs`：结构化规则编译、OCR、语音转写、搜索与摘要。
- `server/oauth.mjs`：Google / Microsoft 授权码流程、PKCE、令牌刷新。
- `server/extensions.mjs`：签名 REST、只读 MCP、Webhook、Drive / OneDrive 归档。
- `web/`：无需前端构建的响应式管理界面与客户页。
- `android/`：CameraX 原生相机与 WorkManager 同步。

数据默认在 `data/`，不进入 Git。部署采用单个 Node 服务进程和本地持久化磁盘；没有接入云对象存储、多实例队列或支付系统。

## 自动处理与外发

规则支持明确的“已验证照片 → 提取订单号 → Sheets 唯一匹配 → 邮件/SMS 验证链接”流程。没有 AI 配置时，仅提供受限的固定流程草案，界面明确标注。OCR 提取的关键号码必须经人确认。自然语言不会变成可执行代码，也不会扩展为任意 Agent 权限。

启用前必须完成 dry-run 并配置连接器。连接器访问令牌和刷新令牌仅加密保存在服务器端。用户选择的模板快照和规则版本随运行保存。

供应商接收发送请求后，网络可能在响应返回前断开。此时记录 `unknown` 并进入人工核对，**不自动重发**，避免重复消息。发送成功不等于实际送达，实际送达也不等于客户签收。

## 验证

```bash
npm run check
npm test
# 需要已安装 Playwright Chromium；可指定现有浏览器二进制。
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome node tests/browser.mjs
```

浏览器测试要求本地服务正在运行，会创建独立的 QA 账号和人工合成测试照片，不向真实收件人发送消息。服务端测试使用隔离临时数据库，外发请求使用模拟响应。

当前验收状态与未验证环节详见 `docs/ACCEPTANCE.md`。部署与凭据配置见 `docs/OPERATIONS.md`，开发者签名协议见 `docs/API.md`。
