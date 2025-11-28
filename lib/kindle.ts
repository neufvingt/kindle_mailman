type KindleHighlight = {
  text: string;
  note?: string;
  color?: string;
  page?: string;
  location?: string;
};

export type KindleNotebook = {
  title: string;
  author?: string;
  highlights: KindleHighlight[];
};

function decodeEntities(text: string) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cleanText(html: string) {
  const withoutTags = html.replace(/<[^>]*>/g, ' ');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

function extractTitle(html: string) {
  const titleMatch =
    html.match(/class=["'](?:kp-notebook-title|bookTitle)["'][^>]*>([\s\S]*?)<\/div>/i) ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  return cleanText(titleMatch?.[1] ?? 'Kindle Notebook');
}

function extractAuthor(html: string) {
  const authorMatch =
    html.match(/class=["'](?:authors|kp-notebook-subtitle)["'][^>]*>([\s\S]*?)<\/div>/i) ||
    html.match(/<meta[^>]*name=["']author["'][^>]*content=["']([^"']*)["'][^>]*>/i);

  const author = authorMatch?.[1];
  return author ? cleanText(author) : undefined;
}

function extractLocation(heading: string) {
  const locationMatch = heading.match(/Location\s+([\d-]+)/i);
  return locationMatch?.[1];
}

function extractPage(heading: string) {
  const pageMatch = heading.match(/Page\s+([\d-]+)/i);
  return pageMatch?.[1];
}

function extractColor(heading: string) {
  const colorMatch = heading.match(/\((Yellow|Blue|Pink|Orange|Green)\)/i);
  return colorMatch?.[1];
}

export function parseKindleHtml(html: string): KindleNotebook {
  const highlights: KindleHighlight[] = [];
  const notebookTitle = extractTitle(html);
  const notebookAuthor = extractAuthor(html);
  const headingBlock =
    /<div[^>]*class=["']noteHeading["'][^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class=["']noteText["'][^>]*>([\s\S]*?)<\/div>/gi;

  let match: RegExpExecArray | null;
  while ((match = headingBlock.exec(html)) !== null) {
    const heading = cleanText(match[1]);
    const body = cleanText(match[2]);
    const location = extractLocation(heading);
    const page = extractPage(heading);
    const color = extractColor(heading);

    if (/^note\b/i.test(heading)) {
      const target =
        (location && [...highlights].reverse().find((item) => item.location === location)) ||
        highlights[highlights.length - 1];

      if (target) {
        target.note = body;
        if (!target.page && page) target.page = page;
      } else {
        highlights.push({ text: body, note: undefined, color, page, location });
      }

      continue;
    }

    highlights.push({ text: body, note: undefined, color, page, location });
  }

  if (highlights.length === 0) {
    const bodyText = cleanText(html);
    if (bodyText) {
      highlights.push({ text: bodyText });
    }
  }

  return {
    title: notebookTitle,
    author: notebookAuthor,
    highlights,
  };
}

export function kindleNotebookToMarkdown(notebook: KindleNotebook) {
  const lines = [`# ${notebook.title || 'Kindle Notebook'}`];

  if (notebook.author) {
    lines.push(`_by ${notebook.author}_`);
  }

  lines.push('');

  notebook.highlights.forEach((item, index) => {
    const meta = [item.color, item.page ? `Page ${item.page}` : null, item.location ? `Loc ${item.location}` : null]
      .filter(Boolean)
      .join(' · ');

    const label = meta ? ` (${meta})` : '';
    lines.push(`${index + 1}. ${item.text}${label ? ` — ${label}` : ''}`);

    if (item.note) {
      lines.push(`   > ${item.note}`);
    }
  });

  return lines.join('\n');
}
