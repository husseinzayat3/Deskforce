import { NextRequest, NextResponse } from 'next/server';
import { searchOffice } from '../../../lib/server/search';
import { refuseUnknownHost } from '../../../lib/server/guard';
import { errorMessage } from '../../../lib/errors';

export const dynamic = 'force-dynamic';

/** GET /api/search?q=text → matching tasks and project files */
export async function GET(req: NextRequest) {
  const refusal = refuseUnknownHost(req);
  if (refusal) return refusal;
  try {
    return NextResponse.json(searchOffice((new URL(req.url).searchParams.get('q') || '').slice(0, 200)));
  } catch (error) {
    console.error('Search error:', error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
