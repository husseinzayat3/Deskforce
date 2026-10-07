import { NextRequest, NextResponse } from 'next/server';

/**
 * Refuses a request that changes something unless it comes from the office page itself.
 * A browser sends `Origin` with every cross-site POST, and a JSON content type cannot be
 * sent cross-site without the server's permission, so another website (or a previewed
 * project page) cannot hire, assign, spend or change settings behind the user's back.
 * Returns the refusal, or null when the request may proceed.
 */
export const refuseForeignRequest = (req: NextRequest) => {
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
