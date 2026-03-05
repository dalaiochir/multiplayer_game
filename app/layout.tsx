// app/layout.tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pac-Duel",
  description: "2-player real-time Pac-Man-like duel",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="mn">
      <body style={{ margin: 0, fontFamily: "system-ui" }}>{children}</body>
    </html>
  );
}