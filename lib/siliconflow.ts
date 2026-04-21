/**
 * SiliconFlow DeepSeek API integration
 * Extract book title and author from document content
 */

import JSZip from 'jszip';
import { createHash } from 'node:crypto';

interface BookMetadata {
  title: string;
  author: string;
  confidence: 'high' | 'medium' | 'low';
}

// ---------- Content-hash cache ----------
// In-memory; resets on cold start. Upgrade to KV/Redis when deployed to serverless.

const METADATA_CACHE_MAX = 100;
const metadataCache = new Map<string, BookMetadata>();

function contentHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

function cacheGet(hash: string): BookMetadata | null {
  const hit = metadataCache.get(hash);
  if (hit) {
    metadataCache.delete(hash);
    metadataCache.set(hash, hit);
  }
  return hit ?? null;
}

function cacheSet(hash: string, metadata: BookMetadata): void {
  metadataCache.set(hash, metadata);
  if (metadataCache.size > METADATA_CACHE_MAX) {
    const firstKey = metadataCache.keys().next().value;
    if (firstKey) metadataCache.delete(firstKey);
  }
}

// ---------- API call helpers: timeout + retry ----------

const API_TIMEOUT_MS = 15000;

type ChatMessage = { role: 'system' | 'user'; content: string };

async function callSiliconFlowAPI(
  apiKey: string,
  messages: ChatMessage[],
  maxTokens: number,
  timeoutMs: number,
): Promise<string | null> {
  const model = process.env.SILICONFLOW_MODEL || 'deepseek-ai/DeepSeek-V3';

  try {
    const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SiliconFlow] API error:', response.status, errorText);
      return null;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      console.error(`[SiliconFlow] API call timed out after ${timeoutMs}ms`);
    } else {
      console.error('[SiliconFlow] API call failed:', error);
    }
    return null;
  }
}

async function callAndParseJSON(
  apiKey: string,
  messages: ChatMessage[],
  maxTokens: number,
  timeoutMs: number,
): Promise<{ title: string; author: string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await callSiliconFlowAPI(apiKey, messages, maxTokens, timeoutMs);
    if (!text) return null;

    const parsed = parseMetadataResponse(text);
    if (parsed) {
      if (attempt > 0) console.log('[SiliconFlow] JSON parsed on retry');
      return parsed;
    }

    if (attempt === 0) {
      console.log('[SiliconFlow] JSON parse failed, retrying once. Raw:', text.slice(0, 200));
    }
  }
  console.error('[SiliconFlow] JSON parse failed after retry');
  return null;
}

// ---------- Main entry point ----------

export async function extractBookMetadata(
  content: Buffer,
  filename: string,
  mimeType?: string,
): Promise<BookMetadata | null> {
  const apiKey = process.env.SILICONFLOW_API_KEY;

  if (!apiKey) {
    console.warn('[SiliconFlow] SILICONFLOW_API_KEY not set, skipping metadata extraction');
    return null;
  }

  const hash = contentHash(content);
  const cached = cacheGet(hash);
  if (cached) {
    console.log(`[SiliconFlow] ✓ Cache hit (${hash}): "${cached.title}" by "${cached.author}"`);
    return cached;
  }

  try {
    console.log(`[SiliconFlow] Starting metadata extraction for: ${filename}, mime: ${mimeType}, hash: ${hash}`);

    const textPreview = await extractTextPreview(content, mimeType, filename);

    if (!textPreview || textPreview.length < 20) {
      console.log('[SiliconFlow] Insufficient text extracted, falling back to filename');
      const result = await extractFromFilename(filename, apiKey);
      if (result) cacheSet(hash, result);
      return result;
    }

    console.log(`[SiliconFlow] Text preview length: ${textPreview.length}, sample: ${textPreview.slice(0, 200)}...`);

    const parsed = await callAndParseJSON(
      apiKey,
      [
        {
          role: 'system',
          content: `You are a book metadata extraction assistant. Extract the book title and author from the provided text.

Author name formatting rules:
- For Chinese authors or web novels: Use only the author name (e.g., "刘慈欣", "唐家三少")
- For Korean authors: Use format "[韩]姓名" (e.g., "[韩]金爱烂", "[韩]韩江", "[韩]朴景烈"). Be careful NOT to misidentify Korean authors as Chinese. Common Korean surnames like 金, 李, 朴, 崔, 郑, 姜, 尹, 林, 韩, 吴, 张, 沈, 曹 etc. can also be Chinese, so you MUST check the book content and context to determine nationality. Clues that indicate Korean origin: Korean-language text, Korean publishers, Korean literary awards (만해상, 이상문학상, 동인문학상 etc.), Korean place names, Korean cultural references. When in doubt about Korean vs Chinese, check if the text contains any Korean script (한글) or Korean-specific cultural markers.
- For other foreign authors: Use format "[Country]FirstName·LastName" with · as separator (e.g., "[美]欧内斯特·海明威", "[日]东野圭吾", "[英]J·K·罗琳")
- Use Chinese country names: 美国→美, 英国→英, 日本→日, 法国→法, 俄罗斯→俄, 韩国→韩, 德国→德, etc.

Return ONLY a JSON object with "title" and "author" fields. If you cannot determine them with confidence, return {"title": "", "author": ""}.`,
        },
        {
          role: 'user',
          content: `Extract the book title and author from this text:\n\nFilename: ${filename}\n\nContent preview:\n${textPreview}\n\nReturn JSON only.`,
        },
      ],
      200,
      API_TIMEOUT_MS,
    );

    if (parsed && parsed.title && parsed.author) {
      console.log(`[SiliconFlow] ✓ Extracted - Title: "${parsed.title}", Author: "${parsed.author}"`);
      const result: BookMetadata = {
        title: parsed.title,
        author: parsed.author,
        confidence: 'high',
      };
      cacheSet(hash, result);
      return result;
    }

    console.log('[SiliconFlow] Could not extract valid metadata, trying filename');
    const fallback = await extractFromFilename(filename, apiKey);
    if (fallback) cacheSet(hash, fallback);
    return fallback;
  } catch (error) {
    console.error('[SiliconFlow] Error extracting book metadata:', error);
    const fallback = await extractFromFilename(filename, apiKey);
    if (fallback) cacheSet(hash, fallback);
    return fallback;
  }
}

