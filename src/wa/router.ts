// Moved to src/channels/ (route.ts routes, demo.ts is the demo number); kept so imports from before the channel layer
// still resolve.
export { handleInbound, type RouteResult } from '../channels/route.ts';
export { BINDING_DAYS, bindingExpiresIn } from '../channels/demo.ts';
