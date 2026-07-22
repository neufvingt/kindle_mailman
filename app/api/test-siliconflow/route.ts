import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const testSecret = process.env.TEST_SECRET;
  if (!testSecret) {
    return NextResponse.json(
      { ok: false, error: 'TEST_SECRET not set — endpoint disabled' },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const provided =
    url.searchParams.get('key') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';
  if (provided !== testSecret) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const apiKey = process.env.SILICONFLOW_API_KEY;
  const model = process.env.SILICONFLOW_MODEL || 'deepseek-ai/DeepSeek-V3.2';
  const maxTokens = parseInt(process.env.AI_MAX_TOKENS || '2048', 10);

  if (!apiKey) {
    return NextResponse.json({
      ok: false,
      error: 'SILICONFLOW_API_KEY not set',
      message: 'Please set SILICONFLOW_API_KEY in environment variables'
    }, { status: 500 });
  }

  try {
    // Test API call with a simple book extraction
    const testFilename = '三体-刘慈欣.epub';

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
            content: 'Extract book title and author from filename. Return ONLY JSON: {"title": "...", "author": "..."}.'
          },
          {
            role: 'user',
            content: `Filename: ${testFilename}`
          }
        ],
        temperature: 0.1,
        max_tokens: maxTokens,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json({
        ok: false,
        error: 'API request failed',
        status: response.status,
        details: errorText
      }, { status: 500 });
    }

    const data = (await response.json()) as {
      choices?: {
        finish_reason?: string | null;
        message?: { content?: string | null; reasoning_content?: string | null };
      }[];
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content?.trim() ?? null;
    if (!content) {
      const finishReason = choice?.finish_reason || 'unknown';
      const reasoningChars = choice?.message?.reasoning_content?.length || 0;
      return NextResponse.json({
        ok: false,
        error: 'empty content',
        message: `empty content (finish_reason=${finishReason}, reasoning_chars=${reasoningChars}, max_tokens=${maxTokens})`,
        model,
        finishReason,
        reasoningChars,
        maxTokens,
        parsedData: data,
      }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      message: 'SiliconFlow API is working',
      model,
      maxTokens,
      testFilename,
      apiResponse: content,
      finishReason: choice?.finish_reason ?? null,
      reasoningChars: choice?.message?.reasoning_content?.length || 0,
      parsedData: data
    });

  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: 'Exception occurred',
      message: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}
