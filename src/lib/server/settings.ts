import { getMeta, setMeta } from './store';

/**
 * Provider settings saved from the settings screen. A saved value wins over the matching
 * environment variable, so `.env.local` keeps working and the desktop app needs no file at all.
 */
export const SETTINGS = {
  openaiKey: { env: 'OPENAI_API_KEY', secret: true, fallback: '' },
  grokKey: { env: 'GROK_API_KEY', secret: true, fallback: '' },
  anthropicKey: { env: 'ANTHROPIC_API_KEY', secret: true, fallback: '' },
  geminiKey: { env: 'GEMINI_API_KEY', secret: true, fallback: '' },
  openaiModel: { env: 'OPENAI_MODEL', secret: false, fallback: 'gpt-4o-mini' },
  grokModel: { env: 'GROK_MODEL', secret: false, fallback: 'grok-3' },
  anthropicModel: { env: 'ANTHROPIC_MODEL', secret: false, fallback: 'claude-opus-5-5' },
  geminiModel: { env: 'GEMINI_MODEL', secret: false, fallback: 'gemini-2.5-flash' },
  ollamaUrl: { env: 'OLLAMA_URL', secret: false, fallback: 'http://127.0.0.1:11434' },
  ollamaModel: { env: 'OLLAMA_MODEL', secret: false, fallback: 'llama3' },
  /** Slack: the app-level token (xapp-…) that opens the connection, and the bot token (xoxb-…) that posts replies. */
  slackAppToken: { env: 'SLACK_APP_TOKEN', secret: true, fallback: '' },
  slackBotToken: { env: 'SLACK_BOT_TOKEN', secret: true, fallback: '' },
  /** Slack user IDs allowed to talk to the office, separated by commas. Nobody else is answered. */
  slackUsers: { env: 'SLACK_ALLOWED_USERS', secret: false, fallback: '' },
  /** 'on' lets agents search the web and read pages. */
  webAccess: { env: 'OFFICE_WEB_ACCESS', secret: false, fallback: 'on' },
  /** 'on' makes new tasks start with a plan the user approves. Each task can still be assigned without one. */
  planFirst: { env: 'OFFICE_PLAN_FIRST', secret: false, fallback: 'on' },
  /** 'on' lets the office run a project's tests on this computer. Off unless the user turns it on. */
  allowChecks: { env: 'OFFICE_ALLOW_CHECKS', secret: false, fallback: 'off' },
} as const;

export type SettingName = keyof typeof SETTINGS;

export const isSettingName = (name: string): name is SettingName => name in SETTINGS;

const saved = (name: SettingName) => getMeta(`setting:${name}`) || '';

/** The value in effect: saved in the app, else from the environment, else the default. */
export const getSetting = (name: SettingName) =>
  saved(name) || process.env[SETTINGS[name].env] || SETTINGS[name].fallback;

/** An empty value removes the saved setting, falling back to the environment or the default. */
export const saveSetting = (name: SettingName, value: string) => setMeta(`setting:${name}`, value.trim());

/** What the settings screen may see. Keys are never sent back, only whether one is set and how it ends. */
export const describeSettings = () =>
  Object.fromEntries((Object.keys(SETTINGS) as SettingName[]).map(name => {
    const value = getSetting(name);
    const source = saved(name) ? 'app' : process.env[SETTINGS[name].env] ? 'environment' : 'default';
    return [name, SETTINGS[name].secret
      ? { set: Boolean(value), hint: value ? `…${value.slice(-4)}` : '', source }
      : { value, source }];
  }));
