import type { Metadata, Viewport } from "next";
import { Fredoka, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const fredoka = Fredoka({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-fredoka",
});

export const metadata: Metadata = {
  title: "Tok Chicken — stemrun",
  description: "Zeg «tok» om vooruit te gaan en «taaaak» om te springen in dit kleine browserspelletje.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#7ecbff",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="nl"
      className={`${geistSans.variable} ${geistMono.variable} ${fredoka.variable} h-full antialiased`}
    >
      <body
        className={`${fredoka.className} min-h-full touch-manipulation flex flex-col overflow-hidden overscroll-none antialiased [-webkit-tap-highlight-color:transparent]`}
      >
        {children}
      </body>
    </html>
  );
}
