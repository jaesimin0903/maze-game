// Certification (plan §3.8, §9.3, AC-R6..R8, AC-T3, AC-T4, AC-T10, AC-X7, AC-X8).
//
// Stream B: every bot of the certified suite at the tier's full game count. Fixed gate 1 is
// judged here and nowhere else. Stream D: each adversary (rollout(32), value-lookahead-all) is
// paired with value-lsm on identical mazes; its RTP is value-lsm's stream B estimate plus the
// mean paired difference, with the two variances added. Fixed gate 2 covers every legal bot.
// The calibration claim (stream A, AC-R6) is recomputed from the cached stream A cells rather
// than taken from the calibration's own record.

import { tableHash, type TuningTable } from '@maze/shared';
import { ASSUMPTIONS } from './assumptions';
import { certGamesFromSd, referenceSd } from './bench';
import { GATE2_ONLY, memberLabel } from './bots/index';
import { suiteBots } from './calibrate';
import { tierEngagement, type PopulationRtp, type TierEngagement } from './engagement';
import { BOT_VARIANTS } from './exact';
import { byTier, resolvePairGames } from './profile';
import { botLabel, tierRef, type BotDef, type CellResult, type Runner } from './runner';
import { searchTheta } from './search';
import { sumOfIndependent, tostProportions, type TostResult } from './stats';
import { STREAM_NAMES, streamIdentifiers, streamsAreDisjoint, type StreamName } from './streams';
import {
  BEST_POINT_RANGE,
  certifyKeyOf,
  readJsonFile,
  tierEconomicsOf,
  WINDOW_BPS,
  writeJsonFile,
  type ReportPaths,
  type TableMeta,
} from './tables';

/** AC-X8: harmonic's win rate by start direction, equivalent within 3% of the pooled rate at α = 0.01, on `profile.symmetryMinGames` games or more. */
const SYMMETRY_MARGIN = 0.03;
const SYMMETRY_ALPHA = 0.01;

export interface CellReport {
  bot: string;
  stream: StreamName;
  games: number;
  /** Return to player as a fraction of the bet. */
  rtp: number;
  sd: number;
  se: number;
  ci95: [number, number];
  /** One-sided 97.5% upper confidence bound. */
  ucb975: number;
  winRate: number;
  /** The cell holds exact per-maze expectations (random-walk), not sampled games. */
  expected: boolean;
  /** Games cashed out after `k` moves, by `k`. */
  cash: number[];
  /** Cache key and chunk count of the cell. */
  key: string;
  chunks: number;
}

export interface PairReport {
  adversary: string;
  reference: string;
  stream: 'D';
  pilotPairs: number;
  pilotSd: number;
  /** `min(cap, max(floor, (1.96 × sd / 0.005)²))`. */
  pairs: number;
  /** True when the cap decided the count; then `halfWidthDiff` is the half-width that was achieved. */
  capped: boolean;
  meanDiff: number;
  sdDiff: number;
  seDiff: number;
  halfWidthDiff: number;
  /** Lower 97.5% bound of the mean difference: positive means the adversary beats value-lsm. */
  diffLcb: number;
  /** Adversary RTP = value-lsm on stream B + mean difference; variances added. */
  rtp: number;
  se: number;
  ucb975: number;
  key: string;
}

export interface GateCheck {
  limit: number;
  /** The bot closest to (or furthest over) the limit and its bound. */
  worst: string;
  value: number;
  pass: boolean;
}

export interface CalibrationCheck {
  /** `ok`: U on stream A recomputed from cached cells; `missing`: the table has no calibration record; `screened`: reduced-sample multiplier only. */
  status: 'ok' | 'missing' | 'screened';
  ceilingBps: number | null;
  /** Largest upper bound over the contenders on stream A at the table's multiplier, the bot that attains it and its point estimate. */
  u: number | null;
  best: string | null;
  bestRtp: number | null;
  windowMissed: boolean;
  contenders: CellReport[];
  pass: boolean;
}

