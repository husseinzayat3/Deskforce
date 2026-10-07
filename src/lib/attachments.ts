import { Attachment } from './types';

/** Limits checked in the browser before anything is sent; the server checks them again. */
export const MAX_ATTACHED_FILES = 300;
export const MAX_ATTACHED_BYTES = 8_000_000;

/** Folders that are never worth sending with an attached folder. */
const SKIPPED = /(^|\/)(node_modules|\.git|\.dart_tool|build|dist|\.next|\.idea|\.gradle|Pods|__pycache__|\.venv|venv|\.DS_Store)(\/|$)/;

const toBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    // "data:<type>;base64,<data>" — only the data is wanted
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.readAsDataURL(file);
  });

/**
 * Reads the files a user picked into the form the office expects.
 * Files picked as a folder keep their path inside it; single files are sent by name.
 */
export const readAttachments = async (picked: File[]): Promise<Attachment[]> => {
  const files = picked.filter(file => !SKIPPED.test(file.webkitRelativePath || file.name));
  if (files.length > MAX_ATTACHED_FILES) throw new Error(`That is ${files.length} files; at most ${MAX_ATTACHED_FILES} can be attached.`);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_ATTACHED_BYTES) throw new Error(`Attachments are limited to ${MAX_ATTACHED_BYTES / 1_000_000} MB in total (these are ${(total / 1_000_000).toFixed(1)} MB).`);
  return Promise.all(files.map(async file => ({ path: file.webkitRelativePath || file.name, data: await toBase64(file) })));
};
