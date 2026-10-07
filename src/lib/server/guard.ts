import { NextRequest, NextResponse } from 'next/server';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Extra host names the office may be reached under, e.g. OFFICE_ALLOWED_HOSTS="office.lan,10.0.0.5". */
const allowedHosts = () =>
  new Set((process.env.OFFICE_ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean));

const hostnameOf = (host: string | null) => (host || '').toLowerCase().replace(/:\d+$/, '');

/**
 * Refuses a request addressed to a host name the office does not answer to.
 * The office has no login, so it is meant to be reached on this computer only. Checking the
 * name also stops "DNS rebinding", where a website points its own domain at 127.0.0.1 to
 * make the browser treat the office as part of that site.
 * Returns the refusal, or null when the request may proceed.
 */
export const refuseUnknownHost = (req: NextRequest) => {
  const hostname = hostnameOf(req.headers.get('host'));
  if (LOCAL_HOSTS.has(hostname) || allowedHosts().has(hostname)) return null;
  return NextResponse.json({ error: 'This office only answers on this computer. Set OFFICE_ALLOWED_HOSTS to allow another host name.' }, { status: 403 });
};

/**
 * Refuses a request that changes something unless it comes from the office page itself.
 * A browser sends `Origin` with every cross-site POST, and a JSON content type cannot be
 * sent cross-site without the server's permission, so another website (or a previewed
 * project page) cannot hire, assign, spend or change settings behind the user's back.
 * Returns the refusal, or null when the request may proceed.
 */
export const refuseForeignRequest = (req: NextRequest) => {
  const unknownHost = refuseUnknownHost(req);
  if (unknownHost) return unknownHost;

  const origin = req.headers.get('origin');
  if (origin) {
    let sameHost = false;
    try {
      sameHost = new URL(origin).host === req.headers.get('host');
    } catch {
      // "null" (sandboxed page) or malformed
    }
    if (!sameHost) return NextResponse.json({ error: 'Requests from other sites are not accepted' }, { status: 403 });
  }

  if (!(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    return NextResponse.json({ error: 'Send JSON (Content-Type: application/json)' }, { status: 415 });
  }
  return null;
};
