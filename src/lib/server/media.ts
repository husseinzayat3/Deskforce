import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './paths';

/**
 * Pictures the user uploaded: a floorplan and avatars. They live in the data folder (the app
 * itself cannot be written to once installed) and are served back by /api/media/<name>.
 */
const MEDIA_DIR = path.join(/* turbopackIgnore: true */ DATA_DIR, 'media');
const MAX_BYTES = 6_000_000;
const NAME = /^[a-z0-9_-]+\.(png|jpe?g|webp|gif)$/i;

/** Recognises an image by its first bytes, whatever the upload claimed to be. SVG is not accepted: it can carry scripts. */
const sniff = (data: Buffer): { extension: string; contentType: string } | null => {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { extension: 'png', contentType: 'image/png' };
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { extension: 'jpg', contentType: 'image/jpeg' };
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return { extension: 'gif', contentType: 'image/gif' };
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return { extension: 'webp', contentType: 'image/webp' };
  return null;
};

/** Stores an uploaded picture and returns the address it is served at. */
export const saveMedia = (kind: 'map' | 'avatar', base64: string) => {
  const data = Buffer.from(base64, 'base64');
  if (data.length === 0) throw new Error('The file is empty.');
  if (data.length > MAX_BYTES) throw new Error(`Pictures are limited to ${MAX_BYTES / 1_000_000} MB.`);
  const type = sniff(data);
  if (!type) throw new Error('Use a PNG, JPEG, WebP or GIF picture.');

  fs.mkdirSync(/* turbopackIgnore: true */ MEDIA_DIR, { recursive: true });
  const name = `${kind}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${type.extension}`;
  fs.writeFileSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ MEDIA_DIR, name), data);
  return `/api/media/${name}`;
};

export const readMedia = (name: string) => {
  if (!NAME.test(name)) return null;
  const file = path.join(/* turbopackIgnore: true */ MEDIA_DIR, name);
  if (!fs.existsSync(/* turbopackIgnore: true */ file)) return null;
  const data = fs.readFileSync(/* turbopackIgnore: true */ file);
  const type = sniff(data);
  return type ? { data, contentType: type.contentType } : null;
};

/** Removes an uploaded picture, given the address it is served at. */
export const deleteMedia = (url: string) => {
  const name = url.split('/').pop() || '';
  if (!url.startsWith('/api/media/') || !NAME.test(name)) return;
  fs.rmSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ MEDIA_DIR, name), { force: true });
};
