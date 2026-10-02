// Resumable cache of simulation results (plan §9.3, AC-T9).
//
//   <root>/<key>/cell.json         the cell definition the key was derived from
//   <root>/<key>/chunk-<i>.json    sufficient statistics of chunk i of that cell
//   <root>/artifacts/<key>.json    trained tables and recorded trajectories (layout)
//   <root>/artifacts/<key>.bin     … and their raw arrays
//   <root>/ledger.json             accumulated run time per cell and per campaign (seconds), and games simulated by kind
//
//   key = sha256( tierHash ‖ simulator code hash ‖ canonical JSON of the cell definition )
//
// `tierHash` is the hash of the economics the cell was played under (grid, multiplier, refund
// table). A change to that tier of the table, to the simulator code, or to any field of the cell
// definition therefore gives a different key, and a result computed for something else can
// never be read back. Files are written to a temporary name and renamed, so a killed process
// leaves either a complete file or none.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { TierEconomics } from './engine';

/** JSON with object keys sorted, so equal values always serialise to the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    if (value === undefined) throw new TypeError('canonicalJson: undefined');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/** Hash of the economics of one tier. */
export function tierHash(econ: TierEconomics): string {
  return sha256Hex(
    canonicalJson({ w: econ.w, h: econ.h, multiplierBps: econ.multiplierBps, refundBps: Array.from(econ.refundBps) }),
  );
}

/** Cache key of a cell or an artifact. */
export function cacheKey(tier: string, codeHash: string, definition: unknown): string {
  return sha256Hex(`${tier}|${codeHash}|${canonicalJson(definition)}`);
}

function writeAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

export interface ChunkRecord<S> {
  schema: 1;
  key: string;
  chunk: number;
  /** Games `from .. to - 1` of the cell's stream. */
  from: number;
  to: number;
  /** Wall-clock seconds the chunk took to compute. */
  seconds: number;
  stats: S;
}

export type ArtifactArray = Float64Array | Uint8Array | Uint16Array;

export interface Artifact {
  meta: Record<string, unknown>;
  arrays: Record<string, ArtifactArray>;
}

type ArrayType = 'f64' | 'u8' | 'u16';

interface ArtifactHeader {
  schema: 1;
  key: string;
  meta: Record<string, unknown>;
  layout: { name: string; type: ArrayType; length: number; offset: number }[];
  bytes: number;
}

function typeOf(array: ArtifactArray): ArrayType {
  if (array instanceof Float64Array) return 'f64';
  if (array instanceof Uint16Array) return 'u16';
  return 'u8';
}

const BYTES: Record<ArrayType, number> = { f64: 8, u8: 1, u16: 2 };

interface Ledger {
  cells: Record<string, number>;
  campaigns: Record<string, number>;
  /** Games simulated, by kind of work (`eval:B`, `pair:D`, `train:C`, …). Counted once, when the unit is computed. */
  games: Record<string, number>;
}

export class CacheStore {
  private ledger: Ledger | null = null;

  constructor(readonly root: string) {}

  private chunkPath(key: string, chunk: number): string {
    return join(this.root, key, `chunk-${chunk}.json`);
  }

  /** Records what a key stands for. Written once, next to the chunks. */
  writeCellDefinition(key: string, definition: unknown): void {
    const path = join(this.root, key, 'cell.json');
    if (!existsSync(path)) writeAtomic(path, `${canonicalJson(definition)}\n`);
  }

  /** The chunk if it is on disk and is the chunk asked for; otherwise null. */
  readChunk<S extends { n: number }>(key: string, chunk: number, from: number, to: number): ChunkRecord<S> | null {
    const raw = readJson(this.chunkPath(key, chunk)) as ChunkRecord<S> | null;
    if (raw === null || typeof raw !== 'object') return null;
    if (raw.schema !== 1 || raw.key !== key || raw.chunk !== chunk || raw.from !== from || raw.to !== to) return null;
    if (typeof raw.stats !== 'object' || raw.stats === null || raw.stats.n !== to - from) return null;
    return raw;
  }

