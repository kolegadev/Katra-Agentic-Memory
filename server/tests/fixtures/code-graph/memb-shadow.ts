// F7 fixture: scope shadowing — the innermost declaration of a name wins at
// each call site. `s` is `Store` in the outer scope and shadowed by `Other`
// inside `inner`; each call must carry its own call site's receiver type.
export function shadow(): void {
  let s: Store;
  s.m();
  function inner(): void {
    let s: Other;
    s.m();
  }
}
