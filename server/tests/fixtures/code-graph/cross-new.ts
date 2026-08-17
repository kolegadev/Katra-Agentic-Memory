// F6 fixture: `new Widget()` resolves to the cross-class.ts class node.
import { Widget } from './cross-class.js';

export function make() { return new Widget(); }