  writeChunk<S>(record: ChunkRecord<S>): void {
    writeAtomic(this.chunkPath(record.key, record.chunk), `${JSON.stringify(record)}\n`);
  }

  private artifactPath(key: string, extension: 'json' | 'bin'): string {
    return join(this.root, 'artifacts', `${key}.${extension}`);
  }

  hasArtifact(key: string): boolean {
    return existsSync(this.artifactPath(key, 'json'));
  }

  /** Arrays are returned on SharedArrayBuffers so that they can be handed to workers without copying. */
  readArtifact(key: string): Artifact | null {
    const header = readJson(this.artifactPath(key, 'json')) as ArtifactHeader | null;
    if (header === null || header.schema !== 1 || header.key !== key) return null;
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(this.artifactPath(key, 'bin'));
    } catch {
      return null;
    }
    if (bytes.length !== header.bytes) return null;
    const arrays: Record<string, ArtifactArray> = {};
    for (const entry of header.layout) {
      const byteLength = entry.length * BYTES[entry.type];
      const shared = new SharedArrayBuffer(Math.max(8, byteLength));
      new Uint8Array(shared).set(bytes.subarray(entry.offset, entry.offset + byteLength));
      arrays[entry.name] =
        entry.type === 'f64'
          ? new Float64Array(shared, 0, entry.length)
          : entry.type === 'u16'
            ? new Uint16Array(shared, 0, entry.length)
            : new Uint8Array(shared, 0, entry.length);
    }
    return { meta: header.meta, arrays };
  }

  writeArtifact(key: string, artifact: Artifact): void {
    const layout: ArtifactHeader['layout'] = [];
    let offset = 0;
    for (const name of Object.keys(artifact.arrays).sort()) {
      const array = artifact.arrays[name];
      layout.push({ name, type: typeOf(array), length: array.length, offset });
      offset += Math.ceil(array.byteLength / 8) * 8;
    }
    const bytes = new Uint8Array(offset);
    for (const entry of layout) {
      const array = artifact.arrays[entry.name];
      bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), entry.offset);
    }
    // The header is the commit point: a reader that finds it also finds the complete data file.
    writeAtomic(this.artifactPath(key, 'bin'), bytes);
    const header: ArtifactHeader = { schema: 1, key, meta: artifact.meta, layout, bytes: offset };
    writeAtomic(this.artifactPath(key, 'json'), `${JSON.stringify(header)}\n`);
  }

  private loadLedger(): Ledger {
    if (this.ledger === null) {
      const raw = readJson(join(this.root, 'ledger.json')) as Partial<Ledger> | null;
      this.ledger = { cells: { ...(raw?.cells ?? {}) }, campaigns: { ...(raw?.campaigns ?? {}) }, games: { ...(raw?.games ?? {}) } };
    }
    return this.ledger;
  }

  private saveLedger(): void {
    writeAtomic(join(this.root, 'ledger.json'), `${JSON.stringify(this.loadLedger())}\n`);
  }

  /** Total seconds spent computing a cell, over every call so far. */
  cellSeconds(key: string): number {
    return this.loadLedger().cells[key] ?? 0;
  }

  addCellSeconds(key: string, seconds: number): void {
    const ledger = this.loadLedger();
    ledger.cells[key] = (ledger.cells[key] ?? 0) + seconds;
    this.saveLedger();
  }

  /** Seconds accumulated under every campaign name. */
  campaignTimes(): Record<string, number> {
    return { ...this.loadLedger().campaigns };
  }

  addGames(kind: string, games: number): void {
    const ledger = this.loadLedger();
    ledger.games[kind] = (ledger.games[kind] ?? 0) + games;
    this.saveLedger();
  }

  gamesByKind(): Record<string, number> {
    return { ...this.loadLedger().games };
  }

  campaignSeconds(name: string): number {
    return this.loadLedger().campaigns[name] ?? 0;
  }

  addCampaignSeconds(name: string, seconds: number): void {
    const ledger = this.loadLedger();
    ledger.campaigns[name] = (ledger.campaigns[name] ?? 0) + seconds;
    this.saveLedger();
  }
}
