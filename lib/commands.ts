type Command =
  | { type: 'start' }
  | { type: 'send'; text: string }
  | { type: 'clean'; enabled?: boolean }
  | { type: 'unknown'; reason?: string };

export function parseCommand(raw: string): Command {
  const text = raw.trim();

  if (text.startsWith('/start')) {
    return { type: 'start' };
  }

  if (text.startsWith('/send')) {
    const payload = text.replace(/^\/send(@\w+)?/i, '').trim();
    if (!payload) {
      return { type: 'unknown', reason: 'missing-message' };
    }
    return { type: 'send', text: payload };
  }

  if (text.startsWith('/clean')) {
    const payload = text.replace(/^\/clean(@\w+)?/i, '').trim().toLowerCase();
    if (payload === 'on' || payload === '1' || payload === 'true') {
      return { type: 'clean', enabled: true };
    }
    if (payload === 'off' || payload === '0' || payload === 'false') {
      return { type: 'clean', enabled: false };
    }
    // Toggle if no argument
    return { type: 'clean' };
  }

  return { type: 'unknown' };
}
