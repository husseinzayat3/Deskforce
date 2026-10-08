import { Agent } from './types';

/** Side of the floorplan in map units. Every position is in these units, whatever size the map is shown at. */
export const MAP_SIZE = 1024;

export interface Point {
  x: number;
  y: number;
}

/** A desk on the map. With a role, only employees of that role sit there; without, anyone may. */
export interface Desk extends Point {
  role?: string;
}

export type RoomName = 'meeting' | 'coffee' | 'breakRoom' | 'toilet' | 'entrance';

export const ROOM_LABELS: Record<RoomName, string> = {
  meeting: 'Meeting room',
  coffee: 'Coffee',
  breakRoom: 'Break room',
  toilet: 'Toilets',
  entrance: 'Entrance',
};

/** Where things are in the office, and what it looks like. */
export interface OfficeLayout {
  /** Address of the uploaded floorplan image; empty = the built-in one. */
  background: string;
  desks: Desk[];
  rooms: Record<RoomName, Point>;
  /** Avatars the user uploaded, in addition to the built-in ones. */
  avatars: string[];
}

export const BUILT_IN_BACKGROUND = '/office_bg.png';
export const BUILT_IN_AVATARS = ['/avatars/robot.png', '/avatars/dog.png', '/avatars/manager.png', '/avatars/worker.png'];

/** Addresses the office accepts for a picture: a built-in one, or one that was uploaded to it. */
export const MEDIA_URL = /^\/(avatars|api\/media)\/[a-z0-9_-]+\.(png|jpe?g|webp|gif)$/i;

const desks = (role: string | undefined, points: [number, number][]): Desk[] => points.map(([x, y]) => ({ x, y, ...(role ? { role } : {}) }));

/** The layout that matches the built-in floorplan. */
export const DEFAULT_LAYOUT: OfficeLayout = {
  background: '',
  desks: [
    ...desks('CEO', [[480, 180], [430, 180]]),
    ...desks('Tech Lead', [[150, 400], [250, 400], [350, 400], [450, 400]]),
    ...desks('Junior Dev', [[150, 550], [250, 550], [350, 550], [450, 550], [150, 700], [250, 700], [350, 700], [450, 700]]),
    ...desks('Designer', [[800, 350], [850, 350]]),
    ...desks('HR', [[800, 400]]),
    ...desks(undefined, [[600, 400], [680, 400], [600, 550], [680, 550], [600, 700], [680, 700]]),
  ],
  rooms: {
    meeting: { x: 455, y: 260 },
    coffee: { x: 850, y: 450 },
    breakRoom: { x: 800, y: 600 },
    toilet: { x: 800, y: 200 },
    entrance: { x: 500, y: 900 },
  },
  avatars: [],
};

const MAX_DESKS = 80;
const MAX_AVATARS = 40;

const inMap = (value: unknown, fallback: number) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(MAP_SIZE, Math.max(0, n)) : fallback;
};

/** A layout made safe to store and draw: positions inside the map, known rooms, only the office's own pictures. */
export const sanitizeLayout = (input: unknown): OfficeLayout => {
  const raw = (input || {}) as Partial<OfficeLayout>;
  const rooms = { ...DEFAULT_LAYOUT.rooms };
  for (const name of Object.keys(rooms) as RoomName[]) {
    const point = raw.rooms?.[name];
    if (point) rooms[name] = { x: inMap(point.x, rooms[name].x), y: inMap(point.y, rooms[name].y) };
  }
  const cleaned = (Array.isArray(raw.desks) ? raw.desks : DEFAULT_LAYOUT.desks).slice(0, MAX_DESKS).map(desk => ({
    x: inMap(desk?.x, MAP_SIZE / 2),
    y: inMap(desk?.y, MAP_SIZE / 2),
    ...(typeof desk?.role === 'string' && desk.role.trim() ? { role: desk.role.trim().slice(0, 40) } : {}),
  }));
  return {
    background: typeof raw.background === 'string' && MEDIA_URL.test(raw.background) ? raw.background : '',
    desks: cleaned.length > 0 ? cleaned : DEFAULT_LAYOUT.desks,
    rooms,
    avatars: (Array.isArray(raw.avatars) ? raw.avatars : []).filter(a => typeof a === 'string' && MEDIA_URL.test(a)).slice(0, MAX_AVATARS),
  };
};

/**
 * The desk an employee sits at. Desks marked for the employee's role come first, shared out in
 * hiring order; a role with no desks of its own uses the unmarked ones. More people than desks double up.
 */
export const deskFor = (agent: Pick<Agent, 'id' | 'role'>, all: Pick<Agent, 'id' | 'role'>[], layout: OfficeLayout): Point => {
  const own = layout.desks.filter(desk => desk.role === agent.role);
  const hasOwn = (role: string) => layout.desks.some(desk => desk.role === role);
  const open = layout.desks.filter(desk => !desk.role);

  const seats = own.length > 0 ? own : open.length > 0 ? open : layout.desks;
  const group = own.length > 0 ? all.filter(a => a.role === agent.role) : all.filter(a => !hasOwn(a.role));
  if (seats.length === 0) return layout.rooms.entrance;
  return seats[Math.max(0, group.findIndex(a => a.id === agent.id)) % seats.length];
};
