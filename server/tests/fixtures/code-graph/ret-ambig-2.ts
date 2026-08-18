// F8 fixture: the SECOND declaration of makeIt(), returning a different
// class (EngineB) — see ret-ambig-1.ts for the ambiguity story.
export class EngineB {
  goB(): void {}
}

export function makeIt(): EngineB {
  return new EngineB();
}
