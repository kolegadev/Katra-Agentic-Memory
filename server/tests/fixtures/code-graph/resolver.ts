// TS-style specifier resolution: '.js' targets resolve to real '.ts' sources.
import { ping } from './target.js';
import { pong } from './nested/index.js';

export function usePing(): string {
  return ping();
}
