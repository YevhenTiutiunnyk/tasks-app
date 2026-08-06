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

/**
 * Сколько живёт сессия. Одно значение и для maxAge куки, и для проверки метки
 * в токене: разъедься они, кука либо переживала бы собственный токен, либо
 * умирала бы раньше него.
 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

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
  if (diff !== 0) return false;

  // Метку времени читаем только после проверки подписи: до неё содержимое
  // токена ничем не подтверждено. Без этой проверки метка клалась в токен
  // впустую, и утёкшую куку нельзя было отозвать ничем, кроме смены секрета.
  const issuedAt = Number(payload);
  if (!Number.isFinite(issuedAt)) return false;
  return Date.now() - issuedAt <= SESSION_MAX_AGE_SECONDS * 1000;
}
