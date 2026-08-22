import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Зашифрованный ключ ровно в том виде, в каком лежит в базе. */
export interface SealedKey {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Ключ шифрования читается при первом использовании, а не на уровне модуля.
 * На уровне модуля одна незаполненная переменная роняла бы импорт в любом
 * тесте, который этого модуля даже не касается.
 */
function encryptionKey(): Buffer {
  const raw = process.env.KEY_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'KEY_ENCRYPTION_KEY не задана. Без неё ключи Anthropic негде шифровать; ' +
        'нужно 32 случайных байта в base64.',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `KEY_ENCRYPTION_KEY должна быть ${KEY_BYTES} байта в base64, получено ${key.length}.`,
    );
  }
  return key;
}

export function encryptApiKey(userId: string, plaintext: string): SealedKey {
  // Свежий вектор на каждый вызов. Постоянный вектор в GCM — это не «слабее»,
  // а полная потеря стойкости при двух сообщениях на одном ключе.
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  // Владелец в дополнительных данных: шифротекст, переставленный в чужую
  // строку, не расшифруется вовсе, вместо того чтобы молча стать чужим ключом.
  cipher.setAAD(Buffer.from(userId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

/**
 * Возвращает null, а не бросает: «ключ не читается» — штатное состояние
 * (сменился или потерян KEY_ENCRYPTION_KEY, побились байты, подменён
 * владелец), и вызывающему нужна развилка, а не исключение.
 */
export function decryptApiKey(userId: string, sealed: SealedKey): string | null {
  // Намеренно ВНЕ try: отсутствие или неверная длина переменной окружения —
  // авария развёртывания, а не испорченный ключ. Попади она в общий catch —
  // забытая переменная выглядела бы для всех как «введите ключ заново».
  const key = encryptionKey();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, sealed.iv);
    decipher.setAAD(Buffer.from(userId, 'utf8'));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([
      decipher.update(sealed.ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
