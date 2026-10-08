/** Sends a picture to the office and returns the address it is then served at. */
export const uploadPicture = async (kind: 'map' | 'avatar', file: File): Promise<string> => {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.readAsDataURL(file);
  });
  const res = await fetch('/api/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, data }) });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error || 'The picture could not be uploaded.');
  return body.url;
};
