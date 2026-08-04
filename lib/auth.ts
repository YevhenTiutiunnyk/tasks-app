const encoder = new TextEncoder();

async function hmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Buffer.from(sig).toString('base64url');
}

/** Токен вида "<время выдачи>.<подпись>". */
export async function signSession(secret: string): Promise<string> {
  const payload = String(Date.now());
  return `${payload}.${await hmac(payload, secret)}`;
}

export async function verifySession(token: string, secret: string): Promise<boolean> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const given = token.slice(dot + 1);
  const expected = await hmac(payload, secret);
  if (given.length !== expected.length) return false;
  // Сравнение за постоянное время: не даём подобрать подпись по времени ответа.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
