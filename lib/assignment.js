// Seeded, covariate-blocked arm assignment. The algorithm is unchanged from
// the original scripts/assign.js: either a plain permuted-slot shuffle, or —
// given a covariate per account — sort by the covariate and randomise only
// which arm slot each position gets.
import { mulberry32 } from "./messaging.js";

export function seededShuffle(list, seed) {
  const rand = mulberry32(seed);
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function orderAccounts(accounts, covariates, seed) {
  if (covariates) {
    if (covariates.length !== accounts.length) {
      throw new Error("covariates length must match accounts length");
    }
    // Fix the order by the covariate, so blocking is fixed and only the arm
    // slot is left to chance.
    return accounts
      .map((id, i) => ({ id, cov: covariates[i] }))
      .sort((a, b) => a.cov - b.cov)
      .map((x) => x.id);
  }
  return seededShuffle(accounts, seed);
}

export function computeAssignment(accounts, arms, seed, covariates = null) {
  if (accounts.length !== arms.length) {
    throw new Error(`accounts (${accounts.length}) and arms (${arms.length}) must be the same length — one arm slot per account.`);
  }
  const ordered = orderAccounts(accounts, covariates, seed);
  // seed+1, so account ordering and arm ordering aren't correlated draws.
  const shuffledArms = seededShuffle(arms, seed + 1);
  return Object.fromEntries(ordered.map((id, i) => [id, shuffledArms[i]]));
}
