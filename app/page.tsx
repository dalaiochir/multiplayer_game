// app/page.tsx
import Link from "next/link";

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export default function Home() {
  const code = makeCode();
  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Pac-Duel (2P)</h1>
      <p>Room code-оор орж, 2 тоглогч ready өгвөл эхэлнэ.</p>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Link href={`/room/${code}`}>Шинэ room нээх: {code}</Link>
      </div>
      <p style={{ marginTop: 16 }}>
        Шууд URL: <code>/room/ABCD</code>
      </p>
    </main>
  );
}