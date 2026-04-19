/**
 * SiliconFlow DeepSeek API integration
 * Extract book title and author from document content
 */

import JSZip from 'jszip';

interface BookMetadata {
  title: string;
  author: string;
  confidence: 'high' | 'medium' | 'low';
}

export async function extractBookMetadata(
  content: Buffer,
  filename: string,
  mimeType?: string
): Promise<BookMetadata | null> {
  const apiKey = process.env.SILICONFLOW_API_KEY;

  if (!apiKey) {
    console.warn('[SiliconFlow] SILICONFLOW_API_KEY not set, skipping metadata extraction');
    return null;
  }

  try {
    console.log(`[SiliconFlow] Starting metadata extraction for: ${filename}, mime: ${mimeType}`);

    // Extract text preview from buffer
    const textPreview = await extractTextPreview(content, mimeType, filename);

    if (!textPreview || textPreview.length < 20) {
      console.log('[SiliconFlow] Could not extract sufficient text, trying filename-based extraction');
      return await extractFromFilename(filename, apiKey);
    }

    console.log(`[SiliconFlow] Extracted ${textPreview.length} chars of text preview`);
    console.log(`[SiliconFlow] Preview sample: ${textPreview.slice(0, 200)}...`);

    // Get model from env or use default
    const model = process.env.SILICONFLOW_MODEL || 'deepseek-ai/DeepSeek-V3';
    console.log(`[SiliconFlow] Using model: ${model}`);

    // Call SiliconFlow DeepSeek API
    const requestBody = {
      model,
      messages: [
        {
          role: 'system',
          content: `You are a book metadata extraction assistant. Extract the book title and author from the provided text.

Author name formatting rules:
- For Chinese authors or web novels: Use only the author name (e.g., "刘慈欣", "唐家三少")
- For foreign authors: Use format "[Country]FirstName·LastName" with · as separator (e.g., "[美]欧内斯特·海明威", "[日]东野圭吾", "[英]J·K·罗琳")
- Use Chinese country names: 美国→美, 英国→英, 日本→日, 法国→法, 俄罗斯→俄, etc.

Return ONLY a JSON object with "title" and "author" fields. If you cannot determine them with confidence, return {"title": "", "author": ""}.`
        },
        {
          role: 'user',
          content: `Extract the book title and author from this text:\n\nFilename: ${filename}\n\nContent preview:\n${textPreview}\n\nReturn JSON only.`
        }
      ],
      temperature: 0.1,
      max_tokens: 200,
    };

    console.log('[SiliconFlow] Sending request to API...');

    const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SiliconFlow] API error:', response.status, errorText);
      // Fallback to filename extraction
      return await extractFromFilename(filename, apiKey);
    }

    const data = await response.json();
    const content_text = data.choices?.[0]?.message?.content?.trim();

    console.log('[SiliconFlow] API response:', content_text);

    if (!content_text) {
      console.log('[SiliconFlow] Empty response from API');
      return await extractFromFilename(filename, apiKey);
    }

    // Parse JSON response
    const parsed = parseMetadataResponse(content_text);

    if (parsed && parsed.title && parsed.author) {
      console.log(`[SiliconFlow] ✓ Successfully extracted - Title: "${parsed.title}", Author: "${parsed.author}"`);
      return {
        title: parsed.title,
        author: parsed.author,
        confidence: 'high',
      };
    }

    console.log('[SiliconFlow] Could not parse valid metadata from response, trying filename');
    return await extractFromFilename(filename, apiKey);
  } catch (error) {
    console.error('[SiliconFlow] Error extracting book metadata:', error);
    // Last resort: try filename
    return await extractFromFilename(filename, apiKey);
  }
}

async function extractFromFilename(filename: string, apiKey: string): Promise<BookMetadata | null> {
  try {
    console.log(`[SiliconFlow] Attempting filename-based extraction for: ${filename}`);

    const model = process.env.SILICONFLOW_MODEL || 'deepseek-ai/DeepSeek-V3';

    const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: `Extract book title and author from filename.

Author name formatting rules:
- For Chinese authors or web novels: Use only the author name (e.g., "刘慈欣", "唐家三少")
- For foreign authors: Use format "[Country]FirstName·LastName" with · as separator (e.g., "[美]欧内斯特·海明威", "[日]东野圭吾")
- Use Chinese country names: 美国→美, 英国→英, 日本→日, 法国→法, 俄罗斯→俄, etc.

Return ONLY JSON: {"title": "...", "author": "..."}. If unclear, return empty strings.`
          },
          {
            role: 'user',
            content: `Filename: ${filename}`
          }
        ],
        temperature: 0.1,
        max_tokens: 150,
      }),
    });

    if (!response.ok) {
      console.error('[SiliconFlow] Filename extraction API error:', response.status);
      return null;
    }

    const data = await response.json();
    const content_text = data.choices?.[0]?.message?.content?.trim();

    console.log('[SiliconFlow] Filename extraction response:', content_text);

    const parsed = parseMetadataResponse(content_text);

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

