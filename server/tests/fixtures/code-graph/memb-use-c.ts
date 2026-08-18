// F7 fixture: receiver typed by a parameter annotation → typeSource 'parameter'.
import { Store } from './memb-lib.js';
export function param(s: Store): number { return s.count(); }
