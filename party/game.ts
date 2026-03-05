// party/game.ts
import type * as Party from "partykit/server";

type Vec = { x: number; y: number };

type Player = {
  id: string;
  name: string;
  alive: boolean;
  pos: Vec;          // grid coords
  dir: Vec;          // last move input
  ready: boolean;
  wallsLeft: number; // place limit (3)
  breaksLeft: number;// break limit (3)
  pushCdMs: number;  // cooldown
};

type Guard = {
  id: string;
  pos: Vec;
};

type Wall = {
  id: string;
  ownerId: string;
  pos: Vec;
};

type RoomState = {
  phase: "lobby" | "playing" | "over";
  tMs: number;
  seed: number;
  players: Record<string, Player>;
  guards: Guard[];
  walls: Wall[];
  winnerId?: string;
};

const GRID_W = 25;
const GRID_H = 19;

const TICK_MS = 50; // 20 ticks/sec
const PUSH_CD_MS = 1200;
//const GUARD_SPAWN_EVERY_MS = 8000;
const MAX_GUARDS = 30;

function spawnIntervalMs(tMs: number) {
  // 0-30s: 8000ms, 30-60s: 6000ms, 60-90s: 4500ms, 90s+: 3500ms
  if (tMs < 30_000) return 8000;
  if (tMs < 60_000) return 6000;
  if (tMs < 90_000) return 4500;
  return 3500;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function sameCell(a: Vec, b: Vec) {
  return a.x === b.x && a.y === b.y;
}

function keyOf(v: Vec) {
  return `${v.x},${v.y}`;
}

type DistMap = Int16Array; // size = GRID_W * GRID_H, -1 = unreachable

function idx(x: number, y: number) {
  return y * GRID_W + x;
}

function inBounds(x: number, y: number) {
  return x >= 0 && x < GRID_W && y >= 0 && y < GRID_H;
}

function buildBlockedSet(walls: Wall[]) {
  const s = new Set<string>();
  for (const w of walls) s.add(keyOf(w.pos));
  return s;
}

function bfsFromTarget(target: Vec, blocked: Set<string>): DistMap {
  const dist = new Int16Array(GRID_W * GRID_H);
  dist.fill(-1);

  if (!inBounds(target.x, target.y)) return dist;
  if (blocked.has(keyOf(target))) return dist;

  const qx: number[] = [];
  const qy: number[] = [];
  let head = 0;

  dist[idx(target.x, target.y)] = 0;
  qx.push(target.x);
  qy.push(target.y);

  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;

  while (head < qx.length) {
    const x = qx[head];
    const y = qy[head];
    head++;

    const base = dist[idx(x, y)];
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      if (blocked.has(`${nx},${ny}`)) continue;
      const i = idx(nx, ny);
      if (dist[i] !== -1) continue;
      dist[i] = (base + 1) as any;
      qx.push(nx);
      qy.push(ny);
    }
  }

  return dist;
}

function generateMaze(): Vec[] {
  const visited = new Set<string>()
  const walls: Vec[] = []

  const stack: Vec[] = [{ x: 1, y: 1 }]
  visited.add("1,1")

  const dirs = [
    { x: 2, y: 0 },
    { x: -2, y: 0 },
    { x: 0, y: 2 },
    { x: 0, y: -2 }
  ]

  while (stack.length > 0) {
    const current = stack[stack.length - 1]

    const neighbors = dirs
      .map(d => ({ x: current.x + d.x, y: current.y + d.y }))
      .filter(n =>
        n.x > 0 &&
        n.x < GRID_W - 1 &&
        n.y > 0 &&
        n.y < GRID_H - 1 &&
        !visited.has(`${n.x},${n.y}`)
      )

    if (neighbors.length === 0) {
      stack.pop()
      continue
    }

    const next = neighbors[Math.floor(Math.random() * neighbors.length)]

    const mid = {
      x: (current.x + next.x) / 2,
      y: (current.y + next.y) / 2
    }

    visited.add(`${next.x},${next.y}`)
    visited.add(`${mid.x},${mid.y}`)

    stack.push(next)
  }

  for (let x = 0; x < GRID_W; x++) {
    for (let y = 0; y < GRID_H; y++) {
      if (!visited.has(`${x},${y}`)) {
        walls.push({ x, y })
      }
    }
  }

  return walls
}

