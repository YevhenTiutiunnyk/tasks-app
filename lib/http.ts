import { NextResponse } from 'next/server';

/** Разбирает тело запроса. null — тело не разобралось, роут отвечает 400. */
export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}
