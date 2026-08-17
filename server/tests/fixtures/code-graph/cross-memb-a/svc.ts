// F6 fixture: member-call conservatism — `.ping()` exists here AND in
// cross-memb-b/svc.ts; proximity would prefer this one, but method calls
// never resolve via path proximity.
export class Svc {
  ping(): string { return 'a'; }
}
