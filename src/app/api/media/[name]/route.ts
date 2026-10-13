import { NextRequest, NextResponse } from 'next/server';
import { readMedia } from '../../../../lib/server/media';
import { refuseUnknownHost } from '../../../../lib/server/guard';

export const dynamic = 'force-dynamic';

/** GET /api/media/<name> → an uploaded floorplan or avatar */
export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const refusal = refuseUnknownHost(req);
  if (refusal) return refusal;

  const media = readMedia((await params).name);
  if (!media) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return new NextResponse(new Uint8Array(media.data), {
    headers: { 'Content-Type': media.contentType, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' },
  });
}
