import WebSocket from 'ws';
import * as store from './store';
import { getSetting } from './settings';
import { chatWithOffice } from './chat';

/**
 * Slack as a way to talk to the office. Uses Slack's Socket Mode: the office opens the
 * connection to Slack itself, so nothing on this computer has to be reachable from the internet.
 * Messages from the allowed users go to the front desk; what the office wants the user to know
 * (a plan to approve, a question, a finished report) is posted back to the same conversation.
 */

const API = (process.env.SLACK_API_URL || 'https://slack.com/api').replace(/\/+$/, '');
const RECONNECT_MS = 5000;
const MAX_MESSAGE_CHARS = 3500;
/** Kinds of office events passed on to Slack. */
const NOTABLE = new Set(['report', 'question', 'failed', 'limit']);

interface SlackState {
  socket?: WebSocket;
  status: 'off' | 'connecting' | 'connected' | 'error';
  detail: string;
  /** The tokens the current connection was made with, to notice when the settings change. */
  tokens: string;
  retryAt: number;
  /** Events already handled; Slack sends an event again when the acknowledgement was slow. */
  seen: string[];
  /** The bot's own user id, to tell mentions of it from other text. */
  botUser?: string;
}

const globalForSlack = globalThis as unknown as { __officeSlack?: SlackState };
const slack: SlackState = (globalForSlack.__officeSlack ??= { status: 'off', detail: 'Not set up', tokens: '', retryAt: 0, seen: [] });

export const slackStatus = () => ({ status: slack.status, detail: slack.detail });

const call = async (method: string, token: string, body?: Record<string, unknown>) => {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body || {}),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Slack refused ${method}: ${data.error || res.status}`);
  return data;
};

/** Posts a message to a Slack conversation. Long text is cut: Slack has a limit, and so has patience. */
export const postToSlack = async (channel: string, text: string, thread?: string) => {
  const token = getSetting('slackBotToken');
  if (!token) throw new Error('Slack is not set up.');
  const body = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
  await call('chat.postMessage', token, { channel, text: body, ...(thread ? { thread_ts: thread } : {}) });
};

/** The conversation the user last wrote in: where the office posts what it has to say. */
export const slackHome = () => (slack.status === 'connected' ? store.getMeta('slackHome') || '' : '');

const allowedUsers = () => new Set(getSetting('slackUsers').split(/[\s,]+/).map(u => u.trim()).filter(Boolean));

const handleMessage = async (event: any) => {
  const user: string = event.user || '';
  const channel: string = event.channel || '';
  if (!user || !channel) return;
  // Inside a thread the reply stays in the thread; a direct message is answered in line
  const thread: string | undefined = event.thread_ts || (event.type === 'app_mention' ? event.ts : undefined);
  const said = String(event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!said) return;

  // Anyone in the workspace can write to the bot, but only the listed users may run the office
  if (!allowedUsers().has(user)) {
    await postToSlack(channel, `I only take instructions from the people listed in the office's settings. Your Slack user ID is ${user}: add it under Settings → Slack to talk to me here.`, thread);
    return;
  }

  store.setMeta('slackHome', channel);
  const reply = await chatWithOffice(`slack:${channel}`, said);
  await postToSlack(channel, reply, thread);
};

const connect = async (appToken: string, tokens: string) => {
  slack.tokens = tokens;
  slack.status = 'connecting';
  slack.detail = 'Connecting…';
  try {
    const identity = await call('auth.test', getSetting('slackBotToken'));
    slack.botUser = identity.user_id;
    const { url } = await call('apps.connections.open', appToken);
    const socket = new WebSocket(url);
    slack.socket = socket;

    socket.on('open', () => {
      slack.status = 'connected';
      slack.detail = `Connected${identity.team ? ` to ${identity.team}` : ''}${identity.user ? ` as ${identity.user}` : ''}`;
      // What happened while disconnected is not replayed
      store.setMeta('slackLastEvent', String(store.latestEventId()));
    });

    socket.on('message', raw => {
      let envelope: any;
      try {
        envelope = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // Slack asks for a fresh connection now and then
      if (envelope.type === 'disconnect') return socket.close();
      // Every envelope is acknowledged at once, or Slack sends it again
      if (envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      if (envelope.type !== 'events_api') return;

      const id: string = envelope.payload?.event_id || envelope.envelope_id;
      if (slack.seen.includes(id)) return;
      slack.seen = [...slack.seen.slice(-200), id];

      const event = envelope.payload?.event;
      const direct = event?.type === 'message' && event.channel_type === 'im' && !event.subtype && !event.bot_id;
      const mention = event?.type === 'app_mention' && !event.bot_id;
      if (direct || mention) handleMessage(event).catch(e => console.error('Slack message failed:', e));
    });

    const lost = (why: string) => {
      if (slack.socket !== socket) return;
      slack.socket = undefined;
      slack.status = 'error';
      slack.detail = `Disconnected (${why}). Trying again shortly.`;
      slack.retryAt = Date.now() + RECONNECT_MS;
    };
    socket.on('close', () => lost('connection closed'));
    socket.on('error', e => lost(e.message));
  } catch (e: any) {
    slack.socket = undefined;
    slack.status = 'error';
    slack.detail = e.message;
    slack.retryAt = Date.now() + RECONNECT_MS * 6;
  }
};

/** Tells the user in Slack what the office would otherwise only show in the app. */
const relayEvents = () => {
  const home = slackHome();
  if (!home) return;
  const last = Number(store.getMeta('slackLastEvent')) || 0;
  const events = store.listEvents(last);
  if (events.length === 0) return;
  store.setMeta('slackLastEvent', String(events[events.length - 1].id));
  for (const event of events.filter(e => NOTABLE.has(e.kind)).slice(-5)) {
    postToSlack(home, event.message).catch(e => console.error('Slack post failed:', e));
  }
};

/**
 * Keeps the Slack connection in line with the settings: connects when both tokens are there,
 * reconnects when they change or the connection drops, disconnects when they are removed.
 * Called by the engine on every tick; cheap when nothing changed.
 */
export const ensureSlack = () => {
  const appToken = getSetting('slackAppToken');
  const botToken = getSetting('slackBotToken');
  const tokens = `${appToken}|${botToken}`;

  if (!appToken || !botToken) {
    if (slack.socket) slack.socket.close();
    slack.socket = undefined;
    slack.tokens = '';
    slack.status = 'off';
    slack.detail = appToken || botToken ? 'Both tokens are needed' : 'Not set up';
    return;
  }

  if (slack.tokens !== tokens) {
    // New tokens: drop the old connection and start over
    const old = slack.socket;
    slack.socket = undefined;
    old?.close();
    void connect(appToken, tokens);
  } else if (!slack.socket && slack.status === 'error' && Date.now() >= slack.retryAt) {
    void connect(appToken, tokens);
  }

  if (slack.status === 'connected') relayEvents();
};