async function extractFromFilename(filename: string, apiKey: string): Promise<BookMetadata | null> {
  try {
    console.log(`[SiliconFlow] Attempting filename-based extraction for: ${filename}`);

    const parsed = await callAndParseJSON(
      apiKey,
      [
        {
          role: 'system',
          content: `Extract book title and author from filename.

Author name formatting rules:
- For Chinese authors or web novels: Use only the author name (e.g., "刘慈欣", "唐家三少")
- For Korean authors: Use format "[韩]姓名" (e.g., "[韩]金爱烂", "[韩]韩江", "[韩]朴景烈"). Be careful NOT to misidentify Korean authors as Chinese. Common Korean surnames like 金, 李, 朴, 崔, 郑, 姜, 尹, 林, 韩, 吴, 张, 沈, 曹 etc. can also be Chinese, so you MUST check the filename and context to determine nationality. Clues that indicate Korean origin: Korean-language filenames, Korean publishers, Korean literary awards (만해상, 이상문학상, 동인문학상 etc.). When in doubt about Korean vs Chinese, prefer Chinese (no country tag).
- For other foreign authors: Use format "[Country]FirstName·LastName" with · as separator (e.g., "[美]欧内斯特·海明威", "[日]东野圭吾")
- Use Chinese country names: 美国→美, 英国→英, 日本→日, 法国→法, 俄罗斯→俄, 韩国→韩, 德国→德, etc.

Return ONLY JSON: {"title": "...", "author": "..."}. If unclear, return empty strings.`,
        },
        {
          role: 'user',
          content: `Filename: ${filename}`,
        },
      ],
      150,
      API_TIMEOUT_MS,
    );

    if (parsed && parsed.title) {
      console.log(`[SiliconFlow] ✓ Extracted from filename - Title: "${parsed.title}", Author: "${parsed.author}"`);
      return {
        title: parsed.title,
        author: parsed.author || 'Unknown',
        confidence: 'medium',
      };
    }

    return null;
  } catch (error) {
    console.error('[SiliconFlow] Filename extraction error:', error);
    return null;
  }
}

// ---------- Text preview extraction ----------

