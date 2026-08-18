// F7 fixture: bare `this` receiver → typeSource 'this' with the enclosing
// class name. `.step()` is ambiguous in-file (Base.step + Derived.step) so
// the call becomes a rawCall; the receiver type disambiguates to Derived.
class Base {
  step(): void {}
}
export class Derived extends Base {
  step(): void {}
  go(): void {
    this.step();
  }
}