export interface TierCertification {
  tier: number;
  n: number;
  multiplierBps: number;
  games: number;
  variantLevel: number;
  theta: number[];
  cells: CellReport[];
  pairs: PairReport[];
  calibration: CalibrationCheck;
  /** The suite bot with the largest upper bound on stream B. */
  best: { bot: string; rtp: number; ucb975: number };
  gates: {
    gate1: GateCheck;
    gate2: GateCheck;
    /**
     * AC-R6: the best bot's point estimate at the adopted multiplier lies in [94.0%, 96.0%]. It
     * is read on the calibration sample (stream A), where the upper end cannot contradict the
     * ceiling (the point estimate is below U): a one-sided condition, as plan §3.8 says.
     */
    bestPoint: { value: number | null; stream: 'A'; range: [number, number]; pass: boolean };
    /** N1: best bot's point estimate minus refund(0) is positive. */
    playPremium: { value: number; pass: boolean };
    /** AC-X8 on the harmonic cell. */
    startSymmetry: TostResult & { gamesEast: number; gamesSouth: number; requiredGames: number; sufficientSample: boolean; pass: boolean };
  };
  /** ASSUMPTION-based metrics. */
  engagement: TierEngagement;
  population: PopulationRtp;
  pass: boolean;
}

export interface TableCertification {
  tableHash: string;
  certifyKey: string;
  tablePath: string;
  profile: string;
  simCodeHash: string;
  generatedAt: string;
  /** Every tier of the table is covered. */
  complete: boolean;
  tiers: TierCertification[];
  /** Every covered tier passed every gate. */
  pass: boolean;
}

export interface CertifyFile {
  schema: 1;
  simCodeHash: string;
  /** Base seeds of the streams, and the check that their seed ranges do not intersect. */
  streams: Record<StreamName, string>;
  streamsDisjoint: boolean;
  tables: Record<string, TableCertification>;
}

export function cellReport(cell: CellResult): CellReport {
  return {
    bot: cell.label,
    stream: cell.stream,
    games: cell.games,
    rtp: cell.rtp.mean,
    sd: cell.rtp.sd,
    se: cell.rtp.se,
    ci95: cell.rtp.ci,
    ucb975: cell.rtp.ucb,
    winRate: cell.winRate,
    expected: cell.stats.expected,
    cash: cell.stats.cash,
    key: cell.key,
    chunks: cell.chunks,
  };
}

export interface CertifyTierInput {
  table: TuningTable;
  tierIndex: number;
  meta: TableMeta | null;
}

