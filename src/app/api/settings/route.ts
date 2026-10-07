import { NextRequest, NextResponse } from 'next/server';
import { describeSettings, isSettingName, saveSetting } from '../../../lib/server/settings';
import { refuseForeignRequest, refuseUnknownHost } from '../../../lib/server/guard';

export const dynamic = 'force-dynamic';

const MAX_VALUE_CHARS = 500;

/** GET /api/settings → provider settings, with API keys reduced to "set or not" */
export async function GET(req: NextRequest) {
  const refusal = refuseUnknownHost(req);
  if (refusal) return refusal;

  try {
    return NextResponse.json(describeSettings());
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/** POST /api/settings { <setting name>: value, … } — "" clears a saved value */
export async function POST(req: NextRequest) {
  const refusal = refuseForeignRequest(req);
  if (refusal) return refusal;

  try {
    const body = await req.json();
    const entries = Object.entries(body || {});

    for (const [name, value] of entries) {
      if (!isSettingName(name)) return NextResponse.json({ error: `Unknown setting: ${name}` }, { status: 400 });
      if (typeof value !== 'string' || value.length > MAX_VALUE_CHARS) {
        return NextResponse.json({ error: `Invalid value for ${name}` }, { status: 400 });
      }
      if (name === 'ollamaUrl' && value.trim() && !/^https?:\/\/[^\s]+$/i.test(value.trim())) {
        return NextResponse.json({ error: 'The Ollama address must start with http:// or https://' }, { status: 400 });
      }
    }
    for (const [name, value] of entries) {
      if (isSettingName(name)) saveSetting(name, value as string);
    }

    return NextResponse.json(describeSettings());
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