function chooseStepByDist(from: Vec, dist: DistMap, blocked: Set<string>): Vec {
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;

  const cur = dist[idx(from.x, from.y)];
  if (cur <= 0) return from; // already at target or unreachable (-1)

  let best = from;
  let bestD = cur;

  for (const [dx, dy] of dirs) {
    const nx = from.x + dx;
    const ny = from.y + dy;
    if (!inBounds(nx, ny)) continue;
    if (blocked.has(`${nx},${ny}`)) continue;
    const d = dist[idx(nx, ny)];
    if (d >= 0 && d < bestD) {
      bestD = d;
      best = { x: nx, y: ny };
    }
  }

  return best;
}

export default class GameRoom implements Party.Server {
  room: Party.Room;
  state: RoomState;
  interval: ReturnType<typeof setInterval> | null = null;

  // input queue: connId -> latest input
  latestMove: Map<string, Vec> = new Map();

  lastPathMs = 0;
distByPlayer: Map<string, DistMap> = new Map();

  constructor(room: Party.Room) {
    this.room = room;

    this.state = {
      phase: "lobby",
      tMs: 0,
      seed: Math.floor(Math.random() * 1e9),
      players: {},
      guards: [],
      walls: []
    };

    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  // ---- PartyKit hooks ----
  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    // auto add player with default
    this.state.players[conn.id] = {
      id: conn.id,
      name: "Player",
      alive: true,
      pos: { x: 12, y: 9 }, // same spawn
      dir: { x: 0, y: 0 },
      ready: false,
      wallsLeft: 3,
      breaksLeft: 3,
      pushCdMs: 0
    };

    conn.send(JSON.stringify({ type: "welcome", myId: conn.id }));
    conn.send(JSON.stringify({ type: "room_state", state: this.publicState() }));
    this.broadcastState();
  }

  onClose(conn: Party.Connection) {
    delete this.state.players[conn.id];
    this.latestMove.delete(conn.id);
    this.broadcastState();
  }

  onMessage(message: string, conn: Party.Connection) {
    let msg: any;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    const p = this.state.players[conn.id];
    if (!p) return;

    switch (msg.type) {
      case "join": {
        p.name = String(msg.name ?? "Player").slice(0, 16);
        this.broadcastState();
        break;
      }
      case "ready": {
        if (this.state.phase !== "lobby") return;
        p.ready = !!msg.ready;
        this.broadcastState();

        const players = Object.values(this.state.players);
        if (players.length === 2 && players.every(x => x.ready)) {
          this.startGame();
        }
        break;
      }
      case "input": {
        if (this.state.phase !== "playing") return;
        const v: Vec = msg.move ?? { x: 0, y: 0 };
        const nx = clamp(Math.round(v.x), -1, 1);
        const ny = clamp(Math.round(v.y), -1, 1);
        // allow only cardinal moves
        const mv =
          nx !== 0 && ny !== 0 ? { x: nx, y: 0 } :
          { x: nx, y: ny };
        this.latestMove.set(conn.id, mv);
        break;
      }
      case "push": {
        if (this.state.phase !== "playing") return;
        this.tryPush(conn.id);
        break;
      }
      case "place_wall": {
        if (this.state.phase !== "playing") return;
        this.tryPlaceWall(conn.id, msg.cell);
        break;
      }
      case "break_wall": {
        if (this.state.phase !== "playing") return;
        this.tryBreakWall(conn.id, String(msg.wallId ?? ""));
        break;
      }
    }
  }

