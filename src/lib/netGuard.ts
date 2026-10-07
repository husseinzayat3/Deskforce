/**
 * True for an address on the public internet. Everything else (this computer, the local
 * network, link-local and cloud metadata addresses) is refused, so a page an agent is asked
 * to fetch can never be the office itself or a device on the user's network.
 */
export const isPublicAddress = (address: string): boolean => {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');

  // IPv4 written inside IPv6 (::ffff:10.0.0.1)
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicAddress(mapped[1]);

  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (v4.slice(1).some(part => Number(part) > 255)) return false;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a >= 224) return false; // multicast and reserved
    return true;
  }

  if (!ip.includes(':')) return false; // not an IP address at all
  if (ip === '::' || ip === '::1') return false;
  if (/^f[cd]/.test(ip)) return false; // unique local
  if (/^fe[89ab]/.test(ip)) return false; // link-local
  if (/^ff/.test(ip)) return false; // multicast
  return true;
};

/** Reduces an HTML page to its readable text. */
export const htmlToText = (html: string) =>
  html
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|table|ul|ol|pre|blockquote)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/[ \t\f\r]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