/** Certifies one tier of a table. */
export async function certifyTier(runner: Runner, paths: ReportPaths, input: CertifyTierInput): Promise<TierCertification> {
  const { table, tierIndex, meta } = input;
  const config = table.tiers[tierIndex];
  const econ = tierEconomicsOf(config);
  const tier = tierRef(econ);
  const profile = runner.profile;
  const tierMeta = meta?.tiers[tierIndex] ?? null;
  const variantLevel = meta?.variantLevel ?? 0;
  const variant = BOT_VARIANTS[variantLevel];
  const games = tierMeta?.games ?? certGamesFromSd(profile, tierIndex, await referenceSd(runner, paths, tierIndex, config.n, config.curve));
  // Without a calibration record the θ is searched at the table's own multiplier.
  const theta = tierMeta?.theta ?? (await searchTheta(runner, tier)).theta;

  // Stream B: the certified suite.
  const suite = await suiteBots(runner, tier, tierIndex, variant, theta);
  const cells: CellResult[] = [];
  for (const def of suite) cells.push(await runner.evalCell(tier, def, 'B', games));
  const byLabel = new Map(cells.map((cell) => [cell.label, cell]));
  const reference = byLabel.get('value-lsm')!;
  const best = cells.reduce((a, b) => (b.rtp.ucb > a.rtp.ucb ? b : a));

  // Stream D: the adversaries, paired with value-lsm.
  const referenceDef = suite.find((def) => def.bot === 'value-lsm')!;
  const valueTable = (referenceDef as Extract<BotDef, { bot: 'value-lsm' }>).table;
  const pairs: PairReport[] = [];
  for (const member of GATE2_ONLY) {
    const adversary: BotDef =
      member.bot === 'rollout' ? { bot: 'rollout', samples: member.samples, table: valueTable } : { bot: 'value-lookahead-all', table: valueTable };
    const pilot = await runner.pairCell(tier, adversary, referenceDef, 'D', profile.pairPilot);
    const wanted = resolvePairGames(profile, tierIndex, pilot.diff.sd);
    const full = await runner.pairCell(tier, adversary, referenceDef, 'D', wanted);
    const combined = sumOfIndependent({ mean: reference.rtp.mean, se: reference.rtp.se }, { mean: full.diff.mean, se: full.diff.se });
    pairs.push({
      adversary: memberLabel(member),
      reference: botLabel(referenceDef),
      stream: 'D',
      pilotPairs: profile.pairPilot,
      pilotSd: pilot.diff.sd,
      pairs: wanted,
      capped: wanted === profile.pairCap,
      meanDiff: full.diff.mean,
      sdDiff: full.diff.sd,
      seDiff: full.diff.se,
      halfWidthDiff: full.diff.halfWidth,
      diffLcb: full.diff.lcb,
      rtp: combined.mean,
      se: combined.se,
      ucb975: combined.ucb,
      key: full.key,
    });
  }

  // Gates.
  const gate1Limit = table.calibration.gate1Bps / 10_000;
  const gate2Limit = table.calibration.gate2Bps / 10_000;
  const gate1: GateCheck = { limit: gate1Limit, worst: best.label, value: best.rtp.ucb, pass: best.rtp.ucb <= gate1Limit };
  const worstAdversary = pairs.reduce((a, b) => (b.ucb975 > a.ucb975 ? b : a));
  const gate2Worst = worstAdversary.ucb975 > best.rtp.ucb ? { worst: worstAdversary.adversary, value: worstAdversary.ucb975 } : { worst: best.label, value: best.rtp.ucb };
  const gate2: GateCheck = { limit: gate2Limit, ...gate2Worst, pass: gate2Worst.value <= gate2Limit };

  // Calibration claim, recomputed from stream A.
  const calibration: CalibrationCheck = {
    status: tierMeta === null ? 'missing' : tierMeta.screened ? 'screened' : 'ok',
    ceilingBps: tierMeta?.ceilingBps ?? null,
    u: null,
    best: null,
    bestRtp: null,
    windowMissed: false,
    contenders: [],
    pass: false,
  };
  if (tierMeta !== null && !tierMeta.screened && tierMeta.multiplierBps === config.multiplierBps) {
    let top: CellResult | null = null;
    for (const def of suite) {
      if (!tierMeta.contenders.includes(botLabel(def))) continue;
      const cell = await runner.evalCell(tier, def, 'A', games);
      calibration.contenders.push(cellReport(cell));
      if (top === null || cell.rtp.ucb > top.rtp.ucb) top = cell;
    }
    if (top !== null) {
      const ceiling = tierMeta.ceilingBps / 10_000;
      calibration.u = top.rtp.ucb;
      calibration.best = top.label;
      calibration.bestRtp = top.rtp.mean;
      calibration.windowMissed = top.rtp.ucb < ceiling - WINDOW_BPS / 10_000;
      calibration.pass = top.rtp.ucb <= ceiling && tierMeta.ceilingBps <= table.calibration.ceilingBps;
    }
  } else if (tierMeta !== null && tierMeta.multiplierBps !== config.multiplierBps) {
    calibration.status = 'missing';
  }

  const harmonic = byLabel.get('harmonic')!.stats;
  const requiredGames = byTier(profile.symmetryMinGames, tierIndex);
  const tost = tostProportions({
    successes1: harmonic.winsE,
    n1: harmonic.startE,
    successes2: harmonic.wins - harmonic.winsE,
    n2: harmonic.n - harmonic.startE,
    relativeMargin: SYMMETRY_MARGIN,
    alpha: SYMMETRY_ALPHA,
  });
  const sufficientSample = harmonic.n >= requiredGames;
  const startSymmetry = {
    ...tost,
    gamesEast: harmonic.startE,
    gamesSouth: harmonic.n - harmonic.startE,
    requiredGames,
    sufficientSample,
    pass: tost.equivalent && sufficientSample,
  };

  const naive = byLabel.get('naive-greedy')!;
  const sloppy = [...byLabel.values()].find((cell) => cell.bot.bot === 'sloppy-greedy')!;
  const nervous = [...byLabel.values()].find((cell) => cell.bot.bot === 'nervous')!;
  const randomWalk = byLabel.get('random-walk')!;
  const engagement = tierEngagement(
    tierIndex,
    econ,
    { naive: naive.stats, sloppy: sloppy.stats, best: best.stats, reference: reference.stats },
    ASSUMPTIONS,
    profile.sessions,
  );
  const population: PopulationRtp = {
    'naive-greedy': { rtp: naive.rtp.mean, se: naive.rtp.se },
    'sloppy-greedy': { rtp: sloppy.rtp.mean, se: sloppy.rtp.se },
    nervous: { rtp: nervous.rtp.mean, se: nervous.rtp.se },
    'random-walk': { rtp: randomWalk.rtp.mean, se: randomWalk.rtp.se },
    best: { rtp: best.rtp.mean, se: best.rtp.se },
  };
  const calibrationPoint = calibration.bestRtp;
  const bestPoint = {
    value: calibrationPoint,
    stream: 'A' as const,
    range: BEST_POINT_RANGE,
    pass: calibrationPoint !== null && calibrationPoint >= BEST_POINT_RANGE[0] && calibrationPoint <= BEST_POINT_RANGE[1],
  };
  const playPremium = { value: engagement.n1PlayPremium, pass: engagement.n1PlayPremium > 0 };

  return {
    tier: tierIndex,
    n: config.n,
    multiplierBps: config.multiplierBps,
    games,
    variantLevel,
    theta,
    cells: cells.map(cellReport),
    pairs,
    calibration,
    best: { bot: best.label, rtp: best.rtp.mean, ucb975: best.rtp.ucb },
    gates: { gate1, gate2, bestPoint, playPremium, startSymmetry },
    engagement,
    population,
    pass: gate1.pass && gate2.pass && calibration.pass && bestPoint.pass && playPremium.pass && startSymmetry.pass,
  };
}

