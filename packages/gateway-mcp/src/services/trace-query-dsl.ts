/**
 * Trace-query DSL — Datadog / Sentry / Honeycomb style query language
 * for /api/v1/traces/search.
 *
 * Grammar (Pratt parser, one file, ~250 LOC):
 *
 *   query      := orExpr
 *   orExpr     := andExpr ( 'OR' andExpr )*
 *   andExpr    := notExpr ( ('AND' | )   notExpr )*        // implicit AND
 *   notExpr    := 'NOT'? term
 *   term       := '(' orExpr ')' | predicate | freeText
 *   predicate  := field ':' comparator? value              // agent_id:X, risk:>MEDIUM
 *   freeText   := STRING                                    // "select * from"  → FTS match
 *   field      := IDENT                                     // agent_id, tool, risk, ...
 *              |  '@' IDENT ( '.' IDENT )*                  // @args.currency, @args.amount
 *   comparator := '>' | '<' | '>=' | '<=' | '=' | '!='
 *   value      := IDENT | NUMBER | STRING | ISO_TIMESTAMP
 *
 * Examples that MUST parse:
 *   tool:stripe_refund
 *   agent:11111111-2222-3333-4444-555555555555 AND risk:HIGH
 *   risk:>MEDIUM AND @args.amount:>10000
 *   "delete from users" AND NOT tool:read_only
 *   (tool:stripe OR tool:paypal) AND status:REJECTED
 *
 * Compile output: `{ sql, params, ftsMatch? }` — the caller stitches
 * `sql` into a WHERE clause and uses `ftsMatch` (if present) to JOIN
 * traces_fts. Field whitelist means the compiler NEVER produces raw
 * user input in a column name position — SQL injection is impossible
 * by construction, not by escaping discipline.
 *
 * Field registry: whitelist of scalar columns + FTS columns + JSON
 * paths. Adding a new searchable field means one entry here.
 */

// ── Field registry ──────────────────────────────────────────────────

type FieldKind = 'scalar' | 'fts' | 'json' | 'enum';

interface FieldSpec {
  kind:         FieldKind;
  // For 'scalar' / 'enum': the raw SQL column name on `traces`.
  // For 'fts':    the column name on `traces_fts`.
  // For 'json':   the SQL path expression (e.g. `json_extract(tool_call, '$.arguments.amount')`).
  sqlExpr:      string;
  // Type hint used at compile time to validate the value and pick
  // the right operator.
  type:         'string' | 'number' | 'timestamp' | 'enum';
  // Comparators the field allows. Default: {=, !=}. Numeric/timestamp
  // additionally get {>, <, >=, <=}.
  ops?:         Set<Comparator>;
  // For 'enum': legal values (validated at compile time).
  enumValues?:  string[];
}

const DEFAULT_OPS = new Set<Comparator>(['=', '!=']);
const NUMERIC_OPS = new Set<Comparator>(['=', '!=', '>', '<', '>=', '<=']);

// Aliases: user writes `agent:X`, we resolve to the canonical field
// name behind the scenes. Keeps DSL friendly without duplicating specs.
const ALIASES: Record<string, string> = {
  agent:    'agent_id',
  tool:     'tool_name',
  status:   'approval_status',
  session:  'session_id',
  score:    'anomaly_score',
  cost:     'cost_usd',
  tokens:   'total_tokens',
};

const FIELDS: Record<string, FieldSpec> = {
  agent_id:        { kind: 'scalar', sqlExpr: 'agent_id',        type: 'string' },
  session_id:      { kind: 'scalar', sqlExpr: 'session_id',      type: 'string' },
  delegation_id:   { kind: 'scalar', sqlExpr: 'delegation_id',   type: 'string' },
  parent_trace_id: { kind: 'scalar', sqlExpr: 'parent_trace_id', type: 'string' },
  tool_name:       { kind: 'scalar', sqlExpr: "json_extract(tool_call, '$.tool_name')", type: 'string' },
  environment:     { kind: 'enum',   sqlExpr: 'environment', type: 'enum',
                     enumValues: ['DEVELOPMENT', 'STAGING', 'PRODUCTION'] },
  approval_status: { kind: 'enum',   sqlExpr: 'approval_status', type: 'enum',
                     enumValues: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'AUTO_APPROVED'] },
  risk:            { kind: 'enum',   sqlExpr: "json_extract(safety_validation, '$.risk_level')", type: 'enum',
                     enumValues: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], ops: NUMERIC_OPS },
  anomaly_score:   { kind: 'scalar', sqlExpr: 'anomaly_score', type: 'number', ops: NUMERIC_OPS },
  cost_usd:        { kind: 'scalar', sqlExpr: 'cost_usd',      type: 'number', ops: NUMERIC_OPS },
  total_tokens:    { kind: 'scalar', sqlExpr: '(input_tokens + output_tokens)', type: 'number', ops: NUMERIC_OPS },
  blocked:         { kind: 'scalar', sqlExpr: 'blocked',       type: 'number' },
  timestamp:       { kind: 'scalar', sqlExpr: 'timestamp',     type: 'timestamp', ops: NUMERIC_OPS },
  // Full-text-searchable columns are handled specially via traces_fts
  // — see compile() for how ftsMatch is derived.
  prompt:          { kind: 'fts', sqlExpr: 'prompt',      type: 'string' },
  observation:     { kind: 'fts', sqlExpr: 'observation', type: 'string' },
};

