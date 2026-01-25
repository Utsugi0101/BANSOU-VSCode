const SECRET_PATTERNS: RegExp[] = [
  /OPENAI_API_KEY\s*=\s*.+/gi,
  /UNDERSTANDING_TOKEN_SECRET\s*=\s*.+/gi,
  /(api|access|secret|token|password)[-_ ]?key\s*=\s*.+/gi,
  /(api|access|secret|token|password)[-_ ]?key\s*:\s*.+/gi,
  /Bearer\s+[A-Za-z0-9_\-\.=]+/g,
  /sk-[A-Za-z0-9_\-]{10,}/g,
];

export function redactSensitive(diffText: string): string {
  let redacted = diffText;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}
