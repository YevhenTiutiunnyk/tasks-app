/**
 * Код отказа по белому списку, общий для сервера и клиента.
 *
 * Отдельный файл, а не экспорт из lib/auth.ts: тот файл тянет 'server-only'
 * (через ./allowed-emails) и Pool из pg, а этот код нужен и в клиентской
 * app/login/page.tsx — импорт из lib/auth.ts там попросту не собрался бы.
 */
export const EMAIL_NOT_ALLOWED_ERROR_CODE = 'EMAIL_NOT_ALLOWED';