// ── Types ───────────────────────────────────────────────────────────

export type Comparator = '=' | '!=' | '>' | '<' | '>=' | '<=';

type BinaryOp = 'AND' | 'OR';

interface PredicateNode {
  type: 'predicate';
  field: string;
  op: Comparator;
  value: string;
  jsonPath?: string[];   // for @args.X.Y style
}
interface FreeTextNode { type: 'freeText'; text: string; }
interface NotNode      { type: 'not';      inner: AstNode; }
interface BinaryNode   { type: 'binary';   op: BinaryOp; left: AstNode; right: AstNode; }

export type AstNode = PredicateNode | FreeTextNode | NotNode | BinaryNode;

// ── Lexer ───────────────────────────────────────────────────────────

type TokenKind =
  | 'IDENT' | 'STRING' | 'NUMBER'
  | 'COLON' | 'AT' | 'DOT'
  | 'LPAREN' | 'RPAREN'
  | 'GT' | 'LT' | 'GTE' | 'LTE' | 'EQ' | 'NEQ'
  | 'AND' | 'OR' | 'NOT'
  | 'EOF';

interface Token { kind: TokenKind; value: string; pos: number; }

class Lexer {
  private i = 0;
  constructor(private src: string) {}

  tokens(): Token[] {
    const out: Token[] = [];
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { this.i++; continue; }
      const start = this.i;
      if (c === '(') { out.push({ kind: 'LPAREN', value: c, pos: start }); this.i++; continue; }
      if (c === ')') { out.push({ kind: 'RPAREN', value: c, pos: start }); this.i++; continue; }
      if (c === ':') { out.push({ kind: 'COLON',  value: c, pos: start }); this.i++; continue; }
      if (c === '@') { out.push({ kind: 'AT',     value: c, pos: start }); this.i++; continue; }
      if (c === '.') { out.push({ kind: 'DOT',    value: c, pos: start }); this.i++; continue; }

      // Comparators (>, <, >=, <=, =, !=). `:` above is separate; a
      // "field:>value" pattern lexes as COLON then GT then IDENT.
      if (c === '>') {
        if (this.src[this.i + 1] === '=') { out.push({ kind: 'GTE', value: '>=', pos: start }); this.i += 2; }
        else                              { out.push({ kind: 'GT',  value: '>',  pos: start }); this.i++; }
        continue;
      }
      if (c === '<') {
        if (this.src[this.i + 1] === '=') { out.push({ kind: 'LTE', value: '<=', pos: start }); this.i += 2; }
        else                              { out.push({ kind: 'LT',  value: '<',  pos: start }); this.i++; }
        continue;
      }
      if (c === '=') { out.push({ kind: 'EQ',  value: '=',  pos: start }); this.i++; continue; }
      if (c === '!' && this.src[this.i + 1] === '=') {
        out.push({ kind: 'NEQ', value: '!=', pos: start }); this.i += 2; continue;
      }

      // Quoted string — a phrase, becomes FTS match.
      if (c === '"' || c === '\'') {
        const quote = c;
        this.i++;
        let s = '';
        while (this.i < this.src.length && this.src[this.i] !== quote) {
          if (this.src[this.i] === '\\' && this.i + 1 < this.src.length) {
            s += this.src[this.i + 1];
            this.i += 2;
          } else {
            s += this.src[this.i++];
          }
        }
        if (this.src[this.i] !== quote) throw new SyntaxError(`unterminated string at ${start}`);
        this.i++;
        out.push({ kind: 'STRING', value: s, pos: start });
        continue;
      }

      // Number (decimal or negative). We don't lex "-" as a token
      // because DSL doesn't use it as unary — a bare -5 is IDENT
      // starting with a dash if the user wants it, but numeric
      // predicates always come after a comparator so lookahead is
      // trivial: read digits + optional single '.'.
      if ((c >= '0' && c <= '9')) {
        let s = '';
        while (this.i < this.src.length && /[0-9.]/.test(this.src[this.i])) s += this.src[this.i++];
        out.push({ kind: 'NUMBER', value: s, pos: start });
        continue;
      }

      // Identifier — letters, digits, underscore, hyphen. Broad by
      // design so UUIDs and dashed slugs (tool-name) parse as one
      // IDENT rather than needing quotes.
      if (/[A-Za-z_]/.test(c)) {
        let s = '';
        while (this.i < this.src.length && /[A-Za-z0-9_\-]/.test(this.src[this.i])) {
          s += this.src[this.i++];
        }
        const upper = s.toUpperCase();
        if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
          out.push({ kind: upper as TokenKind, value: upper, pos: start });
        } else {
          out.push({ kind: 'IDENT', value: s, pos: start });
        }
        continue;
      }

