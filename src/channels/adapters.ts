import type { App } from '../app.ts';
import { enabledChannels } from './config.ts';
import { demoWa, metaLinesAdapter } from './lines.ts';
import { waAccountAdapter, type WaAccount } from './meta.ts';
import { dmAdapter, isSocial } from './social.ts';
import type { Channel, ChannelAdapter } from './types.ts';

/** The adapter a channel's messages go through here; a channel whose code is off has none (config.ts). */
export function adapterFor(app: App, channel: Channel = 'whatsapp'): ChannelAdapter {
  if (channel === 'whatsapp') return app.wa;
  if (channel === 'email' && app.mail && enabledChannels(app.env).has('email')) return app.mail;
  throw new Error(`no adapter for channel ${channel}`);
}

/**
 * The adapter of one conversation: a store's own WhatsApp number (Meta) has its own, and so has every Page and
 * Instagram account (they have no shared one); one of our own numbers on Meta (kind meta_line, lines.ts) and a demo
 * conversation, while the demo number is on Meta, go through the Cloud API; everything else is the channel's.
 */
export function adapterOf(app: App, channel: Channel, account?: (WaAccount & { kind?: string | null }) | null): ChannelAdapter {
  if (channel === 'whatsapp' && account?.kind === 'meta') return waAccountAdapter(app.env, app.graph, account);
  if (channel === 'whatsapp' && account?.kind === 'meta_line') return metaLinesAdapter(app);
  if (channel === 'whatsapp' && !account) return demoWa(app);
  if (isSocial(channel)) {
    if (!account || account.kind !== 'meta' || !enabledChannels(app.env).has(channel)) throw new Error(`no adapter for channel ${channel}`);
    return dmAdapter(app.env, app.graph, { ...account, channel });
  }
  return adapterFor(app, channel);
}
