// F7 fixture: receiver typed by an explicit annotation → typeSource 'annotation'.
import { Store } from './memb-lib.js';
export function annot(): void { const s: Store = new Store(); s.count(); }
