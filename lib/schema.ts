import { z } from 'zod';

const RecurrenceRule = z.object({
  weekdays: z.array(z.number().int().min(1).max(7)),
  startsOn: z.string(),
  endsOn: z.string().nullable(),
});

const CreateOperation = z.object({
  type: z.literal('create'),
  title: z.string(),
  date: z.string().nullable(),
  startMinute: z.number().int().nullable(),
  durationMinutes: z.number().int().nullable(),
  allDay: z.boolean().nullable(),
  categoryId: z.string().nullable(),
  recurrence: RecurrenceRule.nullable(),
});

const UpdateOperation = z.object({
  type: z.literal('update'),
  taskId: z.string(),
  title: z.string().nullable(),
  date: z.string().nullable(),
  startMinute: z.number().int().nullable(),
  durationMinutes: z.number().int().nullable(),
  allDay: z.boolean().nullable(),
  categoryId: z.string().nullable(),
});

const DeleteOperation = z.object({
  type: z.literal('delete'),
  taskId: z.string(),
});

export const ParseResultSchema = z.object({
  operations: z.array(z.discriminatedUnion('type', [CreateOperation, UpdateOperation, DeleteOperation])),
  needsTime: z.array(z.object({ operationIndex: z.number().int(), question: z.string() })),
  reply: z.string(),
});
