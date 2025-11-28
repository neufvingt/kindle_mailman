# Kindle Mailman

Telegram webhook → Next.js API route on Vercel → SMTP email to your Kindle inbox.

## Stack
- Next.js (App Router) on Node runtime
- Telegram Bot API via `undici`
- SMTP email via `nodemailer`

## Environment
Copy `.env.example` to `.env.local` and fill:
```
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
OWNER_CHAT_ID=
BOT_INBOX_EMAIL=
TRUSTED_SENDER_EMAIL=
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
PROCESSED_LABEL_NAME=ProcessedByKindleBot
OBSIDIAN_INBOX_EMAIL=
KINDLE_EMAIL=
FROM_EMAIL=
SMTP_HOST=
SMTP_PORT=465
SMTP_USER=
SMTP_PASS=
SMTP_SECURE=true
```

## Local development
```bash
npm install
npm run dev
# webhook endpoint will be http://localhost:3000/api/telegram
```

You can simulate Telegram by POSTing a sample update:
```bash
curl -X POST http://localhost:3000/api/telegram \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
  -d '{"message":{"chat":{"id":123,"type":"private"},"text":"/send hello"}}'
```

## Deploy to Vercel
1. Push to GitHub and connect the repo in Vercel.
2. Set the env vars above in Vercel Project Settings → Environment Variables.
3. Deploy. The webhook URL will be `https://<your-vercel-domain>/api/telegram`.
4. Register the webhook with Telegram:
```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://<your-vercel-domain>/api/telegram" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

## Gmail check (Vercel Cron)
- Add a Vercel Cron job hitting `https://<your-vercel-domain>/api/check-mail`.
- Gmail OAuth credentials: use a refresh token that can read the inbox configured in `BOT_INBOX_EMAIL`.
- Only emails from `TRUSTED_SENDER_EMAIL` with `.html` attachments are processed. Others are logged and left untouched.
- Matching emails are parsed to Markdown via `parseKindleHtml` + `kindleNotebookToMarkdown`, sent to Telegram (`OWNER_CHAT_ID`), and optionally emailed to `OBSIDIAN_INBOX_EMAIL`.
- Processed messages are labeled with `PROCESSED_LABEL_NAME` (default `ProcessedByKindleBot`) and marked read.

## Usage
- `/start` — shows help.
- `/send <text>` — forwards the text to your Kindle address via SMTP and replies with a confirmation.
- Attachments — send a file/photo (Kindle-supported formats like PDF/EPUB/DOC/DOCX/RTF/TXT/JPG/PNG). Optional caption becomes the email body. Bot replies on success/failure.