async function extractTextPreview(content: Buffer, mimeType?: string, filename?: string): Promise<string | null> {
  try {
    console.log(`[SiliconFlow] Extracting preview, mime: ${mimeType || 'unknown'}, size: ${content.length}`);

    if (mimeType?.includes('text') || mimeType?.includes('html')) {
      return content.toString('utf-8').slice(0, 3000);
    }

    const ext = filename?.toLowerCase().split('.').pop();

    if (ext === 'epub' || mimeType?.includes('epub')) {
      return await extractEpubTextPreview(content);
    }

    if (ext === 'mobi' || ext === 'azw' || ext === 'azw3') {
      const meta = extractMobiMetadataDirect(content);
      if (meta && (meta.title || meta.author)) {
        const lines = [];
        if (meta.title) lines.push(`Title: ${meta.title}`);
        if (meta.author) lines.push(`Author: ${meta.author}`);
        return lines.join('\n');
      }
      // fall through to binary cleanup
    }

    const text = content.toString('utf-8', 0, Math.min(content.length, 15000));
    const cleaned = text
      .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const preview = cleaned.slice(0, 3000);

    const readableChars = preview.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').length;
    console.log(`[SiliconFlow] Binary-cleaned preview: length=${preview.length}, readable=${readableChars}`);

    if (readableChars < 30) return null;
    return preview;
  } catch (error) {
    console.error('[SiliconFlow] Error extracting text preview:', error);
    return null;
  }
}

// ---------- MOBI EXTH header parsing ----------
// Scans for "EXTH" magic in the first 4KB and extracts author (record 100) and updated title (503).
// Reference: https://wiki.mobileread.com/wiki/MOBI#EXTH_Header

function extractMobiMetadataDirect(content: Buffer): { title: string; author: string } | null {
  try {
    const searchLimit = Math.min(content.length, 4096);
    let exthStart = -1;
    for (let i = 0; i < searchLimit - 4; i++) {
      if (
        content[i] === 0x45 /* E */ &&
        content[i + 1] === 0x58 /* X */ &&
        content[i + 2] === 0x54 /* T */ &&
        content[i + 3] === 0x48 /* H */
      ) {
        exthStart = i;
        break;
      }
    }
    if (exthStart < 0) return null;
    if (exthStart + 12 > content.length) return null;

    const recordCount = content.readUInt32BE(exthStart + 8);
    if (recordCount <= 0 || recordCount > 200) return null;

    let pos = exthStart + 12;
    let author = '';
    let updatedTitle = '';

    for (let i = 0; i < recordCount && pos + 8 <= content.length; i++) {
      const recordType = content.readUInt32BE(pos);
      const recordLen = content.readUInt32BE(pos + 4);
      if (recordLen < 8 || recordLen > 4096 || pos + recordLen > content.length) break;

      if (recordType === 100 || recordType === 503) {
        const data = content.slice(pos + 8, pos + recordLen).toString('utf-8').replace(/\0+$/g, '').trim();
        if (recordType === 100 && !author) author = data;
        if (recordType === 503 && !updatedTitle) updatedTitle = data;
      }

      pos += recordLen;
    }

    // PalmDB name as title fallback (first 32 bytes, null-padded)
    let dbName = '';
    const rawName = content.slice(0, 32).toString('utf-8').replace(/\0+$/g, '').trim();
    if (rawName && !/[\x00-\x08\x0E-\x1F]/.test(rawName)) dbName = rawName;

    const title = updatedTitle || dbName;
    if (!title && !author) return null;

    console.log(`[SiliconFlow] MOBI EXTH parsed: title="${title}", author="${author}"`);
    return { title, author };
  } catch (error) {
    console.error('[SiliconFlow] MOBI EXTH parse failed:', error);
    return null;
  }
}

// ---------- EPUB helpers ----------

/**
 * Rich EPUB preview: OPF metadata (title, author, publisher, language,
 * description) + body text from first non-trivial spine items, so the AI
 * has enough context to infer author nationality.
 */
