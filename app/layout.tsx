import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import ServiceWorkerRegistrar from "./sw-register";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Расписание",
  description: "Личное расписание на неделю",
  // Название под иконкой на главном экране и вид строки состояния.
  // Ссылку на манифест Next проставляет сам, раз есть app/manifest.ts.
  appleWebApp: {
    // Без capable Next не печатает mobile-web-app-capable. Safari поддерживает
    // это имя с 16.4 — с той же версии, начиная с которой на iOS вообще
    // доступны пуши, так что нижняя граница не сдвигается.
    capable: true,
    title: "Расписание",
    statusBarStyle: "default",
  },
};

// themeColor устарел в metadata с Next 14 и живёт здесь. Две записи — потому
// что globals.css переключает фон по prefers-color-scheme, и в standalone
// строка состояния должна совпадать с фоном приложения, а не спорить с ним.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f7" },
    { media: "(prefers-color-scheme: dark)", color: "#151312" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ru"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ServiceWorkerRegistrar />
        {children}
      </body>
    </html>
  );
}
