import type { App } from '../app.ts';
import { enabledChannels } from './config.ts';
import { waAccountAdapter, type WaAccount } from './meta.ts';
import type { Channel, ChannelAdapter } from './types.ts';

/** The adapter a channel's messages go through here; a channel whose code is off has none (config.ts). */
export function adapterFor(app: App, channel: Channel = 'whatsapp'): ChannelAdapter {
  if (channel === 'whatsapp') return app.wa;
  if (channel === 'email' && app.mail && enabledChannels(app.env).has('email')) return app.mail;
  throw new Error(`no adapter for channel ${channel}`);
}

/** The adapter of one conversation: a store's own WhatsApp number (Meta) has its own; everything else is the channel's. */
export function adapterOf(app: App, channel: Channel, account?: (WaAccount & { kind?: string | null }) | null): ChannelAdapter {
  if (channel === 'whatsapp' && account?.kind === 'meta') return waAccountAdapter(app.env, app.graph, account);
  return adapterFor(app, channel);
}
