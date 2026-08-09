'use client';

import { useEffect, useState } from 'react';

/**
 * Ключ VAPID приходит в base64url, а pushManager.subscribe ждёт байты.
 *
 * Буфер создаётся явно: BufferSource требует именно ArrayBuffer, а
 * `new Uint8Array(длина)` типизируется как ArrayBufferLike и не подходит.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type State = 'loading' | 'unsupported' | 'off' | 'on' | 'denied';

export default function PushToggle() {
  const [state, setState] = useState<State>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // Все ветки внутри одной асинхронной функции: правило
    // react-hooks/set-state-in-effect запрещает менять состояние прямо
    // в теле эффекта, и оно право — синхронный setState здесь вызвал бы
    // лишнюю перерисовку сразу после монтирования.
    void (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setState('unsupported');
        return;
      }
      if (Notification.permission === 'denied') {
        setState('denied');
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      setState(subscription ? 'on' : 'off');
    })();
  }, []);

  async function enable() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      // Разрешение можно спрашивать только из обработчика нажатия — iOS
      // молча откажет, если позвать это само по себе при загрузке.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(
          process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
        ),
      });

      const response = await fetch('/api/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!response.ok) {
        // Подписка в браузере есть, а на сервере нет — уведомления не придут.
        // Честнее откатить, чем показать «включено» и молчать.
        await subscription.unsubscribe();
        setError('Сервер не принял подписку');
        setState('off');
        return;
      }
      setState('on');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не получилось включить');
      setState('off');
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await fetch('/api/push', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      setState('off');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не получилось выключить');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Напоминания</h2>

      {state === 'loading' && <p className="text-xs text-muted">Проверяю…</p>}

      {state === 'unsupported' && (
        <p className="text-xs text-muted">
          Этот браузер не умеет уведомления. На iPhone они работают только
          в приложении, добавленном на главный экран.
        </p>
      )}

      {state === 'denied' && (
        <p className="text-xs text-muted">
          Уведомления запрещены в настройках устройства. Включить их обратно
          можно только там — из приложения повторно спросить нельзя.
        </p>
      )}

      {(state === 'off' || state === 'on') && (
        <div className="flex items-center gap-3">
          <button
            onClick={state === 'on' ? disable : enable}
            disabled={busy}
            className="rounded-md bg-ink px-3 py-1.5 text-sm text-paper disabled:opacity-30"
          >
            {state === 'on' ? 'Выключить' : 'Включить'}
          </button>
          <span className="text-xs text-muted">
            {state === 'on' ? 'Включены на этом устройстве' : 'Выключены'}
          </span>
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}

      <p className="text-xs text-muted">
        Подписка живёт, пока значок остаётся на главном экране. Если удалить
        и добавить его заново, уведомления надо включить ещё раз.
      </p>
    </section>
  );
}
