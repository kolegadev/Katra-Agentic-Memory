// F7 fixture: parameter-typed receiver with an AMBIGUOUS type name and no
// import binding → skipped (god-node guard).
export function dupCall(d: Dup): void { d.ping(); }