async function extractEpubTextPreview(content: Buffer): Promise<string | null> {
  try {
    const zip = await JSZip.loadAsync(content);

    let opfPath: string | null = null;
    zip.forEach((relativePath, file) => {
      if (!file.dir && relativePath.endsWith('.opf')) opfPath = relativePath;
    });
    if (!opfPath) return null;

    const opf = await zip.file(opfPath)!.async('string');

    const metaLines: string[] = [];
    const pick = (tag: string, flags = 'i') =>
      decodeXmlEntities(
        opf.match(new RegExp(`<dc:${tag}[^>]*>([\\s\\S]+?)<\\/dc:${tag}>`, flags))?.[1]?.trim() || '',
      );
    const title = pick('title');
    const author = pick('creator');
    const publisher = pick('publisher');
    const language = pick('language');
    const description = pick('description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    if (title) metaLines.push(`Title: ${title}`);
    if (author) metaLines.push(`Author (raw): ${author}`);
    if (publisher) metaLines.push(`Publisher: ${publisher}`);
    if (language) metaLines.push(`Language: ${language}`);
    if (description) metaLines.push(`Description: ${description.slice(0, 500)}`);

    const bodyText = await extractEpubSpineText(zip, opfPath, opf);

    const parts: string[] = [];
    if (metaLines.length > 0) parts.push(metaLines.join('\n'));
    if (bodyText) parts.push(`--- Body text ---\n${bodyText}`);

    if (parts.length === 0) return opf.slice(0, 3000);
    return parts.join('\n\n').slice(0, 4000);
  } catch (error) {
    console.error('[SiliconFlow] EPUB preview failed:', error);
    return null;
  }
}

async function extractEpubSpineText(zip: JSZip, opfPath: string, opfContent: string): Promise<string | null> {
  try {
    const manifest: Record<string, string> = {};
    const itemMatches = opfContent.match(/<item\b[^>]*\/?>/gi) || [];
    for (const item of itemMatches) {
      const id = item.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
      const href = item.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
      if (id && href) manifest[id] = href;
    }

    const spineBlock = opfContent.match(/<spine[^>]*>([\s\S]*?)<\/spine>/i)?.[1] ?? '';
    const spineItems: string[] = [];
    const itemrefRegex = /<itemref\b[^>]*\bidref\s*=\s*["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = itemrefRegex.exec(spineBlock)) !== null) {
      spineItems.push(m[1]);
    }

    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const collected: string[] = [];
    let totalLen = 0;
    const TARGET = 2500;

    for (const idref of spineItems.slice(0, 8)) {
      if (totalLen >= TARGET) break;
      const href = manifest[idref];
      if (!href) continue;

      const cleanHref = decodeURIComponent(href.split('#')[0]);
      const fullPath = opfDir + cleanHref;
      const file = zip.file(fullPath) ?? zip.file(cleanHref);
      if (!file) continue;

      const html = await file.async('string');
      const text = stripHtml(html);

      // Skip very short chunks (cover/title/copyright pages usually < 200 chars).
      if (text.length < 200) continue;

      const take = text.slice(0, TARGET - totalLen);
      collected.push(take);
      totalLen += take.length;
    }

    if (collected.length === 0) return null;
    return collected.join('\n\n');
  } catch (error) {
    console.error('[SiliconFlow] Spine text extraction failed:', error);
    return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseMetadataResponse(text: string): { title: string; author: string } | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        title: parsed.title?.trim() || '',
        author: parsed.author?.trim() || '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Update the dc:creator in an EPUB's OPF file with the formatted author name.
 */
export async function updateEpubAuthor(epubBuffer: Buffer, author: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(epubBuffer);

  let opfPath: string | null = null;
  zip.forEach((relativePath, file) => {
    if (!file.dir && relativePath.endsWith('.opf')) opfPath = relativePath;
  });

  if (!opfPath) {
    console.warn('[EPUB] No .opf file found inside EPUB, skipping author update');
    return epubBuffer;
  }

  console.log(`[EPUB] Found OPF at: ${opfPath}`);
  const opfContent = await zip.file(opfPath)!.async('string');

  const existingMatch = opfContent.match(/<dc:creator[^>]*>([^<]*)<\/dc:creator>/i);
  if (!existingMatch) {
    console.warn('[EPUB] No <dc:creator> found in OPF, skipping author update');
    return epubBuffer;
  }

  const existingAuthor = decodeXmlEntities(existingMatch[1].trim());
  if (existingAuthor === author.trim()) {
    console.log(`[EPUB] Author already up-to-date ("${author}"), skipping re-zip`);
    return epubBuffer;
  }

  const safeAuthor = xmlEscape(author);
  const updatedOpf = opfContent.replace(
    /<dc:creator([^>]*)>[^<]*<\/dc:creator>/i,
    (_match, attrs: string) => `<dc:creator${attrs}>${safeAuthor}</dc:creator>`,
  );

  zip.file(opfPath, updatedOpf);

  const newBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  console.log(`[EPUB] Author metadata updated: "${existingAuthor}" → "${author}"`);
  return newBuffer;
}

export function formatBookSubject(metadata: BookMetadata | null, fallback: string): string {
  if (!metadata || !metadata.title) {
    console.log('[SiliconFlow] Using fallback subject:', fallback);
    return fallback;
  }

  const parts = [metadata.title];
  if (metadata.author && metadata.author !== 'Unknown') {
    parts.push(`by ${metadata.author}`);
  }

  const subject = parts.join(' - ');
  console.log('[SiliconFlow] Formatted subject:', subject);
  return subject;
}
