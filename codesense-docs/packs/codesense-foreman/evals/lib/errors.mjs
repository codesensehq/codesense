// SPDX-License-Identifier: MIT
// A sandbox or API failure: the run is `error`, not `fail`. `cost_usd`, when set, is what the
// failed attempt spent, so the runner still counts it.
export class InfraError extends Error {
  constructor(message, { cost_usd = 0 } = {}) {
    super(message);
    this.cost_usd = cost_usd;
  }
}
