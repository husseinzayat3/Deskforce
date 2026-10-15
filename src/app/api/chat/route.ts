import { NextRequest, NextResponse } from 'next/server';
import { chatWithOffice } from '../../../lib/server/chat';
import { ensureEngine } from '../../../lib/server/engine';
import { refuseForeignRequest } from '../../../lib/server/guard';
import { errorMessage } from '../../../lib/errors';

export const dynamic = 'force-dynamic';

/**
 * POST /api/chat { text, conversation? } → { reply }
 *
 * Says something to the office and returns the front desk's answer: the same conversation
 * Slack has, for scripts and other tools on this computer.
 */
export async function POST(req: NextRequest) {
  const refusal = refuseForeignRequest(req);
  if (refusal) return refusal;

  try {
    ensureEngine();
    const body = await req.json();
    if (typeof body.text !== 'string' || !body.text.trim()) return NextResponse.json({ error: 'Missing text' }, { status: 400 });
    const conversation = typeof body.conversation === 'string' && /^[\w:.-]{1,80}$/.test(body.conversation) ? body.conversation : 'local';
    return NextResponse.json({ reply: await chatWithOffice(conversation, body.text) });
  } catch (error) {
    console.error('Chat error:', error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
