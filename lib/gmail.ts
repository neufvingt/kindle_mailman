const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_SAFETY_WINDOW_MS = 60 * 1000;

type GmailMessageList = {
  messages?: { id: string; threadId: string }[];
};

type GmailLabelList = {
  labels?: { id: string; name: string; type: string }[];
};

type GmailAttachmentResponse = {
  data: string;
  size: number;
};

type GmailMessage = {
  id: string;
  threadId: string;
  payload: GmailPayload;
  labelIds?: string[];
  snippet?: string;
};

type GmailPayload = {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string; data?: string };
  headers?: { name: string; value: string }[];
  parts?: GmailPayload[];
};

export type HtmlEmail = {
  id: string;
  fromHeader: string;
  fromAddress: string;
  subject?: string;
  attachments: {
    filename: string;
    data: Buffer;
    mimeType?: string;
  }[];
};

type TokenCache = { accessToken: string; expiresAt: number } | null;

let cachedToken: TokenCache = null;
let cachedLabelId: string | null = null;

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env ${name}`);
  }
  return value;
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  const clientId = requiredEnv('GMAIL_CLIENT_ID');
  const clientSecret = requiredEnv('GMAIL_CLIENT_SECRET');
  const refreshToken = requiredEnv('GMAIL_REFRESH_TOKEN');

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh Gmail token: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - TOKEN_SAFETY_WINDOW_MS,
  };

  return cachedToken.accessToken;
}

async function gmailRequest<T>(path: string, init: RequestInit = {}) {
  const token = await getAccessToken();
  const headers = {
    ...(init.headers || {}),
    Authorization: `Bearer ${token}`,
  } as Record<string, string>;

  const response = await fetch(`${GMAIL_API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail API ${path} failed: ${response.status} ${text}`);
  }

  if (response.status === 204) {
    return null as T;
  }

  return (await response.json()) as T;
}

function decodeBase64Url(data: string) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function getHeader(payload: GmailPayload | GmailMessage, name: string) {
  const headers = (payload as GmailPayload).headers ?? (payload as GmailMessage).payload.headers ?? [];
  const found = headers.find((header) => header.name.toLowerCase() === name.toLowerCase());
  return found?.value;
}

async function downloadAttachment(userId: string, messageId: string, part: GmailPayload) {
  if (part.body?.data) {
    return decodeBase64Url(part.body.data);
  }

  if (!part.body?.attachmentId) {
    throw new Error(`Attachment missing body data for message ${messageId}`);
  }

  const attachment = await gmailRequest<GmailAttachmentResponse>(
    `/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
  );

  return decodeBase64Url(attachment.data);
}

function collectParts(payload: GmailPayload | undefined, collection: GmailPayload[]) {
  if (!payload) return;

  if (payload.filename) {
    collection.push(payload);
  }

  if (payload.parts) {
    payload.parts.forEach((p) => collectParts(p, collection));
  }
}

function extractEmailAddress(fromHeader: string) {
  const match = fromHeader.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase();
  return fromHeader.trim().toLowerCase();
}

export async function listHtmlMessages(userId: string, processedLabelName: string) {
  const labelQuery = processedLabelName.includes(' ') ? `"${processedLabelName}"` : processedLabelName;
  const query = `is:unread has:attachment -label:${labelQuery}`;
  const list = await gmailRequest<GmailMessageList>(
    `/users/${encodeURIComponent(userId)}/messages?${new URLSearchParams({
      q: query,
      maxResults: '20',
    }).toString()}`,
  );

  if (!list.messages?.length) {
    return [] as HtmlEmail[];
  }

  const messages: HtmlEmail[] = [];

  for (const ref of list.messages) {
    const message = await gmailRequest<GmailMessage>(
      `/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(ref.id)}?format=full`,
    );

    const parts: GmailPayload[] = [];
    collectParts(message.payload, parts);

    const htmlAttachments = parts.filter((part) => {
      const file = part.filename ?? '';
      return file.toLowerCase().endsWith('.html');
    });

    if (htmlAttachments.length === 0) {
      console.log('Skip message without HTML attachment', { id: ref.id, from: getHeader(message, 'From') });
      continue;
    }

    const attachments = [];
    for (const attachmentPart of htmlAttachments) {
      const filename = attachmentPart.filename || 'notebook.html';
      const mimeType = attachmentPart.mimeType;
      const data = await downloadAttachment(userId, ref.id, attachmentPart);
      attachments.push({ filename, mimeType, data });
    }

    const fromHeader = getHeader(message, 'From') ?? '';
    const subject = getHeader(message, 'Subject') ?? undefined;

    messages.push({
      id: ref.id,
      fromHeader,
      fromAddress: extractEmailAddress(fromHeader),
      subject,
      attachments,
    });
  }

  return messages;
}

export async function getOrCreateProcessedLabel(userId: string, labelName: string) {
  if (cachedLabelId) return cachedLabelId;

  const labels = await gmailRequest<GmailLabelList>(`/users/${encodeURIComponent(userId)}/labels`);
  const existing = labels.labels?.find((label) => label.name === labelName);

  if (existing) {
    cachedLabelId = existing.id;
    return cachedLabelId;
  }

  const created = await gmailRequest<{ id: string }>(`/users/${encodeURIComponent(userId)}/labels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: labelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    }),
  });

  cachedLabelId = created.id;
  return cachedLabelId;
}

export async function markMessageProcessed(userId: string, messageId: string, labelId: string) {
  await gmailRequest<void>(`/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}/modify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      addLabelIds: [labelId],
      removeLabelIds: ['UNREAD'],
    }),
  });
}
