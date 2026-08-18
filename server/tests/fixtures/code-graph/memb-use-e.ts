// F7 fixture: genuinely untyped receiver (`any` is a predefined type) → no
// receiver facts; `.whatever()` exists in TWO files so the F6 ladder skips.
export function anyRecv(x: any): void { x.whatever(); }