      throw new SyntaxError(`unexpected character '${c}' at ${this.i}`);
    }
    out.push({ kind: 'EOF', value: '', pos: this.src.length });
    return out;
  }
}

// ── Parser ──────────────────────────────────────────────────────────

class Parser {
  private i = 0;
  constructor(private tokens: Token[]) {}

  parse(): AstNode {
    const node = this.orExpr();
    if (this.peek().kind !== 'EOF') {
      throw new SyntaxError(`unexpected token '${this.peek().value}' at ${this.peek().pos}`);
    }
    return node;
  }

  private orExpr(): AstNode {
    let left = this.andExpr();
    while (this.peek().kind === 'OR') {
      this.i++;
      const right = this.andExpr();
      left = { type: 'binary', op: 'OR', left, right };
    }
    return left;
  }

  private andExpr(): AstNode {
    let left = this.notExpr();
    // Implicit AND: two adjacent terms without an operator between
    // them are AND-ed. Explicit AND is also accepted.
    while (this.canStartTerm() || this.peek().kind === 'AND') {
      if (this.peek().kind === 'AND') this.i++;
      const right = this.notExpr();
      left = { type: 'binary', op: 'AND', left, right };
    }
    return left;
  }

  private notExpr(): AstNode {
    if (this.peek().kind === 'NOT') {
      this.i++;
      return { type: 'not', inner: this.term() };
    }
    return this.term();
  }

  private term(): AstNode {
    const t = this.peek();
    if (t.kind === 'LPAREN') {
      this.i++;
      const inner = this.orExpr();
      if (this.peek().kind !== 'RPAREN') throw new SyntaxError(`expected ')' at ${this.peek().pos}`);
      this.i++;
      return inner;
    }
    if (t.kind === 'STRING' && this.peekNext().kind !== 'COLON') {
      this.i++;
      return { type: 'freeText', text: t.value };
    }
    return this.predicate();
  }

  private predicate(): AstNode {
    // field := IDENT  |  '@' IDENT ('.' IDENT)*
    let field: string;
    const jsonPath: string[] = [];
    const t = this.peek();
    if (t.kind === 'AT') {
      this.i++;
      const first = this.consume('IDENT', "expected identifier after '@'");
      field = `@${first.value}`;
      while (this.peek().kind === 'DOT') {
        this.i++;
        jsonPath.push(this.consume('IDENT', "expected identifier after '.'").value);
      }
    } else if (t.kind === 'IDENT') {
      this.i++;
      field = t.value;
    } else {
      throw new SyntaxError(`expected field name at ${t.pos}, got '${t.value}'`);
    }
    this.consume('COLON', "expected ':' after field name");
    const op = this.readComparator();
    const value = this.readValue();
    return { type: 'predicate', field, op, value, jsonPath: jsonPath.length ? jsonPath : undefined };
  }

  private readComparator(): Comparator {
    const t = this.peek();
    switch (t.kind) {
      case 'GT':  this.i++; return '>';
      case 'LT':  this.i++; return '<';
      case 'GTE': this.i++; return '>=';
      case 'LTE': this.i++; return '<=';
      case 'EQ':  this.i++; return '=';
      case 'NEQ': this.i++; return '!=';
      default:    return '=';   // bare `field:value` defaults to `=`
    }
  }

