// F6 fixture: `s.ping()` is a member call with two candidates and no import
// evidence — conservatively skipped even though proximity has a winner.
export function runM(s: any): void { s.ping(); }
