# Kindle Mailman

Telegram webhook → Next.js API route on Vercel → SMTP email to your Kindle inbox.

## Stack
- Next.js (App Router) on Node runtime
- Telegram Bot API via native `fetch`
- SMTP email via `nodemailer`
- Optional: SiliconFlow DeepSeek for AI book metadata extraction

## Environment
Copy `.env.example` to `.env.local` and fill:

```
# Telegram Bot (required)
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
OWNER_CHAT_ID=              # REQUIRED — only this chat can use the bot

# Kindle / SMTP (required)
KINDLE_EMAIL=
FROM_EMAIL=
SMTP_HOST=
SMTP_PORT=465
SMTP_USER=
SMTP_PASS=
SMTP_SECURE=true

# SiliconFlow — optional (AI metadata extraction)
SILICONFLOW_API_KEY=
SILICONFLOW_MODEL=deepseek-ai/DeepSeek-V3.2

# Admin endpoint auth
TEST_SECRET=                # Required for /api/test-siliconflow (omit to disable)
```

### Owner gating (important)
`OWNER_CHAT_ID` must be set. Any message from a different chat is silently
ignored. Without it, anyone who finds your bot can burn your SMTP / AI quota.

Find your chat id by messaging `@userinfobot` on Telegram.

### AI Book Metadata Extraction (optional)
If `SILICONFLOW_API_KEY` is set, the bot extracts book title + author (with
nationality tag like `[美]`, `[日]`, `[韩]`) from the uploaded EPUB/MOBI and
uses that as the email subject + renamed attachment. EPUB's internal
`dc:creator` is also rewritten with the formatted author.

Get your key from [SiliconFlow](https://siliconflow.cn/).

## Supported formats
EPUB, MOBI, AZW, AZW3, DOCX, TXT, JPG, PNG. PDF is **not** supported (removed
to keep cold start fast on Vercel Hobby).

## Usage
- `/start` — shows help.
- `/send <text>` — forwards text to Kindle.
- `/clean on|off` — toggle filename sanitization (strip brackets + source tags).
- Send a file/photo — optional caption becomes email body.

Progress is reported by editing a single message in place (no chat spam).

## Local development
```bash
npm install
npm run dev
# webhook endpoint will be http://localhost:3000/api/telegram
```

Simulate Telegram locally:
```bash
curl -X POST http://localhost:3000/api/telegram \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
  -d '{"message":{"chat":{"id":YOUR_OWNER_CHAT_ID,"type":"private"},"text":"/send hello"}}'
```

## Deploy to Vercel
1. Push to GitHub and connect the repo in Vercel.
2. Set all required env vars above in Project Settings → Environment Variables.
3. Deploy. Webhook URL: `https://<your-domain>/api/telegram`.
4. Register the webhook (paste in browser):
   ```
   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<your-domain>/api/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>
   ```
   `{"ok":true,...}` means success.
5. Verify:
   ```
   https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
   ```

## Admin endpoint: `/api/test-siliconflow`
Disabled when `TEST_SECRET` is unset. Otherwise:
```bash
curl "https://<your-domain>/api/test-siliconflow?key=$TEST_SECRET"
```

## Timeout note (Vercel Hobby)
Attachment processing runs in `after()` (background) so Telegram gets an
immediate 200. Total time still capped by `maxDuration` (10s on Hobby). If
you hit this often, upgrade or shrink the AI preview.
