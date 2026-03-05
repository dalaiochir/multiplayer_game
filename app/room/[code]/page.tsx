// app/room/[code]/page.tsx
import GameCanvas from "./GameCanvas";

export default function RoomPage({ params }: { params: { code: string } }) {
  return (
    <main style={{ padding: 16, fontFamily: "system-ui" }}>
      <h2>Room: {params.code.toUpperCase()}</h2>
      <GameCanvas roomCode={params.code.toUpperCase()} />
    </main>
  );
}