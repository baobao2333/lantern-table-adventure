import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "灯火之下 · 新手跑团",
  description: "带上骰子，走进故事。原创中文短篇冒险与透明的 D&D SRD 5.1 入门规则。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
