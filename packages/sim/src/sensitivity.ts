// Sensitivity analysis (plan §9.3, `pnpm sim:sensitivity`). No new simulation: the choice
// between the compared candidates is recomputed from the numbers `tune` already recorded while
// the ASSUMPTIONS are varied: each population weight ±50%, the E2 floor at 80 / 85 / 90%, and
// each tier's share of play ±50%.

import { POPULATION_MEMBERS, type Assumptions } from './assumptions';
import { houseRevenue } from './engagement';
import { rankCandidates, type Relaxable, type TuneResult } from './tune';

export interface SensitivityRow {
  scenario: string;
  kind: 'base' | 'population' | 'e2-floor' | 'tier-share';
  /** The candidate the baseline rule would pick under this scenario (null when none passed its gates). */
  selected: string | null;
  selectedH: number | null;
  relaxed: Relaxable[];
  assumptionRangeMet: boolean;
  /** H of the table that was actually selected, re-weighted for this scenario. */
  finalH: number | null;
  /** The pick differs from the pick under the base assumptions. */
  changesSelection: boolean;
}

export interface SensitivityReport {
  schema: 1;
  profile: string;
  generatedAt: string;
  /** Candidates whose last tier was only screened enter with reduced-sample numbers for that tier. */
  note: string;
  baseSelected: string | null;
  rows: SensitivityRow[];
}

function normalise(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => value / total);
}

/** The scenarios, each a complete set of assumptions. */
export function scenarios(base: Assumptions): { scenario: string; kind: SensitivityRow['kind']; assumptions: Assumptions }[] {
  const out: { scenario: string; kind: SensitivityRow['kind']; assumptions: Assumptions }[] = [
    { scenario: 'base assumptions', kind: 'base', assumptions: base },
  ];
  for (const member of POPULATION_MEMBERS) {
    for (const factor of [0.5, 1.5]) {
      const weights = normalise(POPULATION_MEMBERS.map((name) => base.population[name] * (name === member ? factor : 1)));
      const population = { ...base.population };
      POPULATION_MEMBERS.forEach((name, i) => (population[name] = weights[i]));
      out.push({
        scenario: `population weight of ${member} ${factor < 1 ? '-50%' : '+50%'}`,
        kind: 'population',
        assumptions: { ...base, population },
      });
    }
  }
  for (const floor of [0.8, 0.85, 0.9]) {
    out.push({ scenario: `E2 floor ${(100 * floor).toFixed(0)}%`, kind: 'e2-floor', assumptions: { ...base, e2NaiveRtpMin: floor } });
  }
  for (let tier = 0; tier < base.tierShare.length; tier++) {
    for (const factor of [0.5, 1.5]) {
      const tierShare = normalise(base.tierShare.map((share, i) => share * (i === tier ? factor : 1)));
      out.push({ scenario: `share of tier ${tier} ${factor < 1 ? '-50%' : '+50%'}`, kind: 'tier-share', assumptions: { ...base, tierShare } });
    }
  }
  return out;
}

export function sensitivity(result: TuneResult): SensitivityReport {
  const base = rankCandidates(result.candidates, result.assumptions).order[0] ?? null;
  const rows: SensitivityRow[] = scenarios(result.assumptions).map(({ scenario, kind, assumptions }) => {
    const selection = rankCandidates(result.candidates, assumptions);
    const selected = selection.order[0] ?? null;
    const row = selection.rows.find((entry) => entry.name === selected);
    return {
      scenario,
      kind,
      selected,
      selectedH: row?.h ?? null,
      relaxed: selection.relaxed,
      assumptionRangeMet: selection.assumptionRangeMet,
      finalH: result.final === null ? null : houseRevenue(result.final.tiers.map((tier) => tier.population), assumptions).h,
      changesSelection: selected !== base,
    };
  });
  return {
    schema: 1,
    profile: result.profile,
    generatedAt: new Date().toISOString(),
    note:
      'ASSUMPTIONS varied one at a time. Candidates are compared as tune compared them: tiers S and M certified on stream B, ' +
      'the last tier of every candidate screened on a reduced sample of stream A (no fixed gate judged).',
    baseSelected: base,
    rows,
  };
}
