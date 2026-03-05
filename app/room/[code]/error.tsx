// app/room/[code]/error.tsx
"use client";

import { useEffect } from "react";

export default function RoomError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Room route error:", error);
  }, [error]);

  return (
    <main style={{ padding: 16, fontFamily: "system-ui" }}>
      <h2>Room crashed 😵</h2>
      <p style={{ whiteSpace: "pre-wrap" }}>
        {error?.message ?? "Unknown client error"}
      </p>

      {error?.stack && (
        <pre
          style={{
            marginTop: 12,
            padding: 12,
            background: "#111",
            color: "#eee",
            borderRadius: 8,
            overflow: "auto",
            maxHeight: 320,
          }}
        >
          {error.stack}
        </pre>
      )}

      <button onClick={() => reset()} style={{ marginTop: 12, padding: "8px 12px" }}>
        Retry
      </button>
    </main>
  );
}