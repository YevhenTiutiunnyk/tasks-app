import { createAuthClient } from 'better-auth/react';

// baseURL не задаётся намеренно: клиент и сервер на одном домене, и адрес
// приложения не должен попадать в код — репозиторий публичный.
export const authClient = createAuthClient();
