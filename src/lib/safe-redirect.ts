function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code >= 0 && code <= 31) || code === 127) {
      return true;
    }
  }

  return false;
}

// 仅允许站内相对路径，拒绝协议跳转与协议相对 URL。
export function sanitizeInternalRedirect(
  target: string | null | undefined,
  fallback = '/'
): string {
  if (!target) {
    return fallback;
  }

  const trimmed = target.trim();
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    hasControlCharacters(trimmed)
  ) {
    return fallback;
  }

  try {
    const parsed = new URL(trimmed, 'http://localhost');
    if (parsed.origin !== 'http://localhost' || !parsed.pathname.startsWith('/')) {
      return fallback;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch (error) {
    return fallback;
  }
}
