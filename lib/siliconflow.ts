/**
 * SiliconFlow DeepSeek API integration
 * Extract book title and author from document content
 */

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
    console.warn('SILICONFLOW_API_KEY not set, skipping metadata extraction');
    return null;
  }

  try {
    console.log(`[SiliconFlow] Starting metadata extraction for: ${filename}`);

    // Extract text preview from buffer (first 3000 chars for analysis)
    const textPreview = extractTextPreview(content, mimeType);

    if (!textPreview) {
      console.log('[SiliconFlow] Could not extract text preview from file');
      return null;
    }

    console.log(`[SiliconFlow] Extracted ${textPreview.length} chars of text preview`);

    // Get model from env or use default
    const model = process.env.SILICONFLOW_MODEL || 'deepseek-ai/DeepSeek-V3';
    console.log(`[SiliconFlow] Using model: ${model}`);

    // Call SiliconFlow DeepSeek API
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
            content: 'You are a book metadata extraction assistant. Extract the book title and author from the provided text. Return ONLY a JSON object with "title" and "author" fields. If you cannot determine them with confidence, return {"title": "", "author": ""}.'
          },
          {
            role: 'user',
            content: `Extract the book title and author from this text:\n\nFilename: ${filename}\n\nContent preview:\n${textPreview}\n\nReturn JSON only.`
          }
        ],
        temperature: 0.1,
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SiliconFlow] API error:', response.status, errorText);
      return null;
    }

    const data = await response.json();
    const content_text = data.choices?.[0]?.message?.content?.trim();

    console.log('[SiliconFlow] API response:', content_text);

    if (!content_text) {
      console.log('[SiliconFlow] Empty response from API');
      return null;
    }

    // Parse JSON response
    const parsed = parseMetadataResponse(content_text);

    if (parsed && parsed.title && parsed.author) {
      console.log(`[SiliconFlow] Successfully extracted - Title: "${parsed.title}", Author: "${parsed.author}"`);
      return {
        title: parsed.title,
        author: parsed.author,
        confidence: 'high',
      };
    }

    console.log('[SiliconFlow] Could not parse valid metadata from response');
    return null;
  } catch (error) {
    console.error('[SiliconFlow] Error extracting book metadata:', error);
    return null;
  }
}

function extractTextPreview(content: Buffer, mimeType?: string): string | null {
  try {
    console.log(`[SiliconFlow] Extracting text from mime type: ${mimeType || 'unknown'}`);

    // For text-based formats, extract directly
    if (mimeType?.includes('text') || mimeType?.includes('html')) {
      const text = content.toString('utf-8').slice(0, 3000);
      console.log(`[SiliconFlow] Extracted text format, length: ${text.length}`);
      return text;
    }

    // For EPUB (it's actually a ZIP file with XML inside)
    if (mimeType?.includes('epub')) {
      // Try to find readable text in the EPUB structure
      const text = content.toString('utf-8', 0, Math.min(content.length, 10000));
      // Look for content between XML tags
      const contentMatch = text.match(/<dc:title[^>]*>([^<]+)<\/dc:title>|<dc:creator[^>]*>([^<]+)<\/dc:creator>|<title[^>]*>([^<]+)<\/title>/gi);
      if (contentMatch) {
        console.log('[SiliconFlow] Found EPUB metadata tags');
        return contentMatch.join('\n').slice(0, 3000);
      }
    }

    // For PDF/other binary formats, try to extract readable text
    const text = content.toString('utf-8', 0, Math.min(content.length, 10000));

    // Clean up binary noise - keep only printable characters
    const cleaned = text
      .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const preview = cleaned.slice(0, 3000);
    console.log(`[SiliconFlow] Extracted cleaned text, length: ${preview.length}`);

    // Check if we got meaningful text (at least 50 readable chars)
    const readableChars = preview.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').length;
    console.log(`[SiliconFlow] Readable characters: ${readableChars}`);

    if (readableChars < 50) {
      console.log('[SiliconFlow] Not enough readable text extracted');
      return null;
    }

    return preview;
  } catch (error) {
    console.error('[SiliconFlow] Error extracting text preview:', error);
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
    console.error('Error parsing metadata response:', error);
    return null;
  }
}

export function formatBookSubject(metadata: BookMetadata | null, fallback: string): string {
  if (!metadata || !metadata.title) {
    return fallback;
  }

  const parts = [metadata.title];
  if (metadata.author) {
    parts.push(`by ${metadata.author}`);
  }

  return parts.join(' - ');
}
