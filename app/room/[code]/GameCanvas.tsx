"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PartySocket from "partysocket";

type Vec = { x: number; y: number };
type Player = { id: string; name: string; alive: boolean; pos: Vec; wallsLeft: number; breaksLeft: number; pushCdMs: number; ready: boolean; };
type Guard = { id: string; pos: Vec };
type Wall = { id: string; ownerId: string; pos: Vec };

const GRID_W = 25;
const GRID_H = 19;
const TILE = 24;

type TickSnap = {
  tMs: number;
  players: Player[];
  guards: Guard[];
  walls: Wall[];
};

const snapsRef = useRef<TickSnap[]>([]);
const wallsRef = useRef<Wall[]>([]);
const phaseRef = useRef<"lobby" | "playing" | "over">("lobby");

// render smoothing
const interpDelayMs = 120; // 80~160 хооронд тохируулж болно
export default function GameCanvas({ roomCode }: { roomCode: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [name, setName] = useState("Player");
  const [ready, setReady] = useState(false);
  const [connState, setConnState] = useState<"disconnected" | "connected">("disconnected");

  const [players, setPlayers] = useState<Player[]>([]);
  const [guards, setGuards] = useState<Guard[]>([]);
  const [walls, setWalls] = useState<Wall[]>([]);

function getCellFromMouse(e: React.MouseEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  return { x: Math.floor(x / TILE), y: Math.floor(y / TILE) };
}

  const [phase, setPhase] = useState<"lobby" | "playing" | "over">("lobby");
  const [winnerId, setWinnerId] = useState<string | null>(null);

  const host = process.env.NEXT_PUBLIC_PARTYKIT_HOST!;
  const socket = useMemo(() => {
    if (!host) return null;
    return new PartySocket({
      host,
      room: roomCode,
      // PartyKit "party" name defaults to project; if you deploy multiple parties, you can set party: "game"
      // party: "main"
    });
  }, [host, roomCode]);

  // send helpers
  const send = (obj: any) => socket?.send(JSON.stringify(obj));

  // input state
  const moveRef = useRef<Vec>({ x: 0, y: 0 });
  const myIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!socket) return;

    socket.addEventListener("open", () => setConnState("connected"));
    socket.addEventListener("close", () => setConnState("disconnected"));

    socket.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);

      if (msg.type === "welcome") {
    myIdRef.current = msg.myId;
    return;
  }

      if (msg.type === "room_state") {
  const st = msg.state;
  setPhase(st.phase);
  phaseRef.current = st.phase;

  const pls = Object.values(st.players ?? {});
  setPlayers(pls);
  setGuards(st.guards ?? []);
  setWalls(st.walls ?? []);
  wallsRef.current = st.walls ?? [];
}
      if (msg.type === "start") {
  setPhase("playing");
  phaseRef.current = "playing";
  setWinnerId(null);
}