  // ---- Game flow ----
  startGame() {
    this.state.phase = "playing";
    this.state.tMs = 0;
    this.state.guards = [{ id: "g1", pos: { x: 2, y: 2 } }];
    const mazeWalls = generateMaze()

this.state.walls = mazeWalls.map((w, i) => ({
  id: "maze_" + i,
  ownerId: "maze",
  pos: w
}))
function randomSpawn(blocked:Set<string>) {
  while (true) {
    const x = Math.floor(Math.random() * GRID_W)
    const y = Math.floor(Math.random() * GRID_H)

    if (!blocked.has(`${x},${y}`)) {
      return { x, y }
    }
  }
}

const blocked = new Set(this.state.walls.map(w=>`${w.pos.x},${w.pos.y}`))

for (const p of Object.values(this.state.players)) {
  p.pos = randomSpawn(blocked)
}
    // reset players
    for (const p of Object.values(this.state.players)) {
      p.alive = true;
      p.pos = { x: 12, y: 9 };
      p.dir = { x: 0, y: 0 };
      p.wallsLeft = 3;
      p.breaksLeft = 3;
      p.pushCdMs = 0;
    }

    this.room.broadcast(JSON.stringify({
      type: "start",
      seed: this.state.seed
    }));
    this.broadcastState();
  }

  endGame(winnerId: string) {
    this.state.phase = "over";
    this.state.winnerId = winnerId;
    this.room.broadcast(JSON.stringify({
      type: "game_over",
      winnerId
    }));
    this.broadcastState();
  }

  publicState() {
    // small enough; you can trim later
    return this.state;
  }

  broadcastState() {
    this.room.broadcast(JSON.stringify({
      type: "room_state",
      state: this.publicState()
    }));
  }

  // ---- Mechanics ----
  isBlocked(cell: Vec): boolean {
    if (cell.x < 0 || cell.x >= GRID_W || cell.y < 0 || cell.y >= GRID_H) return true;
    const wallSet = new Set(this.state.walls.map(w => keyOf(w.pos)));
    return wallSet.has(keyOf(cell));
  }