  private readValue(): string {
    const t = this.peek();
    if (t.kind === 'STRING') {
      this.i++;
      return t.value;
    }
    // NUMBER-then-IDENT concatenation for values like UUIDs where the
    // lexer split "1abc-def-..." into NUMBER("1") + IDENT("abc-def-...").
    // Only concatenates when the two tokens are adjacent (no whitespace
    // between them) — anything else would break `amount:>1000 tool:x`
    // where the space is significant.
    if (t.kind === 'NUMBER' || t.kind === 'IDENT') {
      let value = t.value;
      let pos = t.pos + t.value.length;
      this.i++;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const next = this.peek();
        if ((next.kind === 'IDENT' || next.kind === 'NUMBER') && next.pos === pos) {
          value += next.value;
          pos = next.pos + next.value.length;
          this.i++;
          continue;
        }
        break;
      }
      return value;
    }
    throw new SyntaxError(`expected value at ${t.pos}, got '${t.value}'`);
  }

  private canStartTerm(): boolean {
    const t = this.peek();
    return t.kind === 'LPAREN' || t.kind === 'AT' || t.kind === 'IDENT'
        || (t.kind === 'STRING' && this.peekNext().kind !== 'COLON')
        || t.kind === 'NOT';
  }

  private peek():     Token { return this.tokens[this.i]; }
  private peekNext(): Token { return this.tokens[this.i + 1] ?? this.tokens[this.tokens.length - 1]; }
  private consume(kind: TokenKind, msg: string): Token {
    const t = this.peek();
    if (t.kind !== kind) throw new SyntaxError(`${msg}; got '${t.value}' at ${t.pos}`);
    this.i++;
    return t;
  }
}

// ── Compiler (AST → SQL) ────────────────────────────────────────────

export interface CompiledQuery {
  sql:      string;          // WHERE clause fragment (no leading "WHERE")
  params:   any[];
  ftsMatch: string | null;   // MATCH expression for the traces_fts JOIN (null if none)
}

class CompileError extends Error {}

