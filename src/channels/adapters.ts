import type { App } from '../app.ts';
import { enabledChannels } from './config.ts';
import { metaLinesAdapter } from './lines.ts';
import { waAccountAdapter, type WaAccount } from './meta.ts';
import { dmAdapter, isSocial } from './social.ts';
import { zernioAdapter } from './zernio.ts';
import type { Channel, ChannelAdapter } from './types.ts';
import { webAdapter } from './web.ts';

/** The adapter a channel's messages go through here; a channel whose code is off has none (config.ts). */
export function adapterFor(app: App, channel: Channel = 'whatsapp'): ChannelAdapter {
  if (channel === 'whatsapp') return app.wa;
  if (channel === 'email' && app.mail && enabledChannels(app.env).has('email')) return app.mail;
  if (channel === 'web') return webAdapter();
  throw new Error(`no adapter for channel ${channel}`);
}

/**
 * The adapter of one conversation: a store's own WhatsApp number (Meta) has its own, and so has every Page and
 * Instagram account (they have no shared one); one of our own numbers on Meta (kind meta_line, lines.ts) goes through
 * the Cloud API; everything else is the channel's. A demo conversation has no account: its adapter is the demo
 * number's (lines.ts demoWa, which asks the database whether our one number is connected), so owner.ts picks it.
 */
export function adapterOf(app: App, channel: Channel, account?: (WaAccount & { kind?: string | null }) | null): ChannelAdapter {
  // A store's own number: on Meta with its token, or connected through Kapso (kapso.ts), the same Cloud API bodies
  // through Kapso's proxy.
  if (channel === 'whatsapp' && (account?.kind === 'meta' || account?.kind === 'kapso')) return waAccountAdapter(app.env, app.graph, account);
  if (channel === 'whatsapp' && account?.kind === 'meta_line') return metaLinesAdapter(app);
  if (isSocial(channel)) {
    if (!account || !enabledChannels(app.env).has(channel)) throw new Error(`no adapter for channel ${channel}`);
    // A Page or Instagram account connected through Zernio (zernio.ts) sends through Zernio's inbox API.
    if (account.kind === 'zernio') return zernioAdapter(app, { id: account.id, channel, external_id: account.external_id });
    if (account.kind !== 'meta') throw new Error(`no adapter for channel ${channel}`);
    return dmAdapter(app.env, app.graph, { ...account, channel });
  }
  return adapterFor(app, channel);
}
