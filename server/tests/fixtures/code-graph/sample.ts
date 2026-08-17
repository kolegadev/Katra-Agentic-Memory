// Fixture: structural extraction sample for the F2 extractor tests.
import { Widget } from './widget';
import './side-effect';
import lodash from 'lodash';

export interface Greeter {
  greet(name: string): string;
}

export enum Color {
  Red = 'red',
  Green = 'green',
}

export class WidgetBox {
  private widgets: Widget[] = [];

  add(w: Widget): void {
    this.widgets.push(w);
    this.count();
  }

  count(): number {
    return this.widgets.length;
  }
}

export function createBox(): WidgetBox {
  return new WidgetBox();
}

export function describeBox(): string {
  const box = createBox();
  const total = box.count();
  return `${total}`;
}
