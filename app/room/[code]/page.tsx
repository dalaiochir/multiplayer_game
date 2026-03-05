// app/room/[code]/page.tsx
import GameCanvas from "./GameCanvas";

export default async function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return (
    <main style={{ padding: 16, fontFamily: "system-ui" }}>
      <h2>Room: {code}</h2>
      <GameCanvas roomCode={code.toUpperCase()} />
    </main>
  );
}