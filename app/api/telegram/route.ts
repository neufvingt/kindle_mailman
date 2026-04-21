import { NextResponse, after } from 'next/server';
import { downloadFile, editMessageText, getFile, sendMessage } from '@/lib/telegram';
import { parseCommand } from '@/lib/commands';
import { sendToKindle } from '@/lib/email';
import { extractBookMetadata, formatBookSubject, updateEpubAuthor } from '@/lib/siliconflow';

export const runtime = 'nodejs';

// Telegram bot API can download files up to 20MB via standard API.
const MAX_FILE_SIZE = 20 * 1024 * 1024;

// In-memory settings storage (resets on server restart, default: enabled)
const chatSettings = new Map<string, { cleanFilename: boolean }>();

function getChatSettings(chatId: number | string) {
  const key = String(chatId);
  if (!chatSettings.has(key)) {
    chatSettings.set(key, { cleanFilename: true });
  }
  return chatSettings.get(key)!;
}

function setChatSettings(chatId: number | string, settings: { cleanFilename: boolean }) {
  chatSettings.set(String(chatId), settings);
}

type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramChat = {
  id: number | string;
  title?: string;
  username?: string;
  type: string;
};

type TelegramMessage = {
  message_id: number;
  text?: string;
  caption?: string;
  chat: TelegramChat;
  from?: TelegramUser;
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  photo?: {
    file_id: string;
    width: number;
    height: number;
    file_size?: number;
  }[];
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

function verifyWebhookSecret(request: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return true;

  const received = request.headers.get('x-telegram-bot-api-secret-token');
  return received === expected;
}

function cleanFilename(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  const hasExtension = lastDot > 0;
  const name = hasExtension ? filename.slice(0, lastDot) : filename;
  const ext = hasExtension ? filename.slice(lastDot) : '';

  const sourceTagPattern = /[\s,，._-]*(?:z[\s._-]*library|z[\s._-]*lib|zlib|1lib)(?:[\s._-]*[a-z0-9]{1,8})*[\s,，._-]*/gi;

  const cleaned = name
    .replace(/\([^)]*\)/g, '') // ()
    .replace(/\[[^\]]*\]/g, '') // []
    .replace(/\{[^}]*\}/g, '') // {}
    .replace(/（[^）]*）/g, '') // （）
    .replace(/【[^】]*】/g, '') // 【】
    .replace(/〔[^〕]*〕/g, '') // 〔〕
    .replace(/〈[^〉]*〉/g, '') // 〈〉
    .replace(/《[^》]*》/g, '') // 《》
    .replace(/「[^」]*」/g, '') // 「」
    .replace(/『[^』]*』/g, '') // 『』
    .replace(sourceTagPattern, '')
    .replace(/[，,]+/g, ' ')
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .replace(/^[.\-_ ]+|[.\-_ ]+$/g, '')
    .trim();

  const finalName = cleaned || 'document';

  return finalName + ext;
}

function buildSubject(message: TelegramMessage) {
  const user = message.from;
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
  const username = user?.username ? `@${user.username}` : '';
  return `Telegram → Kindle | ${name || username || `chat ${message.chat.id}`}`;
}

function helpMessage(cleanEnabled: boolean) {
  return [
    'Send to Kindle via /send:',
    '/send <text to forward>',
    'You can also send a file (DOCX/EPUB/MOBI/TXT/JPG/PNG) directly.',
    '',
    '/clean - Toggle filename cleaning (remove brackets/source tags)',
    '/clean on|off - Enable or disable filename cleaning',
    `Current status: ${cleanEnabled ? 'ON' : 'OFF'}`,
    '',
    'Example:',
    '/send This is my note for Kindle.',
  ].join('\n');
}

async function buildDocumentAttachment(document: NonNullable<TelegramMessage['document']>, shouldClean: boolean) {
  const file = await getFile(document.file_id);
  if (!file.file_path) {
    throw new Error('Telegram did not return file_path for document');
  }

  const content = await downloadFile(file.file_path);
  const rawFilename = document.file_name ?? `document-${document.file_id}`;

  return {
    filename: shouldClean ? cleanFilename(rawFilename) : rawFilename,
    content,
    contentType: document.mime_type,
  };
}

async function buildPhotoAttachment(photoSizes: NonNullable<TelegramMessage['photo']>) {
  const largest = photoSizes[photoSizes.length - 1];
  const file = await getFile(largest.file_id);
  if (!file.file_path) {
    throw new Error('Telegram did not return file_path for photo');
  }

  const content = await downloadFile(file.file_path);

  return {
    filename: `photo-${largest.file_id}.jpg`,
    content,
    contentType: 'image/jpeg',
  };
}

