"use client";

import React, { useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useSimulation } from '../lib/SimulationContext';
import { BUILT_IN_AVATARS } from '../lib/layout';
import { uploadPicture } from '../lib/upload';
import { errorMessage } from '../lib/errors';

const SIZE = 40;

/** Choosing an employee's picture: the built-in ones, the ones you uploaded, or a new upload. */
export default function AvatarPicker({ value, onChange }: { value: string; onChange: (avatar: string) => void }) {
  const { layout, saveLayout, agents, notify } = useSimulation();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const url = await uploadPicture('avatar', file);
      saveLayout({ ...layout, avatars: [...layout.avatars, url] });
      onChange(url);
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = (avatar: string) => {
    if (agents.some(a => a.avatar === avatar)) return notify('An employee uses this picture. Give them another one first.');
    saveLayout({ ...layout, avatars: layout.avatars.filter(a => a !== avatar) });
    if (value === avatar) onChange(BUILT_IN_AVATARS[0]);
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      {[...BUILT_IN_AVATARS, ...layout.avatars].map(src => {
        const custom = layout.avatars.includes(src);
        return (
          <span key={src} style={{ position: 'relative', lineHeight: 0 }}>
            <button
              type="button"
              onClick={() => onChange(src)}
              aria-label={`Picture ${src.split('/').pop()}`}
              aria-pressed={value === src}
              style={{ padding: 0, border: value === src ? '2px solid #3b82f6' : '2px solid transparent', borderRadius: '50%', background: '#e2e8f0', cursor: 'pointer', lineHeight: 0 }}
            >
              <img src={src} alt="" style={{ width: SIZE, height: SIZE, borderRadius: '50%', objectFit: 'cover' }} />
            </button>
            {custom && value === src && (
              <button
                type="button"
                onClick={() => remove(src)}
                title="Delete this uploaded picture"
                aria-label="Delete this uploaded picture"
                style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, padding: 0, border: 'none', borderRadius: '50%', background: '#d03b3b', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={11} />
              </button>
            )}
          </span>
        );
      })}
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        title="Upload your own picture"
        aria-label="Upload your own picture"
        style={{ width: SIZE + 4, height: SIZE + 4, borderRadius: '50%', border: '2px dashed #94a3b8', background: '#f8fafc', color: '#475569', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <Plus size={18} />
      </button>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={upload} />
    </div>
  );
}
