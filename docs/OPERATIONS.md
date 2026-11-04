# 运行与第三方接入

## 服务运行

本机开发服务使用 tmux 会话 `snapoto-web`，地址 http://localhost:4310。项目开发终端会话为 `snapoto`。没有创建远程仓库、提交或公开部署。

线上部署需要持久化磁盘、HTTPS 反向代理和正确的 `PUBLIC_URL`。客户端提供的 Origin 必须与 PUBLIC_URL 一致。默认只监听 127.0.0.1。请不要把开发 HTTP 服务直接当作公网生产服务。

备份必须一起保存 `data/snapoto.db`、原图目录、`data/key`、`data/verification-private.pem`。在线 SQLite 备份应使用 SQLite backup API 或停服务后整体复制，不能只复制处于写入中的单个 DB 文件。丢失加密密钥将无法恢复连接器凭据。原图删除不能靠数据库回滚恢复。

当前工作队列适用于单进程；不要同时启动多个处理同一数据目录的服务实例。扩容前需要独立队列和分布式认领机制。

## AI

配置 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`，要求兼容 Chat Completions、图像输入及 JSON 输出。语音使用 `AI_AUDIO_MODEL`（默认 whisper-1）及音频转写接口。未配置会返回明确的 503，不产生虚构结果。

`AI_DAILY_LIMIT` 控制每个空间每日请求额度，默认 1000；`MAX_SPACE_STORAGE_BYTES` 默认 10 GiB。失败的已预留 AI 请求也计入额度，以免重试无限消耗。消息日限额由规则控制。

## OAuth

Google 与 Microsoft OAuth 应用的回调地址均设置为：

```
PUBLIC_URL/api/oauth/callback
```

服务器配置对应的 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` 或 `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`。然后由空间管理员在 Settings → Connect a tool 授权。

Google Sheets 表格默认 `Customers!A:D`，第一行表头。列顺序为订单号、客户名、邮箱、国际格式手机号。匹配必须唯一且精确；不会让 LLM 猜联系方式。

默认 scope：Gmail 发送、Sheets 只读、Drive 仅应用创建文件、Microsoft 邮件发送、OneDrive 应用文件夹。**邮件草稿需要额外的 Gmail compose 或 Microsoft Mail.ReadWrite scope**；连接时勾选“Allow email drafts”后重新授权。Sheets 的可选 `writeback_column`（例如 E）会请求可写权限，并在匹配行的该列回写发送结果。尚未配置的 scope 导致的错误会进入待核对，不会改用其他账号发送。

手动令牌模式供开发联调；令牌过期需重新连接。OAuth 模式自动尝试刷新，失败时标记 expired。应用中 Disconnect 会撤销本应用对凭据的访问；如需撤销供应商账户侧授权，请在供应商账号的安全设置中移除应用。

## SMS

Twilio 使用空间独立的 Account SID、Auth Token、发件号码。启用前管理员必须确认接收人已有适用的短信同意。手机号使用 E.164 格式。

入站回调：

```
PUBLIC_URL/api/sms/CONNECTOR_ID/inbound
```

接口验证 `X-Twilio-Signature`。STOP 等退订指令进入空间退订名单，后续发送被阻止。运营商注册、真实客户同意记录及上线合规审查由企业完成；代码不是法律合规认证。

供应商接受请求后显示 sent，网络结果不确定显示 unknown。尚未接入运营商送达回执；界面不能将 sent 解读为送达或签收。

## Webhook / 开发者

设置 `WEBHOOK_ALLOWED_HOSTS` 为明确授权的 HTTPS 目标主机名。管理界面创建 webhook 后仅显示一次签名密钥。重试采用指数退避，接收方必须按事件 ID 去重。不要把指向内部管理服务的主机加入允许列表。

REST / MCP 的 API Key 为只读、空间隔离、90 天过期，所有请求需要 HMAC 签名和一次性 nonce。完整协议见 API.md。

## 保留与可恢复性

每小时清理超过空间保留期限的原始和渲染资产，保留验证历史并明确标记原图不可复核。分享可单独撤销和过期。浏览器预览不等于禁止截图或复制；“禁用下载”只控制原图下载端点。

Android 卸载会删除应用私有文件。现场使用前应开启并确认云同步。浏览器 IndexedDB 不等同于 Android 私有文件持久性，因此现场主端仍为 Android。

## 邮箱访问验证码

创建分享时可选择 Require recipient email verification，指定接收邮箱和本空间已授权的邮件连接器。验证码通过该连接器发出，因此需要有效的发送权限。连接断开时不能发送新代码，已验证会话仍受其 30 分钟有效期和分享撤销控制。测试脚本 `tests/browser-otp.mjs` 使用临时数据库和模拟 Gmail 响应，不发送真实邮件。
