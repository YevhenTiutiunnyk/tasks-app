// Рисунок иконки приложения: три полосы-задачи разной длины, стоящие в разное
// время. Общий исходник для app/icon.tsx (512×512, на неё ссылается манифест)
// и app/apple-icon.tsx (180×180, иконка на главном экране iOS) — чтобы два
// размера не разъезжались при правках.
//
// Координаты заданы в сетке 180×180 и пересчитываются под нужный размер.

const GRID = 180;
const BAR_HEIGHT = 22;
const BACKGROUND = '#171717';

const BARS = [
  { x: 32, y: 46, width: 88, color: '#ffffff' },
  { x: 58, y: 79, width: 90, color: '#2563eb' },
  // Полупрозрачность задана через rgba, а не opacity: так надёжнее
  // отрисовывается генератором картинок.
  { x: 32, y: 112, width: 66, color: 'rgba(255, 255, 255, 0.5)' },
];

/**
 * Разметка иконки под заданный размер стороны в пикселях.
 *
 * Фон непрозрачный и квадратный намеренно: скругление углов iOS делает сама,
 * а прозрачность на главном экране превращается в чёрный.
 */
export function iconArt(size: number) {
  const scale = size / GRID;

  return (
    <div
      style={{
        display: 'flex',
        position: 'relative',
        width: '100%',
        height: '100%',
        background: BACKGROUND,
      }}
    >
      {BARS.map((bar) => (
        <div
          key={`${bar.x}:${bar.y}`}
          style={{
            position: 'absolute',
            left: bar.x * scale,
            top: bar.y * scale,
            width: bar.width * scale,
            height: BAR_HEIGHT * scale,
            borderRadius: (BAR_HEIGHT / 2) * scale,
            background: bar.color,
          }}
        />
      ))}
    </div>
  );
}
