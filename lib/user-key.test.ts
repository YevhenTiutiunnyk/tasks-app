import { describe, expect, it, vi } from 'vitest';
import { decryptApiKey, encryptApiKey } from './user-key';

const USER = 'zz-user-1';
const OTHER = 'zz-user-2';
const KEY = 'sk-ant-zz-совершенно-ненастоящий-ключ-для-теста';

describe('encryptApiKey / decryptApiKey', () => {
  it('расшифровывает то, что зашифровало', () => {
    expect(decryptApiKey(USER, encryptApiKey(USER, KEY))).toBe(KEY);
  });

  it('не расшифровывает чужой строкой владельца', () => {
    // AAD. Без него шифротекст, переставленный в чужую строку, расшифровался
    // бы молча и правильно — в чужой ключ.
    expect(decryptApiKey(OTHER, encryptApiKey(USER, KEY))).toBeNull();
  });

  it('не расшифровывает при испорченном шифротексте', () => {
    const sealed = encryptApiKey(USER, KEY);
    sealed.ciphertext[0] ^= 0xff;
    expect(decryptApiKey(USER, sealed)).toBeNull();
  });

  it('не расшифровывает при испорченном теге', () => {
    const sealed = encryptApiKey(USER, KEY);
    sealed.tag[0] ^= 0xff;
    expect(decryptApiKey(USER, sealed)).toBeNull();
  });

  it('на одном и том же ключе даёт разные шифротексты', () => {
    // Ловит захардкоженный вектор инициализации. Круговой прогон его
    // пропускает насквозь: обе стороны ошибаются одинаково.
    const a = encryptApiKey(USER, KEY);
    const b = encryptApiKey(USER, KEY);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('падает громко без KEY_ENCRYPTION_KEY', () => {
    vi.stubEnv('KEY_ENCRYPTION_KEY', '');
    expect(() => encryptApiKey(USER, KEY)).toThrow(/KEY_ENCRYPTION_KEY/);
    vi.unstubAllEnvs();
  });

  it('падает громко при неверной длине KEY_ENCRYPTION_KEY', () => {
    vi.stubEnv('KEY_ENCRYPTION_KEY', Buffer.alloc(16, 1).toString('base64'));
    expect(() => encryptApiKey(USER, KEY)).toThrow(/32/);
    vi.unstubAllEnvs();
  });

  it('отсутствие KEY_ENCRYPTION_KEY при расшифровке — авария, а не «ключ не читается»', () => {
    // Отличие важное: null означает «ключ испортился, введи заново», и если
    // забытая переменная окружения выглядела бы так же, все пользователи
    // получили бы предложение ввести ключ заново вместо внятной аварии.
    const sealed = encryptApiKey(USER, KEY);
    vi.stubEnv('KEY_ENCRYPTION_KEY', '');
    expect(() => decryptApiKey(USER, sealed)).toThrow(/KEY_ENCRYPTION_KEY/);
    vi.unstubAllEnvs();
  });
});