/** Certifies the given tiers of a table (all of them by default) and records the result in `certify.json`. */
export async function certifyTable(
  runner: Runner,
  paths: ReportPaths,
  tablePath: string,
  table: TuningTable,
  meta: TableMeta | null,
  tierIndexes?: readonly number[],
): Promise<TableCertification> {
  const indexes = tierIndexes ?? table.tiers.map((_, i) => i);
  const tiers: TierCertification[] = [];
  for (const tierIndex of indexes) tiers.push(await certifyTier(runner, paths, { table, tierIndex, meta }));
  const hash = tableHash(table);
  const certification: TableCertification = {
    tableHash: hash,
    certifyKey: certifyKeyOf(hash, runner.codeHash, runner.profile.name),
    tablePath,
    profile: runner.profile.name,
    simCodeHash: runner.codeHash,
    generatedAt: new Date().toISOString(),
    complete: indexes.length === table.tiers.length,
    tiers,
    pass: tiers.every((tier) => tier.pass),
  };
  if (!runner.readOnly) recordCertification(paths, runner.codeHash, certification);
  return certification;
}

/** Adds a table's certification to `certify.json`, dropping entries made by other simulator code. */
export function recordCertification(paths: ReportPaths, simCodeHash: string, certification: TableCertification): void {
  const existing = readJsonFile<CertifyFile>(paths.certifyJson);
  const tables: Record<string, TableCertification> = {};
  if (existing !== null && existing.schema === 1 && existing.simCodeHash === simCodeHash) Object.assign(tables, existing.tables);
  const previous = tables[certification.tableHash];
  // A partial run must not replace a complete record of the same table.
  if (previous === undefined || !previous.complete || certification.complete) tables[certification.tableHash] = certification;
  let disjoint = true;
  for (let i = 0; i < STREAM_NAMES.length; i++) {
    for (let j = i + 1; j < STREAM_NAMES.length; j++) disjoint &&= streamsAreDisjoint(STREAM_NAMES[i], STREAM_NAMES[j]);
  }
  const file: CertifyFile = { schema: 1, simCodeHash, streams: streamIdentifiers(), streamsDisjoint: disjoint, tables };
  writeJsonFile(paths.certifyJson, file);
}

