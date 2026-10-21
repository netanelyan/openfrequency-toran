import type { App } from '../app.ts';
import type { Req, Route } from './server.ts';

// The public routes: the pitch pages (/s/<slug>), the tracking beacon and the WhatsApp
// webhook. Filled in by milestones 4 and 5.
export function publicRoutes(_app: App): Route<Req>[] {
  return [];
}
