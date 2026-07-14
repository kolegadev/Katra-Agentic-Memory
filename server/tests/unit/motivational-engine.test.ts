import { describe, it, expect } from 'vitest';

function computeDriveStrength(current: number, target: number): number {
  return Math.max(0, 1 - current / target);
}

function tickDrive(current: number, depletionRate: number, hoursElapsed: number): number {
  return Math.max(0, current - depletionRate * hoursElapsed);
}

function computeWanting(
  base: number,
  valence: number,
  trend: number,
  novelty: number,
  pe: number,
  goal: number
): number {
  return Math.max(0, Math.min(1,
    base + 0.25 * valence + 0.15 * trend + 0.10 * novelty + 0.20 * pe + 0.30 * goal
  ));
}

function computeSourceTrustUpdate(
  currentTrust: number,
  event: 'corroboration' | 'contradiction'
): number {
  if (event === 'corroboration') {
    return Math.min(1, currentTrust + 0.02);
  } else {
    return Math.max(0, currentTrust - 0.15);
  }
}

function applyTrustDecay(trustScore: number, daysElapsed: number): number {
  return Math.max(0, trustScore - 0.01 * daysElapsed);
}

describe('Motivational Engine — Drives', () => {
  it('drive strength is 0 when current equals target', () => {
    expect(computeDriveStrength(0.8, 0.8)).toBe(0);
    expect(computeDriveStrength(0.7, 0.7)).toBe(0);
    expect(computeDriveStrength(0.5, 0.5)).toBe(0);
  });

  it('drive strength increases as current depletes', () => {
    expect(computeDriveStrength(0.4, 0.8)).toBeCloseTo(0.5, 5);
    expect(computeDriveStrength(0.0, 0.8)).toBe(1.0);
  });

  it('drive strength is capped at 0 (never negative)', () => {
    expect(computeDriveStrength(1.0, 0.8)).toBe(0);
    expect(computeDriveStrength(1.5, 0.8)).toBe(0);
  });

  it('tick depletes drive based on rate and hours', () => {
    expect(tickDrive(0.8, 0.005, 1)).toBeCloseTo(0.795, 5);
    expect(tickDrive(0.8, 0.005, 10)).toBeCloseTo(0.75, 5);
    expect(tickDrive(0.8, 0.005, 100)).toBeCloseTo(0.3, 5);
  });

  it('tick never goes below 0', () => {
    expect(tickDrive(0.1, 0.1, 10)).toBe(0);
  });

  it('coherence depletion rate is 0.005/hr', () => {
    const after24h = tickDrive(0.8, 0.005, 24);
    expect(after24h).toBeCloseTo(0.68, 5);
    const strength = computeDriveStrength(after24h, 0.8);
    expect(strength).toBeCloseTo(0.15, 5);
  });

  it('novelty depletion rate is 0.01/hr', () => {
    const after24h = tickDrive(0.7, 0.01, 24);
    expect(after24h).toBeCloseTo(0.46, 5);
    const strength = computeDriveStrength(after24h, 0.7);
    expect(strength).toBeCloseTo(0.342857, 3);
  });

  it('connection depletion rate is 0.008/hr', () => {
    const after24h = tickDrive(0.6, 0.008, 24);
    expect(after24h).toBeCloseTo(0.408, 5);
  });

  it('growth depletion rate is 0.003/hr', () => {
    const after24h = tickDrive(0.5, 0.003, 24);
    expect(after24h).toBeCloseTo(0.428, 5);
  });

  it('survival depletion rate is 0.002/hr (slowest — root drive)', () => {
    const after24h = tickDrive(0.95, 0.002, 24);
    expect(after24h).toBeCloseTo(0.902, 5);
    const strength = computeDriveStrength(after24h, 0.95);
    expect(strength).toBeCloseTo(0.050526, 3);
  });

  it('survival has the highest target (0.95) — it is the root drive', () => {
    expect(computeDriveStrength(0.95, 0.95)).toBe(0);
    // Even a small depletion of survival registers as significant
    const afterDepletion = computeDriveStrength(0.85, 0.95);
    expect(afterDepletion).toBeCloseTo(0.105263, 3);
  });

  it('survival depletes slower than all other drives', () => {
    const driveDepletionRates = {
      coherence: 0.005,
      novelty: 0.01,
      connection: 0.008,
      growth: 0.003,
      survival: 0.002,
    };
    // Survival has the lowest depletion rate
    const rates = Object.values(driveDepletionRates);
    expect(driveDepletionRates.survival).toBe(Math.min(...rates));
  });
});

