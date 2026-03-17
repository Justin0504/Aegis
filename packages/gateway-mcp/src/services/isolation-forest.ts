/**
 * Isolation Forest — unsupervised anomaly detection
 *
 * Pure TypeScript, zero dependencies. Implements the original
 * Liu et al. (2008) algorithm with incremental sample reservoir.
 *
 * Normal points require many splits to isolate → long path → low score.
 * Anomalies require few splits to isolate → short path → high score.
 *
 * Complexity:
 *   fit():   O(t × ψ × log(ψ))  where t=numTrees, ψ=sampleSize
 *   score(): O(t × log(ψ))       ~800 comparisons for defaults
 */

// ── Types ───────────────────────────────────────────────────────────────────

interface ITreeNode {
  /** Split dimension index */
  dim: number;
  /** Split threshold */
  val: number;
  /** Left child (≤ val) */
  left: ITreeNode | ILeaf;
  /** Right child (> val) */
  right: ITreeNode | ILeaf;
}

interface ILeaf {
  /** Number of data points that fell into this leaf */
  size: number;
}

type INode = ITreeNode | ILeaf;

function isLeaf(node: INode): node is ILeaf {
  return 'size' in node && !('dim' in node);
}

export interface IsolationForestConfig {
  /** Number of isolation trees (default 100) */
  numTrees: number;
  /** Subsample size per tree (default 256) */
  sampleSize: number;
  /** Reservoir buffer max size for incremental learning (default 2048) */
  reservoirSize: number;
}

export interface IsolationForestSerialized {
  config: IsolationForestConfig;
  reservoir: number[][];
  trees: INode[];
  n: number;
}

const DEFAULT_CONFIG: IsolationForestConfig = {
  numTrees: 100,
  sampleSize: 256,
  reservoirSize: 2048,
};

// ── Isolation Forest ────────────────────────────────────────────────────────

export class IsolationForest {
  private trees: INode[] = [];
  private reservoir: number[][] = [];
  private n = 0; // total samples seen (for reservoir sampling)
  private config: IsolationForestConfig;
  private dims = 0;

  constructor(config?: Partial<IsolationForestConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Train the forest on a batch of feature vectors */
  fit(data: number[][]): void {
    if (data.length === 0) return;
    this.dims = data[0].length;
    this.n = data.length;

    // Fill reservoir
    this.reservoir = data.length <= this.config.reservoirSize
      ? data.slice()
      : this.subsample(data, this.config.reservoirSize);

    this.rebuildTrees();
  }

  /** Add a single sample (online learning via reservoir sampling) */
  addSample(point: number[]): void {
    if (this.dims === 0) this.dims = point.length;
    this.n++;

    if (this.reservoir.length < this.config.reservoirSize) {
      this.reservoir.push(point);
    } else {
      // Vitter's reservoir sampling: replace with probability reservoirSize/n
      const j = Math.floor(Math.random() * this.n);
      if (j < this.config.reservoirSize) {
        this.reservoir[j] = point;
      }
    }

    // Rebuild trees periodically (every sampleSize new samples)
    if (this.n % this.config.sampleSize === 0 && this.reservoir.length >= 30) {
      this.rebuildTrees();
    }
  }

  /**
   * Score a single point.
   * Returns anomaly score in [0, 1]. Higher = more anomalous.
   * ~0.5 means normal, >0.6 suspicious, >0.8 likely anomaly.
   */
  score(point: number[]): number {
    if (this.trees.length === 0) return 0.5; // no model yet

    let totalPath = 0;
    for (const tree of this.trees) {
      totalPath += this.pathLength(point, tree, 0);
    }
    const avgPath = totalPath / this.trees.length;
    const cn = this.harmonicEstimate(this.effectiveSampleSize());

    // Score = 2^(-avgPath / c(n))
    return Math.pow(2, -avgPath / cn);
  }

  /** Whether the forest has enough data to produce meaningful scores */
  get isTrained(): boolean {
    return this.trees.length > 0 && this.reservoir.length >= 30;
  }

  get sampleCount(): number {
    return this.reservoir.length;
  }

  /** Serialize to plain JSON */
  serialize(): IsolationForestSerialized {
    return {
      config: this.config,
      reservoir: this.reservoir,
      trees: this.trees,
      n: this.n,
    };
  }

  /** Restore from serialized */
  static deserialize(data: IsolationForestSerialized): IsolationForest {
    const forest = new IsolationForest(data.config);
    forest.reservoir = data.reservoir;
    forest.trees = data.trees;
    forest.n = data.n;
    forest.dims = data.reservoir.length > 0 ? data.reservoir[0].length : 0;
    return forest;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private rebuildTrees(): void {
    const maxDepth = Math.ceil(Math.log2(Math.max(this.effectiveSampleSize(), 2)));
    this.trees = [];

    for (let t = 0; t < this.config.numTrees; t++) {
      const sample = this.subsample(this.reservoir, Math.min(this.config.sampleSize, this.reservoir.length));
      this.trees.push(this.buildTree(sample, 0, maxDepth));
    }
  }

  private buildTree(data: number[][], depth: number, maxDepth: number): INode {
    if (data.length <= 1 || depth >= maxDepth) {
      return { size: data.length } as ILeaf;
    }

    // Pick random dimension and split value
    const dim = Math.floor(Math.random() * this.dims);
    let min = Infinity, max = -Infinity;
    for (const point of data) {
      if (point[dim] < min) min = point[dim];
      if (point[dim] > max) max = point[dim];
    }

    if (min === max) {
      return { size: data.length } as ILeaf;
    }

    const splitVal = min + Math.random() * (max - min);
    const left: number[][] = [];
    const right: number[][] = [];

    for (const point of data) {
      if (point[dim] <= splitVal) left.push(point);
      else right.push(point);
    }

    return {
      dim,
      val: splitVal,
      left: this.buildTree(left, depth + 1, maxDepth),
      right: this.buildTree(right, depth + 1, maxDepth),
    };
  }

  private pathLength(point: number[], node: INode, depth: number): number {
    if (isLeaf(node)) {
      // Adjust for subtree size (expected further path in unseen tree)
      return depth + this.harmonicEstimate(node.size);
    }

    const treeNode = node as ITreeNode;
    if (point[treeNode.dim] <= treeNode.val) {
      return this.pathLength(point, treeNode.left, depth + 1);
    } else {
      return this.pathLength(point, treeNode.right, depth + 1);
    }
  }

  /**
   * c(n) — average path length of unsuccessful search in BST.
   * H(n) ≈ ln(n) + 0.5772 (Euler-Mascheroni constant)
   * c(n) = 2H(n-1) - 2(n-1)/n
   */
  private harmonicEstimate(n: number): number {
    if (n <= 1) return 0;
    if (n === 2) return 1;
    const h = Math.log(n - 1) + 0.5772156649;
    return 2 * h - 2 * (n - 1) / n;
  }

  private effectiveSampleSize(): number {
    return Math.min(this.config.sampleSize, this.reservoir.length);
  }

  private subsample(data: number[][], size: number): number[][] {
    if (data.length <= size) return data.slice();

    // Fisher-Yates partial shuffle
    const indices = Array.from({ length: data.length }, (_, i) => i);
    for (let i = 0; i < size; i++) {
      const j = i + Math.floor(Math.random() * (data.length - i));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return indices.slice(0, size).map(i => data[i]);
  }
}
