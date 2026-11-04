# API 与签名协议

普通应用 API 使用 HTTP-only 会话 cookie 或 `Authorization: Bearer SESSION_TOKEN`。请求入口 `/api/spaces/:spaceId` 始终重新检查成员角色，不能依赖客户端选择的空间或角色。

## 主要资源

| 路径 | 功能 |
| --- | --- |
| POST /api/auth/register, /api/auth/login | 注册、登录 |
| GET /api/me | 账号与可访问空间 |
| POST /api/spaces | 创建团队 |
| POST /api/spaces/:s/invites | 创建一次性邀请 |
| POST /api/invites/accept | 接受邀请 |
| GET, POST /api/spaces/:s/captures | 查询、幂等上传 |
| POST /api/spaces/:s/uploads | 创建或恢复分片上传 |
| GET /api/spaces/:s/uploads/:u | 查询偏移 |
| PUT /api/spaces/:s/uploads/:u/:part | 追加分片，X-Offset 指定偏移 |
| POST /api/spaces/:s/uploads/:u/complete | 校验所有资产并完成拍摄记录 |
| POST /api/spaces/:s/captures/:c/render | 生成独立水印资产 |
| POST /api/spaces/:s/captures/:c/extract | OCR 候选，不自动确认 |
| POST /api/spaces/:s/captures/:c/transcribe | 原始语音转写 |
| POST /api/spaces/:s/captures/:c/shares | 创建过期、可撤销的分享快照 |
| GET /api/public/:token | 只读客户记录 |
| POST /api/public/:token/otp | 向预设收件邮箱发送验证码 |
| POST /api/public/:token/otp/verify | 验证一次性代码并设置短期访问 Cookie |
| POST /api/public/:token/ack | 自述或经邮箱验证的确认 / 问题反馈 |
| GET /api/verification-key | Ed25519 验证公钥 |
| GET /api/spaces/:s/export.csv, /export.zip, /report.pdf | 导出 |

请求字段以 `server/index.mjs` 的 Zod schema 为准。所有资产提交时必须附 SHA-256；不匹配返回 422。重复 capture ID 仅允许同一用户、同一空间、同一资产哈希集合，冲突返回 409。

## 分片上传

先 POST `/uploads`，包含 capture 元数据和 `assets:[{kind,mime,sha256,bytes}]`，不包含 data。返回 upload ID 和各资产已收到的 `offsets`。对每个文件按索引 PUT 二进制，`Content-Type: application/octet-stream`、`X-Offset` 为起始字节位置。单片最多 1 MiB，客户端默认 512 KiB。

重复发送相同字节分片可安全恢复；偏移或内容冲突返回 409。完成接口核对文件长度与哈希后才创建 capture。上传会话 24 小时过期。单资产最大 24 MiB，单 capture 分片总量最大 30 MiB。

## 只读 REST / MCP

在 Developer 页面创建 API Key，保存仅显示一次的 `token` 和 `signing_secret`。请求头：

```
Authorization: Bearer TOKEN
X-Snapoto-Timestamp: UNIX_MILLISECONDS
X-Snapoto-Nonce: UNIQUE_UUID
X-Snapoto-Signature: LOWERCASE_HEX_HMAC_SHA256
```

签名文本为以下内容，以换行连接，末尾不加换行：

```
METHOD
PATH_WITH_QUERY
TIMESTAMP
NONCE
SHA256_OF_BODY
```

GET 的 body 是空字符串。JSON POST 的签名 body 必须与服务端 `JSON.stringify` 解析后对象一致（使用紧凑 JSON，保持字段顺序）。时间容差 5 分钟，nonce 不可重复。

- GET `/api/v1/captures` 返回授权空间的照片验证元数据。
- POST `/api/mcp` 支持 initialize、tools/list 和只读 `list_photo_records`。
- MCP 接入需客户端支持上述签名请求头；本实现不宣称支持所有无需适配的通用 MCP 客户端。

## Webhook

