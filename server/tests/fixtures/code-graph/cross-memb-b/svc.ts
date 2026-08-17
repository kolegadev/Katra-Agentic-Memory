// F6 fixture: second `.ping()` definition — makes member calls ambiguous.
export class Svc {
  ping(): string { return 'b'; }
}
