// Open-addressing hash table from fixed-width integer keys to two float64 values. The
// information-state dynamic programme stores tens of millions of states; a `Map` of strings
// would need several times the memory.

const EMPTY = 0;

export class KeyTable {
  /** 32-bit words per key. Word 0 of a stored key is never 0 (0 marks an empty slot). */
  readonly words: number;
  private capacity: number;
  private mask: number;
  private keys: Uint32Array;
  private first: Float64Array;
  private second: Float64Array;
  size = 0;
  /** Set by a successful `get`: the second value of the entry found. */
  found2 = 0;

  constructor(words: number, initialCapacity = 1 << 16) {
    if (!Number.isInteger(words) || words < 1) throw new RangeError('KeyTable: words must be a positive integer');
    let capacity = 16;
    while (capacity < initialCapacity) capacity *= 2;
    this.words = words;
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.keys = new Uint32Array(capacity * words);
    this.first = new Float64Array(capacity);
    this.second = new Float64Array(capacity);
  }

  /** Bytes held by the table's arrays. */
  bytes(): number {
    return this.keys.byteLength + this.first.byteLength + this.second.byteLength;
  }

  private slotOf(key: Uint32Array): number {
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < this.words; i++) {
      h = Math.imul(h ^ key[i], 0x01000193);
      h ^= h >>> 15;
      h = Math.imul(h, 0x2c1b3c6d);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
    return h & this.mask;
  }

  private matches(slot: number, key: Uint32Array): boolean {
    const base = slot * this.words;
    for (let i = 0; i < this.words; i++) if (this.keys[base + i] !== key[i]) return false;
    return true;
  }

  /** First value stored under `key`, or NaN. On success `found2` holds the second value. */
  get(key: Uint32Array): number {
    if (key[0] === EMPTY) throw new RangeError('KeyTable: word 0 of a key must not be 0');
    let slot = this.slotOf(key);
    for (;;) {
      const at = slot * this.words;
      if (this.keys[at] === EMPTY) return Number.NaN;
      if (this.matches(slot, key)) {
        this.found2 = this.second[slot];
        return this.first[slot];
      }
      slot = (slot + 1) & this.mask;
    }
  }

  set(key: Uint32Array, value: number, value2: number): void {
    if (key[0] === EMPTY) throw new RangeError('KeyTable: word 0 of a key must not be 0');
    if ((this.size + 1) * 2 > this.capacity) this.grow();
    let slot = this.slotOf(key);
    for (;;) {
      const at = slot * this.words;
      if (this.keys[at] === EMPTY) {
        this.keys.set(key.subarray(0, this.words), at);
        this.first[slot] = value;
        this.second[slot] = value2;
        this.size += 1;
        return;
      }
      if (this.matches(slot, key)) {
        this.first[slot] = value;
        this.second[slot] = value2;
        return;
      }
      slot = (slot + 1) & this.mask;
    }
  }

  private grow(): void {
    const { words } = this;
    const oldKeys = this.keys;
    const oldFirst = this.first;
    const oldSecond = this.second;
    const oldCapacity = this.capacity;
    this.capacity = oldCapacity * 2;
    this.mask = this.capacity - 1;
    this.keys = new Uint32Array(this.capacity * words);
    this.first = new Float64Array(this.capacity);
    this.second = new Float64Array(this.capacity);
    for (let slot = 0; slot < oldCapacity; slot++) {
      const at = slot * words;
      if (oldKeys[at] === EMPTY) continue;
      const key = oldKeys.subarray(at, at + words);
      let to = this.slotOf(key);
      while (this.keys[to * words] !== EMPTY) to = (to + 1) & this.mask;
      this.keys.set(key, to * words);
      this.first[to] = oldFirst[slot];
      this.second[to] = oldSecond[slot];
    }
  }
}
