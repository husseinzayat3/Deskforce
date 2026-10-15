import { NextRequest, NextResponse } from 'next/server';
import { saveMedia } from '../../../lib/server/media';
import { refuseForeignRequest } from '../../../lib/server/guard';
import { errorMessage } from '../../../lib/errors';

export const dynamic = 'force-dynamic';

/** POST /api/media { kind: 'map' | 'avatar', data: <base64> } → { url } */
export async function POST(req: NextRequest) {
  const refusal = refuseForeignRequest(req);
  if (refusal) return refusal;

  try {
    const body = await req.json();
    if (body.kind !== 'map' && body.kind !== 'avatar') return NextResponse.json({ error: 'Unknown kind of picture' }, { status: 400 });
    if (typeof body.data !== 'string') return NextResponse.json({ error: 'Missing picture' }, { status: 400 });
    return NextResponse.json({ url: saveMedia(body.kind, body.data) });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}
