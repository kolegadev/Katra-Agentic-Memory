// F7 fixture: receiver typed by a `new T()` initializer → typeSource 'new'.
import { Store } from './memb-lib.js';
export function cons(): void { const s = new Store(); s.push(1); }
