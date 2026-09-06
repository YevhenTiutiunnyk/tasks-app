'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Chevron } from '@/components/Chevron';
import { addDays } from '@/lib/dates';
import { formatWeekRange } from '@/lib/format';
import type { PlannedTask, WeeklyReport } from '@/lib/report';

interface ReportData {
  weekStart: string | null;
  report: WeeklyReport | null;
}

// Порядок списков — по важности: сначала что получилось, потом что нет.
const SECTIONS: { key: keyof WeeklyReport; title: string }[] = [
  { key: 'done', title: 'Выполнено' },
  { key: 'notDone', title: 'Не выполнено' },
  { key: 'postponed', title: 'Перенесено' },
  { key: 'removed', title: 'Убрано' },
  { key: 'extra', title: 'Сделано сверх плана' },
];

/**
 * Список отчёта. Объявлен на уровне модуля, а не внутри страницы:
 * компонент в теле другого компонента React пересоздаёт при каждом
 * рендере родителя, размонтируя поддерево вместо обновления.
 */
function List({ title, items }: { title: string; items: PlannedTask[] }) {
  // Пустые списки не показываются вовсе. Заголовок «Убрано» без единой
  // строки на каждом экране — шум, который приучает отчёт не читать.
  if (items.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{title}</h2>
      <ul>
        {items.map((item) => (
          <li key={item.id} className="border-t border-hairline py-2.5 text-[15px]">
            {item.title}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Count({ value, label }: { value: number; label: string }) {
  return (
    <span className="flex flex-col">
      <span className="text-xl font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted">{label}</span>
    </span>
  );
}

export default function Report() {
  const router = useRouter();
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/report');
      if (response.status === 401) {
        router.push('/login');
        return;
      }
      if (!response.ok) {
        setError('Не получилось загрузить отчёт');
        return;
      }
      setData(await response.json());
      setError('');
    } catch {
      setError('Нет связи с сервером');
    }
  }, [router]);

  useEffect(() => {
    void (async () => { await load(); })();
  }, [load]);

  if (!data) {
    return <main className="p-5 text-sm opacity-60">{error || 'Загружаю…'}</main>;
  }

  const header = (
    <div className="flex items-center gap-3">
      <Link
        href="/"
        className="flex h-11 shrink-0 touch-manipulation items-center gap-1.5 rounded-lg border border-hairline bg-surface pl-2.5 pr-4 text-[13px] text-ink hover:bg-hairline active:bg-hairline"
      >
        <Chevron direction="left" />
        к расписанию
      </Link>
      <h1 className="text-lg font-semibold">Итоги недели</h1>
    </div>
  );

  if (!data.weekStart || !data.report) {
    return (
      <main className="mx-auto max-w-md space-y-5 p-5">
        {header}
        <p className="text-sm text-muted">
          Первый отчёт придёт в понедельник утром. Сейчас сравнивать не с чем:
          приложение записывает, что запланировано на неделю, и через неделю
          показывает, что из этого вышло.
        </p>
      </main>
    );
  }

  const { report, weekStart } = data;

  return (
    <main className="mx-auto max-w-md space-y-5 p-5">
      {header}

      <p className="text-sm text-muted">{formatWeekRange(weekStart, addDays(weekStart, 6))}</p>

      <div className="flex gap-6 border-y border-hairline py-3">
        <Count value={report.done.length} label="сделано" />
        <Count value={report.postponed.length} label="перенесено" />
        <Count value={report.notDone.length} label="не сделано" />
      </div>

      {SECTIONS.map(({ key, title }) => (
        <List key={key} title={title} items={report[key]} />
      ))}

      {report.monthLeft.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">В этом месяце осталось</h2>
          {/* Не часть недельного счёта: месячные дела живут своим сроком,
              и попади они в цифры выше — «не сделано» врало бы каждую неделю
              до конца месяца. */}
          <ul>
            {report.monthLeft.map((item) => (
              <li key={item.id} className="border-t border-hairline py-2.5 text-[15px]">
                {item.title}
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}
    </main>
  );
}