事件类型：`capture.cloud_verified`、`share.acknowledged`。Payload 包含事件 ID、时间和关联记录 ID，不包含原图或凭据。

`X-Snapoto-Signature = HMAC_SHA256(secret, timestamp + '.' + rawBody)`。

使用 `X-Snapoto-Event` 做幂等去重；验证时间范围与签名后持久化接收，再返回 2xx。系统最多尝试 5 次，失败记录出现在 Developer 页面。

## 验证清单

客户记录返回 `signed_manifest`，其中 `manifest` 是签名时的原始 JSON 字符串。使用 `/api/verification-key` 的 PEM 公钥、Ed25519 和 Base64 解码后的 signature 验证原始字符串。文件哈希和服务器收件时间不证明现场事实、设备真实性或拍摄时刻的服务器时间。

## 可选邮箱访问验证

管理员创建分享时可指定 `require_otp:true`、`recipient_email` 和同空间已连接的 Gmail/Microsoft `otp_connector_id`。未验证的 GET 只返回 `access_required`、掩码邮箱和到期时间，不返回照片；图片与确认接口返回 401。

先 POST `/otp` 获取 `challenge_id`，再 POST `/otp/verify` 发送 `{challenge_id,code}`。六位代码有效 10 分钟、最多尝试 5 次、成功后作废。每个链接每分钟最多请求一次、每小时最多 5 次。投递结果不确定时不自动重试。访问 Cookie 为 HttpOnly、SameSite=Strict，HTTPS 时 Secure，有效期最多 30 分钟且不超过分享期限；撤销链接立即阻止访问。过期代码和会话由保留任务清理。

确认记录使用 `identity_check:email_verified`、`method:email_otp` 和验证时间；这证明访问了指定邮箱，不证明现实身份或具有法律效力的签收。关闭该选项时仍是 `not_verified` / `self_reported`。

## AI endpoints (V2)

All under `/api/spaces/:sid`. Model output is untrusted proposed data; nothing here sends a message or sets `order_number` on its own.

- Capture JSON has `ai: { state: "pending"|"done"|"failed"|"off", caption, tags[], findings[{id,field,value,confidence,where,status,accepted_value?}], issues[], model, analyzed_at, error?, caption_edited? }`. New photos are queued (`pending`) when AI is configured and `settings.ai_auto !== false`; the worker analyses each original hash once. Finding `field` ∈ `order_number|plate|meter|serial|text`; values that aren't identifier-shaped (or look like instructions/contacts/links) are dropped and counted in `ai.rejected_findings`.
- `POST /captures/:cid/analyze` — re-run now (photographer or Owner/Admin). 503 without AI.
- `POST /captures/:cid/findings/:fid` `{ action: "accept"|"dismiss", value?, confirm? }` — accepting `order_number` sets `order_number` (edited `value` wins) and `order_confirmed=true` only when `confirm: true`; 409 if a different number is already confirmed. Other fields go to `capture.fields[field]` (also usable as template fields `plate`, `meter`, `serial`). Members: own photos only.
- `PATCH /captures/:cid` `{ caption }` — human caption (≤140), sets `ai.caption_edited=true`; later analyses keep it.
- `POST /reports/daily` `{ date: "YYYY-MM-DD", tz_offset_min? }` (Owner/Admin/Viewer). `tz_offset_min` = minutes east of UTC, i.e. `-new Date().getTimezoneOffset()` (New York EDT = `-240`). Counts are computed by the server; capture ids the model invents are dropped. `GET /reports/daily?date=` → latest stored or 404; `GET /reports/daily.pdf?date=` → PDF with thumbnails.
- `POST /search` accepts `{ text }` or `{ q }` and also matches AI caption, tags, accepted findings and `capture.fields`. `GET /captures?q=` does too.
- `POST /templates/suggest` `{ description }` (Owner/Admin) → `{ name, fields, locked_fields, custom, reason, model }`, allowed field keys only, never saved.
- `PATCH /settings` accepts `ai_auto` (default true; kept if omitted).
- Webhook/audit event `capture.analyzed` `{ capture_id, state }`.
