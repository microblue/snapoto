# Snapoto V2 redesign spec (hackathon build, 2026-11-04)

Authority: `docs/Snapoto_PRD_V2.0.docx`. Competitor benchmark: Timemark.
Positioning: **Timemark stamps photos. Snapoto reads them, files them, and sends the proof for you.**

Design rules: foolproof, one obvious action per screen, plain words (no "DSL",
"manifest", "pipeline"), large touch targets (≥48px), every state visible
(Saved on phone → Uploading → In cloud ✓ / Problem + reason). AI is always
shown as a *suggestion* the person confirms; AI never sends, never picks a
recipient, never overwrites a human-confirmed value.

AI provider: Meta **Muse Spark** (`meta/muse-spark-1.3` via OpenRouter's
OpenAI-compatible API in production; `AI_BASE_URL`/`AI_MODEL`/`AI_API_KEY`).
Text inside images is untrusted data, never instructions.

## How we beat Timemark

| Timemark pain / gap | Snapoto answer | Where |
| --- | --- | --- |
| Wrong auto-address, hard to fix | Tap address → pick from nearby candidates or type; choice sticks until you move; raw GPS kept | app |
| Types order/plate/meter by hand | AI reads the photo and proposes order #, plate, meter, serial → one tap Confirm | app + web |
| No AI at all | Auto caption + tags on every photo; AI daily report; ask-in-plain-words search; describe-your-job template wizard | web + app |
| Watermark removal / originals paywalled | Originals always kept, no Snapoto branding on photos | all |
| Export bugs, lost photos | "Saved ✓" only after disk write; per-photo upload status with reason | app |
| Guest link = just photos | Customer page with Verified ✓ (hash, server time, location quality), confirm/report | customer |
| Webhooks only | Plain-language automations with preview + dry-run + approval | web |

## API contract (all under `/api/spaces/:sid`, session cookie or Bearer token)

### Capture AI analysis
After a capture's original is cloud-verified and the space has
`settings.ai_auto !== false` and AI is configured, the server queues an
analysis (background worker, at most once per original hash). Capture JSON gains:

```json
"ai": {
  "state": "pending" | "done" | "failed" | "off",
  "caption": "Delivered 3 boxes at loading dock B",      // ≤140 chars
  "tags": ["delivery", "boxes", "dock"],                 // ≤6, lowercase
  "findings": [                                          // proposals only
    { "id": "f1", "field": "order_number" | "plate" | "meter" | "serial" | "text",
      "value": "SO-48213", "confidence": 0.93, "where": "label, top left",
      "status": "proposed" | "accepted" | "dismissed" }
  ],
  "issues": ["Possible dent on box corner"],             // things a boss may want to check
  "model": "meta/muse-spark-1.3",
  "analyzed_at": "ISO", "error": "string (when failed)"
}
```

- `POST /captures/:cid/analyze` → re-run now (photo taker or Owner/Admin). Returns capture.
- `POST /captures/:cid/findings/:fid` body `{ "action": "accept" | "dismiss", "value"?: string, "confirm"?: boolean }`
  - accept `order_number`: sets `order_number` (edited `value` wins) and, if `confirm` true, `order_confirmed=true` (a human tap = human confirmation). If the capture already has a *confirmed* different order number → 409, nothing changes.
  - accept other fields: stored in `capture.fields[field] = value` (used by watermark/search).
  - Members only on their own captures; Owner/Admin on any. Returns capture.
- `PATCH /captures/:cid` accepts `caption` (human edit; sets `ai.caption_edited=true`).

### AI daily report
- `POST /reports/daily` body `{ "date": "YYYY-MM-DD", "tz_offset_min"?: number }` (Owner/Admin/Viewer) → generates from that day's captures (text only: captions, tags, findings, issues, member, address, status, deliveries) and stores it. Response:
```json
{ "id": "...", "date": "2026-11-04", "headline": "14 photos, 3 deliveries confirmed",
  "summary": "…2-4 sentences…",
  "counts": { "photos": 14, "in_cloud": 14, "sent": 3, "needs_you": 2, "members": 3 },
  "highlights": [ { "text": "…", "capture_ids": ["…"] } ],
  "needs_attention": [ { "text": "…", "capture_ids": ["…"] } ],
  "by_member": [ { "name": "Ana", "photos": 6 } ],
  "model": "meta/muse-spark-1.3", "created_at": "ISO" }
```
  Capture IDs the model returns that were not in the input are dropped. Without AI configured → 503 with a clear message; counts can still be shown by the client from `/overview`.
- `GET /reports/daily?date=YYYY-MM-DD` → latest stored report for that date or 404.
- `GET /reports/daily.pdf?date=YYYY-MM-DD` → PDF of the stored report with thumbnails.

### Search
- Existing `POST /search` (`{ q }`) keeps working; it now also matches `ai.caption`, `ai.tags`, accepted findings and `caption`. Response unchanged (list of captures + interpreted filters).

### Template wizard
- `POST /templates/suggest` body `{ "description": "HVAC installs, need unit serial and customer name" }` (Owner/Admin) → `{ "name": "...", "fields": [...allowed field keys in order], "locked_fields": [], "custom": "", "reason": "..." }`. Only allowed field keys. Never saved automatically.

### Settings
- `settings.ai_auto` (default true). `settings.address_override_radius_m` not needed server-side.

### Webhook / audit events
- `capture.analyzed` (ids + state only, no image text).

## Web (boss) — information architecture
Nav (PRD §2): **Today · Photos · Automations · Team · Settings**. Templates live in
Settings → "Watermarks"; Developer (API keys/webhooks/MCP/logs) in Settings →
"Advanced" and only for Owner. Upload lives on Photos as a button.

- **Today**: 4 big numbers (Photos today · In cloud · Sent to customers · Needs you), "AI daily report" card (Generate / regenerate, highlights link to photos, Download PDF), "Needs you" list with one-tap actions (Confirm AI-found order, open run needing review), first-run checklist when the space is new (Company name + allow cloud → Make your watermark → Take or upload first photo → Invite team).
- **Photos**: one big search box "Ask: yesterday's photos at Oak St with damage" (AI search when configured, plain filter otherwise), filter chips (Today, Needs you, Shared, Problems), grid cards with photo, AI caption, tags, status chip; Map toggle; select → Share / Export.
- **Photo detail**: large photo (toggle Watermarked/Original), side panel: AI caption (editable), "AI found" chips (Confirm / Edit / Dismiss), Details (who/when/where), Verification (compact rows), one-tap **Share link** (copy), Send to customer (via rules), history.
- **Watermark editor**: "Describe your job" → AI suggests fields → live preview, then ordered fields list.
- **Customer page**: brand header, big photo, "Verified ✓" summary, details, original vs watermarked, Confirm received / Report a problem.

## Android (worker) — screens
Camera (default, no sign-in needed) · Photos · Me.
- Camera: full-screen viewfinder, giant shutter, top chips: space (Personal/Team), template (tap to switch), GPS quality dot (green ≤20m, amber ≤100m, red/stale). Address line on the live preview is tappable → sheet with up to 3 nearby addresses (Geocoder) + "Type address"; the choice sticks until the device moves >150 m; raw GPS is never changed. After shutter: instant "Saved ✓" + thumbnail with status dot.
- Photos: grouped by day; each row thumbnail + status (Saved on phone / Uploading / In cloud ✓ / Problem: reason) + AI caption when available; tap → detail with "AI found" cards (Confirm / Dismiss) using the findings API (only own uploaded photos while signed in).
- Me: sign in / create account, current space, join team (invite code/link), upload over Wi-Fi only toggle, sync summary.
