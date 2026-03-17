/**
 * PPM-C (Prediction by Partial Matching, Method C)
 *
 * Variable-order Markov chain for tool call sequence modeling.
 * Uses contexts of length 0 through D (default 4) and blends
 * predictions across orders via escape probabilities.
 *
 * Pure TypeScript, zero dependencies.
 * O(D) per prediction, O(D) per update.
 *
 * Method C escape: escape probability = distinct / (total + distinct)
 * This gives better estimates for rare events than Methods A/B.
 */

// ── Types ───────────────────────────────────────────────────────────────────

interface PPMNode {
  /** Symbol → child node */
  children: Map<string, PPMNode>;
  /** Symbol → count (how many times this symbol followed this context) */
  counts: Map<string, number>;
  /** Sum of all counts */
  total: number;
  /** Number of distinct symbols seen after this context */
  distinct: number;
}

export interface PPMSerialized {
  maxOrder: number;
  context: string[];
  alphabet: string[];
  trie: SerializedNode;
}

interface SerializedNode {
  counts: [string, number][];
  total: number;
  distinct: number;
  children: [string, SerializedNode][];
}

// ── PPM Model ───────────────────────────────────────────────────────────────

export class PPMModel {
  private root: PPMNode;
  private maxOrder: number;
  private context: string[]; // recent symbols, length ≤ maxOrder
  private alphabet: Set<string>;

  constructor(maxOrder = 4) {
    this.maxOrder = maxOrder;
    this.context = [];
    this.alphabet = new Set();
    this.root = this.createNode();
  }

  /**
   * Train on a full sequence of symbols (batch).
   * Processes each symbol in order, updating the model incrementally.
   */
  train(sequence: string[]): void {
    // Reset context for fresh training
    this.context = [];
    for (const symbol of sequence) {
      this.update(symbol);
    }
  }

  /**
   * Update the model with a single new symbol (online learning).
   * Updates all context lengths 0..D.
   */
  update(symbol: string): void {
    this.alphabet.add(symbol);

    // Update counts at all orders (0 through current context length)
    // Order 0: just the root
    this.incrementCount(this.root, symbol);

    // Orders 1..min(context.length, maxOrder)
    // For order k, navigate the trie along the LAST k symbols of context:
    //   root -> context[len-k] -> context[len-k+1] -> ... -> context[len-1]
    const ctxLen = Math.min(this.context.length, this.maxOrder);

    for (let order = 1; order <= ctxLen; order++) {
      let node = this.root;
      const start = this.context.length - order;
      for (let i = start; i < this.context.length; i++) {
        const ctxSymbol = this.context[i];
        if (!node.children.has(ctxSymbol)) {
          node.children.set(ctxSymbol, this.createNode());
        }
        node = node.children.get(ctxSymbol)!;
      }
      this.incrementCount(node, symbol);
    }

    // Maintain sliding context window
    this.context.push(symbol);
    if (this.context.length > this.maxOrder) {
      this.context.shift();
    }
  }

  /**
   * Predict the probability of a symbol given current context.
   * Uses PPM-C exclusion: at each order, symbols already accounted
   * at higher orders are excluded to avoid double-counting.
   */
  predict(symbol: string): number {
    if (this.alphabet.size === 0) return 0;

    const excluded = new Set<string>();
    let probability = 0;
    let escapeAccum = 1.0; // accumulated escape probability

    // Try from highest order down to 0
    const ctxLen = Math.min(this.context.length, this.maxOrder);

    for (let order = ctxLen; order >= 0; order--) {
      const node = this.getContextNode(order);
      if (!node || node.total === 0) continue;

      // Count excluded symbols in this node
      let excludedCount = 0;
      let excludedDistinct = 0;
      for (const [s, c] of node.counts) {
        if (excluded.has(s)) {
          excludedCount += c;
          excludedDistinct++;
        }
      }

      const effectiveTotal = node.total - excludedCount;
      const effectiveDistinct = node.distinct - excludedDistinct;

      if (effectiveTotal <= 0 || effectiveDistinct < 0) continue;

      const count = node.counts.get(symbol) ?? 0;

      if (count > 0 && !excluded.has(symbol)) {
        // Symbol found at this order
        const p = count / (effectiveTotal + effectiveDistinct);
        probability += escapeAccum * p;
        return probability; // exact match, stop
      }

      // Escape to lower order
      const escapeProbability = effectiveDistinct / (effectiveTotal + effectiveDistinct);
      escapeAccum *= escapeProbability;

      // Add all symbols seen at this order to exclusion set
      for (const s of node.counts.keys()) {
        excluded.add(s);
      }
    }

    // Order -1: uniform over entire alphabet (including unseen symbols)
    const remaining = Math.max(1, this.alphabet.size - excluded.size + 1);
    probability += escapeAccum * (1 / remaining);

    return probability;
  }

  /**
   * Compute surprise (negative log probability) of a symbol.
   * Higher = more unexpected. Range [0, +∞).
   * Returns 0 for perfectly predicted symbols.
   */
  surprise(symbol: string): number {
    const p = this.predict(symbol);
    if (p <= 0) return 20; // cap at ~20 nats for zero-probability events
    return Math.min(-Math.log(p), 20);
  }

  /**
   * Set the context explicitly (e.g., after deserialization or for testing).
   */
  setContext(ctx: string[]): void {
    this.context = ctx.slice(-this.maxOrder);
  }

  /** Get current context */
  getContext(): string[] {
    return this.context.slice();
  }

  /** Total number of unique symbols seen */
  get alphabetSize(): number {
    return this.alphabet.size;
  }

  /** Serialize to plain JSON */
  serialize(): PPMSerialized {
    return {
      maxOrder: this.maxOrder,
      context: this.context.slice(),
      alphabet: [...this.alphabet],
      trie: this.serializeNode(this.root),
    };
  }

  /** Restore from serialized form */
  static deserialize(data: PPMSerialized): PPMModel {
    const model = new PPMModel(data.maxOrder);
    model.context = data.context.slice();
    model.alphabet = new Set(data.alphabet);
    model.root = model.deserializeNode(data.trie);
    return model;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private createNode(): PPMNode {
    return {
      children: new Map(),
      counts: new Map(),
      total: 0,
      distinct: 0,
    };
  }

  private incrementCount(node: PPMNode, symbol: string): void {
    const prev = node.counts.get(symbol) ?? 0;
    if (prev === 0) node.distinct++;
    node.counts.set(symbol, prev + 1);
    node.total++;
  }

  /**
   * Navigate the trie to the node representing a context of given order.
   * Order 0 = root, order k = context[len-k..len-1].
   */
  private getContextNode(order: number): PPMNode | null {
    if (order === 0) return this.root;

    let node = this.root;
    const start = this.context.length - order;
    if (start < 0) return null;

    for (let i = start; i < this.context.length; i++) {
      const child = node.children.get(this.context[i]);
      if (!child) return null;
      node = child;
    }
    return node;
  }

  private serializeNode(node: PPMNode): SerializedNode {
    return {
      counts: [...node.counts.entries()],
      total: node.total,
      distinct: node.distinct,
      children: [...node.children.entries()].map(([k, v]) => [k, this.serializeNode(v)]),
    };
  }

  private deserializeNode(data: SerializedNode): PPMNode {
    return {
      counts: new Map(data.counts),
      total: data.total,
      distinct: data.distinct,
      children: new Map(data.children.map(([k, v]) => [k, this.deserializeNode(v)])),
    };
  }
}
