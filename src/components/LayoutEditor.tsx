"use client";

import React, { useRef, useState } from 'react';
import { ImageUp, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { BUILT_IN_BACKGROUND, DEFAULT_LAYOUT, Desk, MAP_SIZE, OfficeLayout, Point, ROOM_LABELS, RoomName } from '../lib/layout';
import { Role } from '../lib/types';
import { uploadPicture } from '../lib/upload';

/** What is being dragged or is selected: a desk by its position in the list, or a room by name. */
type Target = { kind: 'desk'; index: number } | { kind: 'room'; name: RoomName };

const same = (a: Target | null, b: Target) => Boolean(a && a.kind === b.kind && (a.kind === 'desk' ? a.index === (b as { index: number }).index : a.name === (b as { name: RoomName }).name));
const clamp = (value: number) => Math.min(MAP_SIZE, Math.max(0, Math.round(value)));

const bar: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 10px', border: 'none', borderRadius: 8, background: '#475569', color: '#fff', font: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' };

/**
 * Rearranging the office: drag desks and rooms to where they are on your floorplan, say which
 * role sits at which desk, and swap the floorplan picture. Drawn over the map, at the map's scale.
 */
export default function LayoutEditor({ layout, roles, scale, onSave, onCancel, notify }: {
  layout: OfficeLayout;
  roles: Role[];
  /** How much the map is scaled on screen, to turn pointer positions into map positions. */
  scale: number;
  onSave: (layout: OfficeLayout) => void;
  onCancel: () => void;
  notify: (message: string) => void;
}) {
  const [draft, setDraft] = useState<OfficeLayout>(layout);
  const [selected, setSelected] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const dragging = useRef<Target | null>(null);
  const mapInput = useRef<HTMLInputElement>(null);

  const move = (target: Target, point: Point) => setDraft(prev => (target.kind === 'room'
    ? { ...prev, rooms: { ...prev.rooms, [target.name]: point } }
    : { ...prev, desks: prev.desks.map((desk, index) => (index === target.index ? { ...desk, ...point } : desk)) }));

  const positionOf = (target: Target): Point => (target.kind === 'room' ? draft.rooms[target.name] : draft.desks[target.index]);

  const toMap = (event: React.PointerEvent): Point => {
    const box = surface.current!.getBoundingClientRect();
    return { x: clamp((event.clientX - box.left) / scale), y: clamp((event.clientY - box.top) / scale) };
  };

  /** Pointer and keyboard handling shared by every marker. */
  const handle = (target: Target) => ({
    onPointerDown: (event: React.PointerEvent) => {
      event.preventDefault();
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      dragging.current = target;
      setSelected(target);
    },
    onPointerMove: (event: React.PointerEvent) => {
      if (dragging.current && same(dragging.current, target)) move(target, toMap(event));
    },
    onPointerUp: () => {
      dragging.current = null;
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      const step = event.shiftKey ? 32 : 8;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      if (!delta) return;
      event.preventDefault();
      const at = positionOf(target);
      move(target, { x: clamp(at.x + delta[0]), y: clamp(at.y + delta[1]) });
    },
    onFocus: () => setSelected(target),
  });

  const uploadMap = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const url = await uploadPicture('map', file);
      setDraft(prev => ({ ...prev, background: url }));
    } catch (e: any) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };

  const selectedDesk: Desk | undefined = selected?.kind === 'desk' ? draft.desks[selected.index] : undefined;
  // Roles used by desks stay selectable even after the role itself was deleted
  const roleNames = Array.from(new Set([...roles.map(r => r.name), ...draft.desks.map(d => d.role).filter((r): r is string => Boolean(r))]));

  return (
    <>
      {/* The map itself: everything in here is in map units and scales with it */}
      <div ref={surface} style={{ position: 'absolute', inset: 0, background: 'rgba(15, 23, 42, 0.25)', touchAction: 'none' }} onPointerDown={event => { if (event.target === event.currentTarget) setSelected(null); }}>
        {draft.background !== layout.background && (
          <img src={draft.background || BUILT_IN_BACKGROUND} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none', opacity: 0.85 }} />
        )}

        {draft.desks.map((desk, index) => {
          const target: Target = { kind: 'desk', index };
          const active = same(selected, target);
          return (
            <button
              key={index}
              type="button"
              aria-label={`Desk ${index + 1}${desk.role ? ` for ${desk.role}` : ', for anyone'}. Drag or use the arrow keys to move.`}
              {...handle(target)}
              style={{
                position: 'absolute', left: desk.x, top: desk.y, transform: 'translate(-50%, -50%)', minWidth: 44, height: 44, padding: '0 8px',
                borderRadius: 22, border: active ? '3px solid #fff' : '2px solid rgba(255,255,255,0.8)', outline: active ? '3px solid #2a78d6' : 'none',
                background: desk.role ? '#2a78d6' : '#475569', color: '#fff', font: 'inherit', fontSize: 13, fontWeight: 700, cursor: 'grab', whiteSpace: 'nowrap',
                boxShadow: '0 2px 6px rgba(0,0,0,0.35)', zIndex: active ? 30 : 20,
              }}
            >
              {desk.role || 'Any'}
            </button>
          );
        })}

        {(Object.keys(ROOM_LABELS) as RoomName[]).map(name => {
          const target: Target = { kind: 'room', name };
          const active = same(selected, target);
          const at = draft.rooms[name];
          return (
            <button
              key={name}
              type="button"
              aria-label={`${ROOM_LABELS[name]}. Drag or use the arrow keys to move.`}
              {...handle(target)}
              style={{
                position: 'absolute', left: at.x, top: at.y, transform: 'translate(-50%, -50%)', height: 40, padding: '0 14px',
                borderRadius: 8, border: active ? '3px solid #fff' : '2px solid rgba(255,255,255,0.8)', outline: active ? '3px solid #eb6834' : 'none',
                background: '#eb6834', color: '#fff', font: 'inherit', fontSize: 14, fontWeight: 700, cursor: 'grab', whiteSpace: 'nowrap',
                boxShadow: '0 2px 6px rgba(0,0,0,0.35)', zIndex: active ? 30 : 25,
              }}
            >
              {ROOM_LABELS[name]}
            </button>
          );
        })}
      </div>

      {/* The toolbar is drawn at the map's scale too, so it is sized up to stay readable */}
      <div style={{ position: 'absolute', left: 16, right: 16, top: 16, zIndex: 40, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: 10, borderRadius: 12, background: 'rgba(255,255,255,0.96)', boxShadow: '0 4px 12px rgba(0,0,0,0.25)', transform: `scale(${1 / scale})`, transformOrigin: 'top left', width: `calc((100% - 32px) * ${scale})` }}>
        <strong style={{ fontSize: 13, color: '#0f172a' }}>Arrange the office</strong>
        <button type="button" style={bar} onClick={() => mapInput.current?.click()} disabled={busy} title="Use your own floorplan picture (square works best)">
          <ImageUp size={14} /> {busy ? 'Uploading…' : 'Upload floorplan'}
        </button>
        <input ref={mapInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={uploadMap} />
        {draft.background && (
          <button type="button" style={bar} onClick={() => setDraft(prev => ({ ...prev, background: '' }))}>Built-in floorplan</button>
        )}
        <button type="button" style={bar} onClick={() => { setDraft(prev => ({ ...prev, desks: [...prev.desks, { x: MAP_SIZE / 2, y: MAP_SIZE / 2 }] })); setSelected({ kind: 'desk', index: draft.desks.length }); }}>
          <Plus size={14} /> Add desk
        </button>
        <button type="button" style={bar} onClick={() => { setDraft(prev => ({ ...prev, desks: DEFAULT_LAYOUT.desks, rooms: DEFAULT_LAYOUT.rooms })); setSelected(null); }} title="Put every desk and room back where the built-in floorplan has them">
          <RotateCcw size={14} /> Reset positions
        </button>

        {selected?.kind === 'desk' && selectedDesk && (
          <>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#334155' }}>
              This desk is for
              <select
                value={selectedDesk.role || ''}
                onChange={event => setDraft(prev => ({ ...prev, desks: prev.desks.map((desk, index) => (index === selected.index ? { x: desk.x, y: desk.y, ...(event.target.value ? { role: event.target.value } : {}) } : desk)) }))}
                style={{ height: 30, borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, padding: '0 6px' }}
              >
                <option value="">anyone</option>
                {roleNames.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <button type="button" style={{ ...bar, background: '#d03b3b' }} onClick={() => { setDraft(prev => ({ ...prev, desks: prev.desks.filter((_, index) => index !== selected.index) })); setSelected(null); }} disabled={draft.desks.length <= 1}>
              <Trash2 size={14} /> Remove desk
            </button>
          </>
        )}

        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: '#64748b' }}>Drag the markers, or select one and use the arrow keys.</span>
        <button type="button" style={{ ...bar, background: '#94a3b8' }} onClick={onCancel}>Cancel</button>
        <button type="button" style={{ ...bar, background: '#0ca30c' }} onClick={() => onSave(draft)}>Save</button>
      </div>
    </>
  );
}