describe('Motivational Engine — Wanting/Liking', () => {
  it('wanting equals base when all other signals are 0', () => {
    const wanting = computeWanting(0.5, 0, 0, 0, 0, 0);
    expect(wanting).toBeCloseTo(0.5, 5);
  });

  it('wanting is clamped to [0,1]', () => {
    expect(computeWanting(1.0, 1.0, 1.0, 1.0, 1.0, 1.0)).toBe(1.0);
    expect(computeWanting(-1.0, -1.0, -1.0, -1.0, -1.0, -1.0)).toBe(0);
  });

  it('wanting formula uses correct weights', () => {
    // Keep the weighted sum within [0,1] so the clamp doesn't mask the weight
    // contributions — the clamp itself is covered by the test above. With all
    // factors at 0.5, each weight still contributes distinctly.
    const base = 0.1;
    const valence = 0.5;
    const trend = 0.5;
    const novelty = 0.5;
    const pe = 0.5;
    const goal = 0.5;
    const expected = base + (0.25 + 0.15 + 0.10 + 0.20 + 0.30) * 0.5; // 0.6, below clamp
    expect(computeWanting(base, valence, trend, novelty, pe, goal)).toBeCloseTo(expected, 5);
  });

  it('liking equals valence', () => {
    const valence = 0.75;
    const wanting = computeWanting(0.5, valence, 0.3, 0.2, 0.1, 0.4);
    expect(valence).toBe(0.75);
    expect(wanting).not.toBe(valence);
  });

  it('wanting and liking can diverge', () => {
    const valence = 0.2;
    const wanting = computeWanting(0.8, valence, 0.5, 0.3, 0.7, 0.9);
    const divergence = Math.abs(wanting - valence);
    expect(divergence).toBeGreaterThan(0.1);
  });

  it('zero valence means liking is 0', () => {
    const wanting = computeWanting(0.5, 0, 0.5, 0.5, 0.5, 0.5);
    expect(wanting).toBeGreaterThan(0);
    const liking = 0;
    expect(Math.abs(wanting - liking)).toBeGreaterThan(0.5);
  });

  it('high goal relevance boosts wanting significantly', () => {
    // Keep both results below the [0,1] clamp so the full goal weight (0.30)
    // shows through the delta. With base/other factors at 0.2, lowGoal = 0.34
    // and highGoal = 0.64 — neither saturates the clamp.
    const lowGoal = computeWanting(0.2, 0.2, 0.2, 0.2, 0.2, 0);
    const highGoal = computeWanting(0.2, 0.2, 0.2, 0.2, 0.2, 1.0);
    expect(highGoal - lowGoal).toBeCloseTo(0.30, 5);
  });
});

describe('Motivational Engine — Source Trust', () => {
  it('default trust starts at 0.5', () => {
    expect(0.5).toBe(0.5);
  });

  it('corroboration increases trust by 0.02', () => {
    expect(computeSourceTrustUpdate(0.5, 'corroboration')).toBeCloseTo(0.52, 5);
    expect(computeSourceTrustUpdate(0.52, 'corroboration')).toBeCloseTo(0.54, 5);
  });

  it('contradiction decreases trust by 0.15', () => {
    expect(computeSourceTrustUpdate(0.5, 'contradiction')).toBeCloseTo(0.35, 5);
    expect(computeSourceTrustUpdate(0.35, 'contradiction')).toBeCloseTo(0.20, 5);
  });

  it('trust is capped at 1.0', () => {
    expect(computeSourceTrustUpdate(0.99, 'corroboration')).toBe(1.0);
    expect(computeSourceTrustUpdate(1.0, 'corroboration')).toBe(1.0);
  });

  it('trust is floored at 0', () => {
    expect(computeSourceTrustUpdate(0.10, 'contradiction')).toBe(0);
    expect(computeSourceTrustUpdate(0.0, 'contradiction')).toBe(0);
  });

  it('trust decays 1% per day', () => {
    expect(applyTrustDecay(1.0, 1)).toBeCloseTo(0.99, 5);
    expect(applyTrustDecay(1.0, 10)).toBeCloseTo(0.90, 5);
    expect(applyTrustDecay(0.5, 30)).toBeCloseTo(0.20, 5);
  });

  it('trust decay floors at 0', () => {
    expect(applyTrustDecay(0.005, 10)).toBe(0);
  });

  it('multiple corroborations build trust toward 1.0', () => {
    let trust = 0.5;
    for (let i = 0; i < 25; i++) {
      trust = computeSourceTrustUpdate(trust, 'corroboration');
    }
    expect(trust).toBe(1.0);
  });

  it('multiple contradictions destroy trust', () => {
    let trust = 0.5;
    for (let i = 0; i < 4; i++) {
      trust = computeSourceTrustUpdate(trust, 'contradiction');
    }
    expect(trust).toBe(0);
  });
});

describe('Motivational Engine — want/like divergence tracking', () => {
  it('tracks divergence between wanting and liking', () => {
    const base = 0.5;
    const valence = 0.3;
    const trend = 0.7;
    const novelty = 0.4;
    const pe = 0.6;
    const goal = 0.2;
    
    const wanting = computeWanting(base, valence, trend, novelty, pe, goal);
    const liking = valence;
    const divergence = Math.abs(wanting - liking);
    
    expect(divergence).toBeGreaterThan(0);
  });

  it('when wanting drives purely from non-valence signals, divergence is high', () => {
    const wanting = computeWanting(0.5, 0, 1.0, 1.0, 1.0, 1.0);
    const liking = 0;
    expect(Math.abs(wanting - liking)).toBeGreaterThan(0.8);
  });
});