async function extractTextPreview(content: Buffer, mimeType?: string, filename?: string): Promise<string | null> {
  try {
    console.log(`[SiliconFlow] Extracting text from mime type: ${mimeType || 'unknown'}, size: ${content.length} bytes`);

    // For text-based formats, extract directly
    if (mimeType?.includes('text') || mimeType?.includes('html')) {
      const text = content.toString('utf-8').slice(0, 3000);
      console.log(`[SiliconFlow] Extracted text format, length: ${text.length}`);
      return text;
    }

    // Try to detect format from filename if mime type is generic
    const ext = filename?.toLowerCase().split('.').pop();
    console.log(`[SiliconFlow] File extension: ${ext}`);

    // For EPUB (it's a ZIP file with XML inside)
    if (ext === 'epub' || mimeType?.includes('epub')) {
      console.log('[SiliconFlow] Detected EPUB format, parsing as ZIP');
      return await extractEpubTextPreview(content);
    }

    // For MOBI/AZW
    if (ext === 'mobi' || ext === 'azw' || ext === 'azw3') {
      console.log('[SiliconFlow] Detected MOBI/AZW format');
      const text = content.toString('utf-8', 0, Math.min(content.length, 10000));
      const cleaned = text.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, ' ');
      return cleaned.slice(0, 3000);
    }

    // For PDF and other binary formats
    const text = content.toString('utf-8', 0, Math.min(content.length, 15000));

    // Clean up binary noise - keep only printable characters
    const cleaned = text
      .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const preview = cleaned.slice(0, 3000);

    // Check if we got meaningful text (at least 30 readable chars)
    const readableChars = preview.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').length;
    console.log(`[SiliconFlow] Extracted cleaned text, length: ${preview.length}, readable: ${readableChars}`);

    if (readableChars < 30) {
      console.log('[SiliconFlow] Not enough readable text extracted');
      return null;
    }

    return preview;
  } catch (error) {
    console.error('[SiliconFlow] Error extracting text preview:', error);
    return null;
  }
}

/**
 * Properly parse EPUB as ZIP to extract metadata and text preview from OPF.
 */
async function extractEpubTextPreview(content: Buffer): Promise<string | null> {
  try {
    const zip = await JSZip.loadAsync(content);

    // Find the OPF file
    let opfPath: string | null = null;
    zip.forEach((relativePath, file) => {
      if (!file.dir && relativePath.endsWith('.opf')) {
        opfPath = relativePath;
      }
    });

    if (!opfPath) {
      console.warn('[SiliconFlow] No .opf found in EPUB ZIP');
      return null;
    }

    const opfContent = await zip.file(opfPath)!.async('string');

    const titleMatch = opfContent.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
    const authorMatch = opfContent.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i);

    if (titleMatch || authorMatch) {
      const extracted = [
        titleMatch ? `Title: ${titleMatch[1]}` : '',
        authorMatch ? `Author: ${authorMatch[1]}` : ''
      ].filter(Boolean).join('\n');
      console.log(`[SiliconFlow] Found EPUB metadata via ZIP: ${extracted}`);
      return extracted;
    }

    // Fallback: extract first few hundred chars of OPF for the AI to work with
    console.log('[SiliconFlow] No dc:title/dc:creator in OPF, sending OPF preview');
    return opfContent.slice(0, 3000);
  } catch (error) {
    console.error('[SiliconFlow] Error parsing EPUB as ZIP:', error);
    return null;
  }
}

function parseMetadataResponse(text: string): { title: string; author: string } | null {
  try {
    // Try to extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        title: parsed.title?.trim() || '',
        author: parsed.author?.trim() || '',
      };
    }
    return null;
  } catch (error) {
    console.error('[SiliconFlow] Error parsing metadata response:', error);
    return null;
  }
}

/**
 * Update the dc:creator in an EPUB's OPF file with the formatted author name.
 * EPUB is a ZIP; we find the .opf file inside, replace <dc:creator>, and re-zip.
 */
export async function updateEpubAuthor(epubBuffer: Buffer, author: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(epubBuffer);

  // Find the OPF file (usually at OEBPS/content.opf or similar)
  let opfPath: string | null = null;
  zip.forEach((relativePath, file) => {
    if (!file.dir && relativePath.endsWith('.opf')) {
      opfPath = relativePath;
    }
  });

  if (!opfPath) {
    console.warn('[EPUB] No .opf file found inside EPUB, skipping author update');
    return epubBuffer;
  }

  console.log(`[EPUB] Found OPF at: ${opfPath}`);
  const opfContent = await zip.file(opfPath)!.async('string');

  // Replace dc:creator content with the formatted author
  const updatedOpf = opfContent.replace(
    /<dc:creator[^>]*>([^<]*)<\/dc:creator>/i,
    `<dc:creator>${author}</dc:creator>`
  );

  if (updatedOpf === opfContent) {
    console.warn('[EPUB] No <dc:creator> found in OPF, skipping author update');
    return epubBuffer;
  }

  zip.file(opfPath, updatedOpf);

  const newBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  console.log(`[EPUB] Author metadata updated to: "${author}"`);
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
