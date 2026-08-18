// F8 fixture: noTypeFn declares NO return annotation → it never enters the
// return-type index → an initializerCall to it fails the F8 lookup and FALLS
// THROUGH to the F6 unique-label ladder (receiver-less-style `.name()`
// lookup): `.stop()` is globally unique → INFERRED; `.halt()` is ambiguous
// (declared by both HalterA and HalterB) → still skipped (god-node guard).
export class HalterA {
  halt(): void {}
}

export class HalterB {
  halt(): void {}
}

export function noTypeFn() {
  return {};
}

export function usesNoType(): void {
  const e = noTypeFn();
  e.stop();
}

export function usesAmbig(): void {
  const e = noTypeFn();
  e.halt();
}
