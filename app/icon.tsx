import { ImageResponse } from 'next/og';
import { iconArt } from '@/lib/icon-art';

export const size = { width: 512, height: 512 };
export const contentType = 'image/png';

// На неё ссылается манифест. Отдаётся по пути /icon — хеш Next кладёт в query,
// так что в матчере proxy исключение называется именно `icon`.
export default function Icon() {
  return new ImageResponse(iconArt(size.width), size);
}