if (msg.type === "game_over") {
  setPhase("over");
  phaseRef.current = "over";
  setWinnerId(msg.winnerId ?? null);
}
      if (msg.type === "tick") {
  const snap: TickSnap = {
    tMs: msg.tMs,
    players: msg.players ?? [],
    guards: msg.guards ?? [],
    walls: msg.walls ?? [],
  };

  // push snap
  snapsRef.current.push(snap);
  // keep last ~2 seconds worth (20Hz => 40 snaps)
  if (snapsRef.current.length > 60) snapsRef.current.splice(0, snapsRef.current.length - 60);

  // walls are discrete; keep latest for clicks + rendering
  wallsRef.current = snap.walls;

  // (Optional) state updates for UI panels only (not needed for rendering)
  setPlayers(snap.players);
  setGuards(snap.guards);
  setWalls(snap.walls);
}
      if (msg.type === "game_over") {
        setPhase("over");
        setWinnerId(msg.winnerId ?? null);
      }
    });

    // identify my id: PartySocket doesn't expose conn id directly; we infer by name match after join.
    // For MVP: we set myIdRef after first room_state by matching player name (good enough for local tests).
    return () => socket.close();
  }, [socket]);

  useEffect(() => {
    // basic key handling
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowUp" || e.key === "w") moveRef.current = { x: 0, y: -1 };
      if (e.key === "ArrowDown" || e.key === "s") moveRef.current = { x: 0, y: 1 };
      if (e.key === "ArrowLeft" || e.key === "a") moveRef.current = { x: -1, y: 0 };
      if (e.key === "ArrowRight" || e.key === "d") moveRef.current = { x: 1, y: 0 };

      if (e.key === " ") send({ type: "push" });
      if (e.key === "1") {
        // place wall at my current tile + facing
        const me = players.find(p => p.name === name) ?? players[0];
        if (!me) return;
        const dir = moveRef.current;
        const cell = { x: me.pos.x + dir.x, y: me.pos.y + dir.y };
        send({ type: "place_wall", cell });
      }
      if (e.key === "2") {
        // break nearest own wall (simple)
        const me = players.find(p => p.name === name) ?? players[0];
        if (!me) return;
        const owned = walls.filter(w => w.ownerId === me.id);
        if (owned.length > 0) send({ type: "break_wall", wallId: owned[0].id });
      }
    }
    function onKeyUp() {
      moveRef.current = { x: 0, y: 0 };
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [players, walls, name]);

  useEffect(() => {
    // send move at ~20Hz
    const id = setInterval(() => {
      if (phase !== "playing") return;
      send({ type: "input", move: moveRef.current });
    }, 50);
    return () => clearInterval(id);
  }, [phase, socket]);

  useEffect(() => {
  const canvas = canvasRef.current;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  function lerp(a: number, b: number, t: number) {
    return a + (b - a) * t;
  }

  function findBracketingSnaps(renderT: number) {
    const snaps = snapsRef.current;
    if (snaps.length < 2) return null;

    // ensure snaps are sorted by tMs (they should be)
    // find a,b so that a.tMs <= renderT <= b.tMs
    let a: TickSnap | null = null;
    let b: TickSnap | null = null;

    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].tMs <= renderT) {
        a = snaps[i];
        b = snaps[i + 1] ?? snaps[i];
        break;
      }
    }

    // renderT is older than oldest snap => clamp
    if (!a) {
      a = snaps[0];
      b = snaps[1];
    }
    return { a, b };
  }

  function interpEntities<T extends { id: string; pos: { x: number; y: number } }>(
    aList: T[],
    bList: T[],
    alpha: number
  ) {
    const bMap = new Map<string, T>();
    for (const e of bList) bMap.set(e.id, e);

    const out: Array<{ id: string; x: number; y: number }> = [];
    for (const ea of aList) {
      const eb = bMap.get(ea.id) ?? ea;
      out.push({
        id: ea.id,
        x: lerp(ea.pos.x, eb.pos.x, alpha),
        y: lerp(ea.pos.y, eb.pos.y, alpha),
      });
    }
    return out;
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // grid
    ctx.globalAlpha = 0.25;
    for (let x = 0; x <= GRID_W; x++) {
      ctx.beginPath();
      ctx.moveTo(x * TILE, 0);
      ctx.lineTo(x * TILE, GRID_H * TILE);
      ctx.stroke();
    }
    for (let y = 0; y <= GRID_H; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * TILE);
      ctx.lineTo(GRID_W * TILE, y * TILE);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // walls (no interpolation)
    const wallsNow = wallsRef.current;
    for (const w of wallsNow) {
      ctx.fillRect(w.pos.x * TILE + 2, w.pos.y * TILE + 2, TILE - 4, TILE - 4);
    }

    // interpolate players/guards if possible
    const snaps = snapsRef.current;
    if (snaps.length >= 2 && phaseRef.current === "playing") {
      const latestT = snaps[snaps.length - 1].tMs;
      const renderT = latestT - interpDelayMs;

      const bracket = findBracketingSnaps(renderT);
      if (bracket) {
        const { a, b } = bracket;
        const dt = Math.max(1, b.tMs - a.tMs);
        const alpha = Math.max(0, Math.min(1, (renderT - a.tMs) / dt));

        const ipPlayers = interpEntities(a.players, b.players, alpha);
        const ipGuards = interpEntities(a.guards, b.guards, alpha);

        // guards
        for (const g of ipGuards) {
          ctx.beginPath();
          ctx.arc(g.x * TILE + TILE / 2, g.y * TILE + TILE / 2, TILE * 0.35, 0, Math.PI * 2);
          ctx.fill();
        }

        // players (need alive/name; take from a.players as baseline)
        const aMap = new Map(a.players.map(p => [p.id, p] as const));
        for (const p of ipPlayers) {
          const meta = aMap.get(p.id);
          const alive = meta?.alive ?? true;
          const label = meta?.name ?? "";

          ctx.globalAlpha = alive ? 1 : 0.2;
          ctx.beginPath();
          ctx.arc(p.x * TILE + TILE / 2, p.y * TILE + TILE / 2, TILE * 0.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;

          ctx.fillText(label, p.x * TILE + 4, p.y * TILE + 12);
        }
      }
    } else {
      // fallback: draw last known react state (non-playing / no snaps yet)
      // (optional) you can keep this simple or remove
    }

    requestAnimationFrame(draw);
  }

  draw();
}, []);

  const me = players.find(p => p.id === myIdRef.current);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label>
          Name{" "}
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ padding: 6 }} />
        </label>

        <button onClick={() => send({ type: "join", name })} style={{ padding: "6px 10px" }}>
          Join
        </button>

        <button
          onClick={() => {
            const next = !ready;
            setReady(next);
            send({ type: "ready", ready: next });
          }}
          style={{ padding: "6px 10px" }}
        >
          {ready ? "Unready" : "Ready"}
        </button>

        <span>Connection: {connState}</span>
        <span>Phase: {phase}</span>

        {me && (
          <>
            <span>Walls left: {me.wallsLeft}</span>
            <span>Breaks left: {me.breaksLeft}</span>
          </>
        )}
      </div>

      <div>
        <p style={{ margin: "6px 0" }}>
  Controls: WASD/Arrows move • Space = push • Left click = place wall (3) • Right click = break own wall (3)
</p>
        {phase === "over" && (
          <p>
            Game Over. Winner: <b>{winnerId ?? "DRAW"}</b>
          </p>
        )}
      </div>

      <canvas
  ref={canvasRef}
  width={GRID_W * TILE}
  height={GRID_H * TILE}
  style={{ border: "1px solid #ccc", borderRadius: 8 }}
  onContextMenu={(e) => e.preventDefault()}
  onMouseDown={(e) => {
    const w = wallsRef.current.find(w => w.ownerId === myId && w.pos.x === cell.x && w.pos.y === cell.y);
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (phase !== "playing") return;

    const cell = getCellFromMouse(e, canvas);

    if (e.button === 0) {
      // left click: place wall
      send({ type: "place_wall", cell });
      return;
    }

    if (e.button === 2) {
      // right click: break own wall at that cell (if exists)
      const myId = myIdRef.current;
      if (!myId) return;
      const w = walls.find(w => w.ownerId === myId && w.pos.x === cell.x && w.pos.y === cell.y);
      if (!w) return;
      send({ type: "break_wall", wallId: w.id });
    }
  }}
/>
    </div>
  );
}