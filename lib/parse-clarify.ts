import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { isValidIsoDate } from './dates';

const SlotSchema = z.object({
  date: z.string().nullable(),
  startMinute: z.number().int().nullable(),
  durationMinutes: z.number().int().nullable(),
});

const client = new Anthropic();

export interface Slot {
  date: string;
  startMinute: number;
  durationMinutes: number;
}

/** Возвращает конкретный слот или null, если фразу разобрать не удалось. */
export async function parseClarification(
  text: string,
  currentDate: string,
  today: string,
): Promise<Slot | null> {
  const response = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 4000,
    system: [
      'Пользователь уточняет, когда должна пройти уже созданная задача.',
      `Сегодня ${today}. Сейчас задача стоит на ${currentDate} без конкретного времени.`,
      'Верни дату (оставь ту же, если пользователь её не менял), время начала в минутах от полуночи и длительность в минутах.',
      'Если длительность не названа — поставь 60. Если фразу разобрать нельзя — верни все поля null.',
    ].join('\n'),
    output_config: { effort: 'low', format: zodOutputFormat(SlotSchema) },
    messages: [{ role: 'user', content: text }],
  });

  const parsed = response.parsed_output;
  if (!parsed || parsed.startMinute === null) return null;

  const date = parsed.date ?? currentDate;
  if (!isValidIsoDate(date)) return null;
  if (parsed.startMinute < 0 || parsed.startMinute > 1439) return null;

  const durationMinutes = parsed.durationMinutes ?? 60;
  if (durationMinutes <= 0 || durationMinutes > 24 * 60) return null;

  return { date, startMinute: parsed.startMinute, durationMinutes };
}
