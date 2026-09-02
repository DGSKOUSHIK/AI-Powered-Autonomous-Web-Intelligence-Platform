import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Web Intel — Autonomous Web Intelligence",
  description:
    "Paste a URL and a goal. An autonomous agent crawls, reasons, and answers — with citations and history.",
  applicationName: "Web Intel",
  authors: [{ name: "Web Intel" }],
  openGraph: {
    title: "Web Intel — Autonomous Web Intelligence",
    description:
      "Paste a URL and a goal. An autonomous agent crawls, reasons, and answers — with citations and history.",
    type: "website",
    siteName: "Web Intel",
  },
  twitter: {
    card: "summary",
    title: "Web Intel — Autonomous Web Intelligence",
    description:
      "An autonomous agent crawls, reasons, and answers — with citations and history.",
  },
  robots: { index: true, follow: false },
  icons: {
    icon: "/favicon.ico",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0b0f",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <div className="aurora" />
        <div className="grid-overlay" />
        {children}
      </body>
    </html>
  );
}