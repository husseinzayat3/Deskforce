import { lookup } from 'dns/promises';
import { htmlToText, isPublicAddress } from '../netGuard';

const MAX_REDIRECTS = 5;
const MAX_BYTES = 1_500_000;
const MAX_TEXT_CHARS = 12_000;
const TIMEOUT_MS = 20_000;

/** Throws unless the URL is plain web and every address it resolves to is on the public internet. */
const assertPublic = async (url: URL) => {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https addresses can be fetched.');
  if (url.username || url.password) throw new Error('Addresses with a user name or password are not fetched.');
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (addresses.length === 0 || addresses.some(entry => !isPublicAddress(entry.address))) {
    throw new Error('That address is on this computer or a private network, which agents may not reach.');
  }
};

/**
 * Fetches a public web page for an agent and returns its readable text.
 * Redirects are followed by hand so each hop is checked as well.
 */
export const fetchPage = async (address: string, signal?: AbortSignal) => {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error('That is not a valid web address.');
  }

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: combined,
      headers: { 'User-Agent': 'MyOffice/1.0 (research agent)', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) throw new Error(`The page answered with status ${res.status}.`);

    const type = res.headers.get('content-type') || '';
    if (!/text|json|xml/i.test(type)) throw new Error(`The page is not text (${type || 'unknown type'}).`);

    // Read at most MAX_BYTES, whatever the page's size
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size >= MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }
    const body = Buffer.concat(chunks).toString('utf-8');
    const text = /html/i.test(type) ? htmlToText(body) : body;
    return `${url.href}\n\n${text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[The page continues; only the first part is shown.]` : text}`;
  }
  throw new Error('Too many redirects.');
};
