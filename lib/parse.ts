import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ParseResultSchema } from './schema';
import type { ParseResult, Settings, Task } from './types';

export interface ParseInput {
  text: string;
  today: string;               // 'YYYY-MM-DD'
  timezone: string;            // например 'Europe/Kyiv'
  tasks: Task[];               // задачи трёх недель: текущая и соседние
  settings: Settings;
}

function minutesToClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function describeTask(task: Task): string {
  const when = task.allDay
    ? 'весь день'
    : `${minutesToClock(task.startMinute ?? 0)}, ${task.durationMinutes ?? 60} мин`;
  // Дата недельной или месячной задачи — это якорь периода (понедельник или
  // первое число), а не день, на который она назначена. Без пометки модель
  // увидит «дата = понедельник» и решит, что задача привязана к понедельнику.
  const period =
    task.horizon === 'week' ? ' [на неделю]' : task.horizon === 'month' ? ' [на месяц]' : '';
  return `- id=${task.id} | ${task.date}${period} | ${when} | ${task.title}` +
    (task.categoryId ? ` | категория: ${task.categoryId}` : '');
}

function buildSystemPrompt(input: ParseInput): string {
  const { settings } = input;
  return [
    'Ты превращаешь надиктованную фразу в операции над задачами пользователя — дневным расписанием и недельными/месячными чеклистами.',
    'Отвечай строго по схеме. Ничего не выдумывай.',
    '',
    `Сегодня: ${input.today}, часовой пояс ${input.timezone}. Неделя начинается с понедельника.`,
    `Рабочие часы: ${minutesToClock(settings.workStartMinute)}–${minutesToClock(settings.workEndMinute)}.`,
    settings.aboutMe ? `Про пользователя: ${settings.aboutMe}` : '',
    '',
    `Доступные категории (categoryId): ${settings.categories.map((c) => `${c.id} (${c.name})`).join(', ')}.`,
    'Новые категории не придумывай. Если ни одна не подходит — оставь categoryId равным null.',
    '',
    'Текущие задачи (расписание и чеклисты):',
    input.tasks.length ? input.tasks.map(describeTask).join('\n') : '(пусто)',
    '',
    'Правила:',
    '1. Ссылаться на существующую задачу можно только по её id из списка выше. Если подходящей задачи нет — операцию не создавай, объясни это в reply.',
    '2. Время задаётся в минутах от полуночи (startMinute), длительность — в минутах (durationMinutes).',
    '3. Если понятен день, но не понятен час: всё равно создай операцию с allDay=true, startMinute=null, durationMinutes=null, и добавь её индекс в needsTime с коротким вопросом.',
    '4. Если не понятен даже день — всё равно создай операцию: date = сегодня, allDay=true, startMinute=null, durationMinutes=null, и добавь её индекс в needsTime. В вопросе спроси и день, и время («Когда сходить в спортзал?»). Пользователь ответит одной фразой вроде «завтра в 8 утра, час», и уточнение проставит и дату, и время.',
    '5. Длительность оценивай по смыслу задачи. Если оценить нельзя — ставь 60.',
    '6. Размытое время («утром», «после работы», «вечером») трактуй по рабочим часам и описанию пользователя. Такие задачи в needsTime НЕ добавляй.',
    '7. Повторяющуюся задачу («каждый вторник») оформляй операцией create с заполненным полем recurrence; поле date при этом null.',
    '8. Горизонт при создании: если дело названо без дня, но с периодом («на этой неделе», «на следующей неделе», «в этом месяце») — ставь horizon="week" или "month", date — любую дату внутри периода, allDay=true, startMinute=null, durationMinutes=null. Такие задачи в needsTime НЕ добавляй: у них нет времени по замыслу. Во всех остальных случаях при создании — horizon="day".',
    'Горизонт при правке переходит вместе с датой, а не отдельно от неё — операция ставит оба поля разом или не трогает ни одно. Если фраза называет существующей задаче конкретный день («сделаю кран в четверг», «в четверг в 10») — это переход в дневной горизонт, даже если раньше у задачи была неделя или месяц: ставь horizon="day" и date равной этому дню. Один только час, без дня («почини кран в 10»), днём не считается: у недельной и месячной задачи дня нет, и взять его неоткуда — в таком случае horizon оставляй null. Если фраза называет задаче другой период («перенеси кран на следующий месяц») — ставь новый horizon и date — любую дату внутри НОВОГО периода, а не прежнюю дату задачи. Если фраза не называет ни дня, ни периода — horizon оставляй null, это значит «не трогать», как и у остальных полей правки.',
    '9. reply — одна короткая фраза по-русски о том, что ты сделал или чего не понял.',
  ].filter(Boolean).join('\n');
}

/**
 * Клиент приходит готовым, с ключом того, кто спрашивает, отдельным первым
 * аргументом — не полем в `input`. Строка ключа не должна ездить в объекте,
 * который при отладке естественно захочется распечатать целиком.
 */
export async function parseCommand(client: Anthropic, input: ParseInput): Promise<ParseResult> {
  const response = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 16000,
    system: buildSystemPrompt(input),
    output_config: {
      effort: 'medium',
      format: zodOutputFormat(ParseResultSchema),
    },
    messages: [{ role: 'user', content: input.text }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Модель отказалась отвечать на этот запрос');
  }
  if (!response.parsed_output) {
    throw new Error('Модель вернула ответ не по схеме');
  }
  return response.parsed_output as ParseResult;
}