export async function POST(request: Request) {
  if (!verifyWebhookSecret(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let update: TelegramUpdate;

  try {
    update = (await request.json()) as TelegramUpdate;
  } catch (error) {
    console.error('Invalid Telegram webhook payload', error);
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }

  const message = update.message ?? update.edited_message;

  if (!message) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  // Owner gate: only process messages from the configured owner when set.
  const ownerChatId = process.env.OWNER_CHAT_ID;
  if (ownerChatId && String(message.chat.id) !== ownerChatId) {
    console.warn('[Telegram] Ignoring chat', message.chat.id, '(not OWNER_CHAT_ID)');
    return NextResponse.json({ ok: true, ignored: 'unauthorized chat' });
  }

  const settings = getChatSettings(message.chat.id);

  // Attachment path: ACK fast, then process in the background via after().
  if (message.document || (message.photo && message.photo.length > 0)) {
    const fileSize = message.document?.file_size ?? 0;
    if (fileSize > MAX_FILE_SIZE) {
      const mb = (fileSize / 1024 / 1024).toFixed(1);
      const limit = MAX_FILE_SIZE / 1024 / 1024;
      try {
        await sendMessage(
          message.chat.id,
          `❌ 文件 ${mb}MB 超过 Telegram bot ${limit}MB 下载上限，请压缩后再发`,
        );
      } catch (err) {
        console.error('[Telegram] size-limit notify failed', err);
      }
      return NextResponse.json({ ok: true, ignored: 'too large' });
    }

    let progressMsgId: number;
    try {
      const sent = await sendMessage(message.chat.id, '📥 已收到文件，处理中...');
      progressMsgId = sent.message_id;
    } catch (err) {
      console.error('[Telegram] initial ack failed, aborting', err);
      return NextResponse.json({ ok: false, error: 'telegram send failed' }, { status: 500 });
    }

    after(async () => {
      try {
        await processAttachment(message, progressMsgId, settings);
      } catch (err) {
        console.error('[Telegram] unhandled background error', err);
        try {
          await editMessageText(message.chat.id, progressMsgId, '❌ 处理失败，请重试');
        } catch {
          /* noop */
        }
      }
    });

    return NextResponse.json({ ok: true });
  }

  // Text / command path: fast enough to handle in the foreground.
  if (!message.text) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  try {
    const command = parseCommand(message.text);

    if (command.type === 'start') {
      await sendMessage(message.chat.id, helpMessage(settings.cleanFilename));
      return NextResponse.json({ ok: true });
    }

    if (command.type === 'clean') {
      const newValue = command.enabled ?? !settings.cleanFilename;
      setChatSettings(message.chat.id, { cleanFilename: newValue });
      await sendMessage(
        message.chat.id,
        `Filename cleaning is now ${newValue ? 'ON' : 'OFF'}.\n${newValue ? 'Brackets and source tags like z-library/1lib will be removed from filenames.' : 'Filenames will be kept as-is.'}`
      );
      return NextResponse.json({ ok: true });
    }

    if (command.type === 'send') {
      await sendToKindle({
        subject: buildSubject(message),
        text: command.text,
      });

      await sendMessage(message.chat.id, '📤 已发送到 Kindle ✅');
      return NextResponse.json({ ok: true });
    }

    await sendMessage(message.chat.id, 'Unknown command. Use /send <text> to forward to Kindle.');
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error (text path)', error);
    try {
      await sendMessage(message.chat.id, '❌ 处理失败，请重试');
    } catch (notifyError) {
      console.error('Failed to notify user about the error', notifyError);
    }
    return NextResponse.json({ ok: false, error: 'delivery failed' }, { status: 500 });
  }
}

function isBenignEditError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('too many requests') ||
    msg.includes('retry after') ||
    msg.includes('message is not modified')
  );
}

async function processAttachment(
  message: TelegramMessage,
  progressMsgId: number,
  settings: { cleanFilename: boolean },
) {
  const chatId = message.chat.id;
  const setProgress = async (text: string) => {
    try {
      await editMessageText(chatId, progressMsgId, text);
    } catch (err) {
      if (isBenignEditError(err)) return;
      console.error('[Telegram] editMessageText failed', err);
    }
  };

  let attachment;
  try {
    if (message.document) {
      attachment = await buildDocumentAttachment(message.document, settings.cleanFilename);
    } else if (message.photo) {
      attachment = await buildPhotoAttachment(message.photo);
    }
  } catch (err) {
    console.error('[Telegram] attachment download failed', err);
    await setProgress('❌ 下载文件失败，请稍后重试');
    return;
  }

  if (!attachment) {
    await setProgress('❌ 未能解析附件');
    return;
  }

  let subject = buildSubject(message);
  let bookInfo: { title: string; author: string } | null = null;

  if (message.document) {
    await setProgress('🔍 正在提取书籍信息...');
    const metadata = await extractBookMetadata(
      attachment.content,
      attachment.filename,
      attachment.contentType,
    );
    if (metadata) {
      bookInfo = { title: metadata.title, author: metadata.author };
      const ext = attachment.filename.split('.').pop();
      attachment.filename = `${metadata.title}.${ext}`;

      if (ext === 'epub' && metadata.author && metadata.author !== 'Unknown') {
        try {
          attachment.content = await updateEpubAuthor(attachment.content, metadata.author);
        } catch (err) {
          console.error('[Telegram] EPUB author update failed (continuing)', err);
        }
      }

      subject = formatBookSubject(metadata, subject);
      await setProgress(`📨 正在发送到 Kindle...\n📖 ${bookInfo.title} — ${bookInfo.author}`);
    } else {
      await setProgress('📨 正在发送到 Kindle...');
    }
  }

  try {
    await sendToKindle({
      subject,
      text: message.caption || 'Forwarded from Telegram',
      attachments: [attachment],
    });
  } catch (err) {
    console.error('[Telegram] SMTP send failed', err);
    await setProgress('❌ 发送到 Kindle 失败（SMTP 错误），请检查邮箱配置');
    return;
  }

  if (bookInfo) {
    await setProgress(`📤 已发送到 Kindle ✅\n📖 ${bookInfo.title} — ${bookInfo.author}`);
  } else {
    await setProgress('📤 已发送到 Kindle ✅');
  }
}

export function GET() {
  return NextResponse.json({ ok: true });
}
