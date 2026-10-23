import type { App } from '../app.ts';
import { enabledChannels } from './config.ts';
import type { Channel, ChannelAdapter } from './types.ts';

/** The adapter a channel's messages go through here; a channel whose code is off has none (config.ts). */
export function adapterFor(app: App, channel: Channel = 'whatsapp'): ChannelAdapter {
  if (channel === 'whatsapp') return app.wa;
  if (channel === 'email' && app.mail && enabledChannels(app.env).has('email')) return app.mail;
  throw new Error(`no adapter for channel ${channel}`);
}
