/**
 * Tests for the trace-query DSL: lexer, parser, compiler.
 *
 * Coverage:
 *  - Every documented grammar branch (predicates, operators, boolean
 *    combinators, parens, quoted strings, JSON paths, aliases).
 *  - Error paths (unknown field, wrong operator for field type,
 *    unterminated string, dangling operator).
 *  - Injection resistance — the compiled `sql` must never contain
 *    user-supplied identifiers verbatim in a column position.
 */
import { compileQuery, parseQuery } from '../services/trace-query-dsl';

describe('trace-query DSL — parser', () => {
  test('parses a bare field:value predicate', () => {
    const ast = parseQuery('agent:foo');
    expect(ast).toMatchObject({ type: 'predicate', field: 'agent', op: '=', value: 'foo' });
  });

  test('parses a comparator', () => {
    const ast = parseQuery('anomaly_score:>0.85');
    expect(ast).toMatchObject({ type: 'predicate', field: 'anomaly_score', op: '>', value: '0.85' });
  });

  test('parses implicit AND', () => {
    const ast = parseQuery('agent:foo tool:stripe');
    expect(ast.type).toBe('binary');
    if (ast.type !== 'binary') return;
    expect(ast.op).toBe('AND');
  });

  test('parses explicit AND / OR / NOT with precedence', () => {
    // AND binds tighter than OR
    const ast = parseQuery('a:1 OR b:2 AND c:3');
    if (ast.type !== 'binary') throw new Error('want binary');
    expect(ast.op).toBe('OR');
    // right side should be an AND
    expect((ast.right as any).type).toBe('binary');
    expect((ast.right as any).op).toBe('AND');
  });

  test('parses parens to override precedence', () => {
    const ast = parseQuery('(a:1 OR b:2) AND c:3');
    if (ast.type !== 'binary') throw new Error('want binary');
    expect(ast.op).toBe('AND');
    expect((ast.left as any).op).toBe('OR');
  });

  test('parses NOT', () => {
    const ast = parseQuery('NOT tool:read_only');
    expect(ast.type).toBe('not');
  });

  test('parses quoted free-text', () => {
    const ast = parseQuery('"delete from users"');
    expect(ast).toMatchObject({ type: 'freeText', text: 'delete from users' });
  });

  test('parses quoted phrase distinct from field predicate', () => {
    // Bare `"foo":bar` is invalid; the STRING-then-COLON path is
    // reserved for future field values. Right now free-text needs
    // no colon following the string.
    const ast = parseQuery('agent:foo "sensitive prompt"');
    if (ast.type !== 'binary') throw new Error('want binary');
    expect(ast.op).toBe('AND');
    expect((ast.right as any).type).toBe('freeText');
  });

  test('parses JSON path with @', () => {
    const ast = parseQuery('@args.amount:>10000');
    expect(ast).toMatchObject({
      type: 'predicate',
      field: '@args',
      op: '>',
      value: '10000',
      jsonPath: ['amount'],
    });
  });

  test('parses deep JSON path', () => {
    const ast = parseQuery('@args.metadata.currency:usd');
    expect((ast as any).jsonPath).toEqual(['metadata', 'currency']);
  });

  test('errors on unknown field', () => {
    expect(() => compileQuery('nope:bar')).toThrow(/unknown field/);
  });

  test('errors on unterminated string', () => {
    expect(() => parseQuery('agent:"foo')).toThrow(/unterminated/);
  });

  test('errors on dangling colon', () => {
    expect(() => parseQuery('agent:')).toThrow();
  });
});

describe('trace-query DSL — compiler', () => {
  test('compiles a scalar equality', () => {
    const { sql, params, ftsMatch } = compileQuery('agent:foo');
    expect(sql).toBe('agent_id = ?');
    expect(params).toEqual(['foo']);
    expect(ftsMatch).toBeNull();
  });

  test('resolves aliases', () => {
    const { sql } = compileQuery('tool:stripe_refund');
    expect(sql).toContain("json_extract(tool_call, '$.tool_name')");
  });

  test('compiles enum with equality', () => {
    const { sql, params } = compileQuery('risk:HIGH');
    expect(sql).toContain('risk_level');
    expect(params).toEqual(['HIGH']);
  });

  test('compiles risk ordered compare with numeric ranks', () => {
    const { sql, params } = compileQuery('risk:>MEDIUM');
    expect(sql).toContain('CASE');
    expect(sql).toContain('> ?');
    expect(params).toEqual([1]);   // MEDIUM = 1
  });

  test('rejects invalid enum value', () => {
    expect(() => compileQuery('risk:banana')).toThrow(/must be one of/);
  });

  test('rejects operator not allowed for field', () => {
    // approval_status is enum type without ordered ops
    expect(() => compileQuery('status:>APPROVED')).toThrow(/operator/);
  });

  test('coerces numeric value', () => {
    const { params } = compileQuery('cost_usd:>1.5');
    expect(params).toEqual([1.5]);
  });

  test('binary + not + parens', () => {
    const { sql, params } = compileQuery('(agent:a OR agent:b) AND NOT tool:x');
    expect(sql).toMatch(/\(agent_id = \? OR agent_id = \?\) AND \(NOT/);
    expect(params).toEqual(['a', 'b', 'x']);
  });

  test('JSON path predicate compiles with json_extract', () => {
    // `@args.amount` roots inside tool_call.arguments — the JSON
    // prefix is `.arguments` so amount ends up at `$.arguments.amount`.
    const { sql, params } = compileQuery('@args.amount:>10000');
    expect(sql).toContain("json_extract(tool_call, '$.arguments.amount')");
    expect(sql).toContain('> ?');
    // Numeric coercion — ordered comparators on @-fields lift the
    // value out of its string shape so json_extract's number result
    // compares as expected.
    expect(params).toEqual([10000]);
  });

  test('unknown @root rejected', () => {
    expect(() => compileQuery('@nope.x:1')).toThrow(/unknown json root/);
  });

  test('free-text produces ftsMatch', () => {
    const { ftsMatch, sql } = compileQuery('"delete from users"');
    expect(ftsMatch).toBe('"delete from users"');
    // The main SQL should evaluate true; the actual filter is via FTS join.
    expect(sql).toContain('1=1');
  });

  test('field-scoped FTS on prompt', () => {
    const { ftsMatch } = compileQuery('prompt:"secret token"');
    expect(ftsMatch).toContain('{prompt}');
    expect(ftsMatch).toContain('"secret token"');
  });

  test('combines free-text with predicate', () => {
    const { sql, params, ftsMatch } = compileQuery('agent:foo "leak"');
    expect(sql).toContain('agent_id = ?');
    expect(params).toEqual(['foo']);
    expect(ftsMatch).toBe('"leak"');
  });

  test('SQL injection resistance: dangerous value goes into params, not sql', () => {
    // The malicious value is bound as a parameter — never appears in
    // the compiled SQL string in a column-name or executable position.
    const { sql, params } = compileQuery(`agent:"'; DROP TABLE traces; --"`);
    expect(sql).toBe('agent_id = ?');
    expect(params).toEqual([`'; DROP TABLE traces; --`]);
    // No parameter value should ever leak into the SQL text.
    expect(sql).not.toContain('DROP');
  });

  test('SQL injection resistance: unknown field is rejected before SQL is emitted', () => {
    // A user-supplied field name never becomes a column identifier —
    // it must resolve against the whitelist first.
    expect(() => compileQuery('__proto__:pwn')).toThrow(/unknown field/);
    expect(() => compileQuery('foo;DROP:bar')).toThrow();
  });
});