export function compileQuery(dsl: string): CompiledQuery {
  const tokens = new Lexer(dsl).tokens();
  const ast = new Parser(tokens).parse();
  const ftsTerms: string[] = [];
  const params: any[] = [];

  const compile = (node: AstNode): string => {
    switch (node.type) {
      case 'binary': {
        return `(${compile(node.left)} ${node.op} ${compile(node.right)})`;
      }
      case 'not': {
        return `(NOT ${compile(node.inner)})`;
      }
      case 'freeText': {
        // Free text becomes an FTS match against every fts-indexed
        // column. FTS5's quoted-phrase syntax is `"substring"`, so we
        // wrap in quotes and escape any embedded quotes.
        const escaped = node.text.replace(/"/g, '""');
        ftsTerms.push(`"${escaped}"`);
        // Also emit a marker predicate that always evaluates true —
        // the actual filtering happens via the JOIN + MATCH.
        return '1=1';
      }
      case 'predicate': {
        return compilePredicate(node, params, ftsTerms);
      }
    }
  };

  let sql: string;
  try {
    sql = compile(ast);
  } catch (e) {
    if (e instanceof CompileError) throw new Error(`query error: ${e.message}`);
    throw e;
  }

  // If there are FTS terms, combine them with AND (they all must
  // match). Consumers JOIN traces_fts and add `traces_fts MATCH ?`
  // to the outer WHERE — this string is that parameter.
  const ftsMatch = ftsTerms.length ? ftsTerms.join(' AND ') : null;

  return { sql, params, ftsMatch };
}

function compilePredicate(p: PredicateNode, params: any[], ftsTerms: string[]): string {
  // JSON-path predicates: @args.currency:usd → json_extract(tool_call, '$.arguments.currency') = ?
  if (p.field.startsWith('@')) {
    const root = p.field.slice(1);
    const rootSpec = JSON_ROOTS[root];
    if (!rootSpec) {
      throw new CompileError(`unknown json root '@${root}'. Known: ${Object.keys(JSON_ROOTS).join(', ')}`);
    }
    // rootSpec is [column, jsonPrefix]. For @args, the prefix is
    // '.arguments' because tool_call.arguments is where args actually
    // live — a bare `$` would compare against the whole tool_call
    // blob. Path segments from p.jsonPath append after the prefix.
    const [rootColumn, rootPrefix] = rootSpec;
    const suffix = (p.jsonPath ?? []).map(s => `.${s}`).join('');
    const jsonExpr = `json_extract(${rootColumn}, '$${rootPrefix}${suffix}')`;
    // Coerce common numeric shapes so `@args.amount:>10000` works even
    // though the DSL doesn't type-tag @-fields (they could be strings
    // or numbers depending on the tool call).
    const raw = p.value;
    const asNum = Number(raw);
    if ((p.op === '>' || p.op === '<' || p.op === '>=' || p.op === '<=') && Number.isFinite(asNum)) {
      params.push(asNum);
    } else {
      params.push(raw);
    }
    return `${jsonExpr} ${p.op} ?`;
  }

  // Alias resolution: agent → agent_id
  const canonical = ALIASES[p.field] ?? p.field;
  const spec = FIELDS[canonical];
  if (!spec) {
    throw new CompileError(
      `unknown field '${p.field}'. Known: ${[...Object.keys(FIELDS), ...Object.keys(ALIASES)].sort().join(', ')}`,
    );
  }

  const ops = spec.ops ?? DEFAULT_OPS;
  if (!ops.has(p.op)) {
    throw new CompileError(`field '${p.field}' does not support operator '${p.op}' (allowed: ${[...ops].join(', ')})`);
  }

  if (spec.kind === 'fts') {
    // Field-scoped FTS: `prompt:"substring"` becomes `traces_fts.prompt : "substring"`
    const escaped = p.value.replace(/"/g, '""');
    ftsTerms.push(`{${spec.sqlExpr}} : "${escaped}"`);
    return '1=1';
  }

  if (spec.kind === 'enum' && spec.enumValues && !spec.enumValues.includes(p.value)) {
    // For risk with ordered comparator (>MEDIUM), map to numeric rank
    // instead of literal string compare.
    if (canonical === 'risk' && (p.op === '>' || p.op === '<' || p.op === '>=' || p.op === '<=')) {
      // Not a matching enum value — but the comparator only makes
      // sense against known ranks. Fall through and reject below.
    }
    throw new CompileError(`field '${p.field}' must be one of ${spec.enumValues.join('|')}, got '${p.value}'`);
  }

  // Risk ordered compare: MEDIUM → 1, HIGH → 2, etc. Map values on
  // both sides to their rank so `risk:>MEDIUM` works.
  if (canonical === 'risk' && (p.op === '>' || p.op === '<' || p.op === '>=' || p.op === '<=')) {
    const rank: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
    if (rank[p.value] === undefined) {
      throw new CompileError(`unknown risk level '${p.value}'`);
    }
    params.push(rank[p.value]);
    return `CASE ${spec.sqlExpr}
        WHEN 'LOW'      THEN 0
        WHEN 'MEDIUM'   THEN 1
        WHEN 'HIGH'     THEN 2
        WHEN 'CRITICAL' THEN 3
        ELSE -1
      END ${p.op} ?`;
  }

  params.push(coerceValue(p.value, spec.type));
  return `${spec.sqlExpr} ${p.op} ?`;
}

// Where does @<root> resolve to? Tuple = [SQL column, JSON prefix].
// The prefix says where inside the JSON blob to root the sub-path —
// @args.currency should compose to `$.arguments.currency`, not `$.currency`.
const JSON_ROOTS: Record<string, [string, string]> = {
  args:               ['tool_call',         '.arguments'],
  arg:                ['tool_call',         '.arguments'],
  arguments:          ['tool_call',         '.arguments'],
  observation:        ['observation',       ''],
  safety_validation:  ['safety_validation', ''],
};

function coerceValue(raw: string, type?: 'string' | 'number' | 'timestamp' | 'enum'): any {
  if (type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new CompileError(`expected number, got '${raw}'`);
    return n;
  }
  if (type === 'timestamp') {
    // Accept ISO 8601. Store as-is; SQLite string-compare is
    // lexicographic which is correct for ISO timestamps.
    if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(raw)) {
      throw new CompileError(`expected ISO timestamp, got '${raw}'`);
    }
    return raw;
  }
  return raw;
}

// Public wrapper — kept for tests + explicit re-exports.
export function parseQuery(dsl: string): AstNode {
  return new Parser(new Lexer(dsl).tokens()).parse();
}