/** One line per gate for the console. */
export function formatCertification(c: TableCertification): string {
  const lines: string[] = [];
  const pct = (x: number): string => `${(100 * x).toFixed(3)}%`;
  lines.push(`sim:certify  table ${c.tableHash}  profile=${c.profile}  complete=${c.complete}  pass=${c.pass}`);
  for (const tier of c.tiers) {
    lines.push(`tier ${tier.tier}: ${tier.n}x${tier.n} at ${(tier.multiplierBps / 10_000).toFixed(4)}x  N=${tier.games}  ${tier.pass ? 'PASS' : 'FAIL'}`);
    lines.push(`  gate 1 (stream B, suite UCB <= ${pct(tier.gates.gate1.limit)}): ${tier.gates.gate1.worst} ${pct(tier.gates.gate1.value)}  ${tier.gates.gate1.pass ? 'pass' : 'FAIL'}`);
    lines.push(`  gate 2 (all legal bots UCB <= ${pct(tier.gates.gate2.limit)}): ${tier.gates.gate2.worst} ${pct(tier.gates.gate2.value)}  ${tier.gates.gate2.pass ? 'pass' : 'FAIL'}`);
    for (const pair of tier.pairs) {
      lines.push(
        `    ${pair.adversary}: point ${pct(pair.rtp)} UCB ${pct(pair.ucb975)}  D mean ${pct(pair.meanDiff)} ± ${pct(pair.halfWidthDiff)}  pairs ${pair.pairs}${pair.capped ? ' (cap)' : ''}`,
      );
    }
    const cal = tier.calibration;
    lines.push(
      `  calibration (stream A): ${cal.status}` +
        (cal.u === null ? '' : `  U ${pct(cal.u)} (${cal.best}) vs ceiling ${cal.ceilingBps} bps${cal.windowMissed ? '  window missed' : ''}`) +
        `  ${cal.pass ? 'pass' : 'FAIL'}`,
    );
    lines.push(
      `  best bot point on stream A ${tier.gates.bestPoint.value === null ? 'n/a' : pct(tier.gates.bestPoint.value)} in [94%, 96%]: ${tier.gates.bestPoint.pass ? 'pass' : 'FAIL'};  ` +
        `stream B best ${tier.best.bot} ${pct(tier.best.rtp)} (realised edge ${pct(1 - tier.best.rtp)});  play premium ${pct(tier.gates.playPremium.value)}: ${tier.gates.playPremium.pass ? 'pass' : 'FAIL'}`,
    );
    const sym = tier.gates.startSymmetry;
    lines.push(
      `  start symmetry (harmonic win rate E−S ${pct(sym.diff)}, margin ±${pct(sym.margin)}, ${sym.gamesEast + sym.gamesSouth} games, need ${sym.requiredGames}): ${sym.pass ? 'pass' : 'FAIL'}`,
    );
  }
  return lines.join('\n');
}