  tryPlaceWall(playerId: string, cell: Vec) {
    const p = this.state.players[playerId];
    if (this.state.walls.some(w => w.pos.x === pos.x && w.pos.y === pos.y)) return
    if (!p || !p.alive) return;
    if (p.wallsLeft <= 0) return;
    if (!cell || typeof cell.x !== "number" || typeof cell.y !== "number") return;

    const pos = { x: clamp(Math.floor(cell.x), 0, GRID_W - 1), y: clamp(Math.floor(cell.y), 0, GRID_H - 1) };
    if (this.isBlocked(pos)) return;

    // Don't allow placing wall on any player
    for (const pl of Object.values(this.state.players)) {
      if (pl.alive && sameCell(pl.pos, pos)) return;
    }

    const id = `w_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    this.state.walls.push({ id, ownerId: playerId, pos });
    p.wallsLeft -= 1;
  }

  tryBreakWall(playerId: string, wallId: string) {
    const p = this.state.players[playerId];
    if (!p || !p.alive) return;
    if (p.breaksLeft <= 0) return;

    const idx = this.state.walls.findIndex(w => w.id === wallId);
    if (idx < 0) return;

    const w = this.state.walls[idx];
    if (w.ownerId !== playerId) return; // only own wall

    this.state.walls.splice(idx, 1);
    p.breaksLeft -= 1;
  }

  tryPush(playerId: string) {
    const p = this.state.players[playerId];
    if (!p || !p.alive) return;
    if (p.pushCdMs > 0) return;

    // push nearest other player if adjacent
    const others = Object.values(this.state.players).filter(x => x.id !== playerId && x.alive);
    if (others.length === 0) return;

    const o = others[0]; // only 2 players in MVP
    const dx = o.pos.x - p.pos.x;
    const dy = o.pos.y - p.pos.y;

    const adj = (Math.abs(dx) + Math.abs(dy)) === 1;
    if (!adj) return;

    const target: Vec = { x: o.pos.x + dx, y: o.pos.y + dy }; // push away
    if (this.isBlocked(target)) {
      // if blocked, still consume push? (up to you) — MVP: consume
      p.pushCdMs = PUSH_CD_MS;
      return;
    }
    o.pos = target;
    p.pushCdMs = PUSH_CD_MS;
  }

  // very simple guard chase: step towards nearest alive player (no pathfinding yet)
  guardStep(g: Guard) {
  const alive = Object.values(this.state.players).filter(p => p.alive);
  if (alive.length === 0) return;

  // blocked set (walls) - recompute here is fine for small map
  const blocked = buildBlockedSet(this.state.walls);

  // choose nearest target by BFS dist (if available)
  let target = alive[0];
  let best = Number.POSITIVE_INFINITY;

  for (const p of alive) {
    const dist = this.distByPlayer.get(p.id);
    if (!dist) continue;
    const d = dist[idx(g.pos.x, g.pos.y)];
    if (d >= 0 && d < best) {
      best = d;
      target = p;
    }
  }

  // if no dist map yet, fallback: chase first alive
  const dist = this.distByPlayer.get(target.id);
  if (!dist) return;

  const next = chooseStepByDist(g.pos, dist, blocked);
  g.pos = next;
}

  spawnGuardIfNeeded() {
  if (this.state.guards.length >= MAX_GUARDS) return;
  if (this.state.tMs === 0) return;

  const interval = spawnIntervalMs(this.state.tMs);
  // tick бүрт давхцахаас сэргийлж "edge" ашиглая:
  const prevT = this.state.tMs - TICK_MS;
  const crossed = Math.floor(prevT / interval) !== Math.floor(this.state.tMs / interval);
  if (!crossed) return;

  for (let tries = 0; tries < 80; tries++) {
    const pos = { x: Math.floor(Math.random() * GRID_W), y: Math.floor(Math.random() * GRID_H) };
    if (this.isBlocked(pos)) continue;

    // player дээр spawn хийхгүй
    const onPlayer = Object.values(this.state.players).some(p => p.alive && sameCell(p.pos, pos));
    if (onPlayer) continue;

    this.state.guards.push({
      id: `g_${Date.now()}_${tries}`,
      pos
    });
    return;
  }
}

  // ---- Tick loop ----
  tick() {
    if (this.state.phase !== "playing") return;

    this.state.tMs += TICK_MS;

    // cooldowns
    for (const p of Object.values(this.state.players)) {
      if (p.pushCdMs > 0) p.pushCdMs = Math.max(0, p.pushCdMs - TICK_MS);
    }

    // apply movement inputs
    for (const p of Object.values(this.state.players)) {
      if (!p.alive) continue;
      const mv = this.latestMove.get(p.id) ?? { x: 0, y: 0 };
      p.dir = mv;

      const next = { x: p.pos.x + mv.x, y: p.pos.y + mv.y };
      if (!this.isBlocked(next)) {
        // basic player-player collision: disallow stepping into other player
        const other = Object.values(this.state.players).find(o => o.id !== p.id && o.alive && sameCell(o.pos, next));
        if (!other) p.pos = next;
      }
    }
// recompute BFS distance maps every 200ms (cheap on 25x19)
if (this.state.tMs - this.lastPathMs >= 200) {
  this.lastPathMs = this.state.tMs;

  const blocked = buildBlockedSet(this.state.walls);
  this.distByPlayer.clear();

  for (const p of Object.values(this.state.players)) {
    if (!p.alive) continue;
    this.distByPlayer.set(p.id, bfsFromTarget(p.pos, blocked));
  }
}
    // guards
    this.spawnGuardIfNeeded();
    for (const g of this.state.guards) {
      this.guardStep(g);
    }

    // collisions: guard touches player => out
    for (const p of Object.values(this.state.players)) {
      if (!p.alive) continue;
      const hit = this.state.guards.some(g => sameCell(g.pos, p.pos));
      if (hit) p.alive = false;
    }

    // win check
    const alive = Object.values(this.state.players).filter(p => p.alive);
    if (alive.length === 1) {
      this.endGame(alive[0].id);
      return;
    }
    if (alive.length === 0) {
      // draw fallback: pick nobody
      this.state.phase = "over";
      this.room.broadcast(JSON.stringify({ type: "game_over", winnerId: null }));
      return;
    }

    // send tick snapshot
    this.room.broadcast(JSON.stringify({
      type: "tick",
      tMs: this.state.tMs,
      players: Object.values(this.state.players),
      guards: this.state.guards,
      walls: this.state.walls
    }));
  }
}