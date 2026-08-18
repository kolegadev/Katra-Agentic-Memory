// F8 fixture: cross-file return-type library — makeEngine()'s declared
// return type `Engine` propagates to initializer receivers in other files.
export class Engine {
  start(): void {}
  stop(): void {}
}

export function makeEngine(): Engine {
  return new Engine();
}
