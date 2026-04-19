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
    // Extract text preview from buffer (first 3000 chars for analysis)
    const textPreview = extractTextPreview(content, mimeType);

    if (!textPreview) {
      console.log('Could not extract text preview from file');
      return null;
    }

    // Call SiliconFlow DeepSeek API
    const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-ai/DeepSeek-V3',
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
      console.error('SiliconFlow API error:', response.status, await response.text());
      return null;
    }

    const data = await response.json();
    const content_text = data.choices?.[0]?.message?.content?.trim();

    if (!content_text) {
      return null;
    }

    // Parse JSON response
    const parsed = parseMetadataResponse(content_text);

    if (parsed && parsed.title && parsed.author) {
      return {
        title: parsed.title,
        author: parsed.author,
        confidence: 'high',
      };
    }

    return null;
  } catch (error) {
    console.error('Error extracting book metadata:', error);
    return null;
  }
}

function extractTextPreview(content: Buffer, mimeType?: string): string | null {
  try {
    // For text-based formats, extract directly
    if (mimeType?.includes('text') || mimeType?.includes('html')) {
      return content.toString('utf-8').slice(0, 3000);
    }

    // For PDF/EPUB, try to extract text (basic approach)
    // Note: For production, consider using pdf-parse or epub-parser libraries
    const text = content.toString('utf-8', 0, Math.min(content.length, 5000));

    // Clean up binary noise
    const cleaned = text.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, ' ');

    return cleaned.slice(0, 3000);
  } catch (error) {
    console.error('Error extracting text preview:', error);
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
