import type { Metadata } from "next";
import "./globals.css";
import { themeInitScript } from "../lib/theme.mjs";
export const metadata: Metadata = {
  title: "TokenGarden · 用量监测",
  description: "跨设备 AI Token 用量与每日活动热力图",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
