import { describe, expect, it } from 'vitest';
import { filterSql, parseFilters } from '../src/lib/filters';

const compile = (filters: unknown, scope: 'events' | 'logs' | 'spans' = 'events', base: unknown[] = ['pid', 'from', 'to']) => {
  const params = [...base];
  const sql = filterSql(parseFilters(JSON.stringify(filters)), scope, params);
  return { sql, params: params.slice(base.length) };
};

describe('filter compiler', () => {
  it('compiles nothing to nothing', () => {
    expect(compile([])).toEqual({ sql: '', params: [] });
    expect(parseFilters(undefined)).toEqual([]);
  });

  it('numbers its placeholders after the params already bound', () => {
    const { sql, params } = compile([{ field: 'path', op: 'eq', value: '/cart' }]);
    expect(sql).toBe(' AND (path = $4)');
    expect(params).toEqual(['/cart']);
  });

  it('maps every operator', () => {
    const ops = {
      eq: 'path = $4', neq: 'path IS DISTINCT FROM $4', contains: "path ILIKE $4 ESCAPE '\\'", not_contains: "(path IS NULL OR path NOT ILIKE $4 ESCAPE '\\')",
      starts_with: "path ILIKE $4 ESCAPE '\\'", ends_with: "path ILIKE $4 ESCAPE '\\'", set: "NULLIF(path, '') IS NOT NULL", not_set: "NULLIF(path, '') IS NULL",
    };
    for (const [op, sql] of Object.entries(ops)) expect(compile([{ field: 'path', op, value: 'x' }]).sql).toBe(` AND (${sql})`);
    expect(compile([{ field: 'path', op: 'contains', value: '50%_off' }]).params).toEqual(['%50\\%\\_off%']);
    expect(compile([{ field: 'path', op: 'starts_with', value: '/a' }]).params).toEqual(['/a%']);
    expect(compile([{ field: 'path', op: 'ends_with', value: '.png' }]).params).toEqual(['%.png']);
  });

  it('compares numeric columns as numbers and numeric-looking values numerically', () => {
    expect(compile([{ field: 'httpStatus', op: 'gte', value: '500' }])).toEqual({ sql: ' AND (http_status >= $4)', params: [500] });
    expect(compile([{ field: 'httpStatus', op: 'starts_with', value: '5' }]).sql).toBe(" AND ((http_status)::text ILIKE $4 ESCAPE '\\')");
    const json = compile([{ field: 'props.props.value', op: 'gt', value: '10' }]);
    expect(json.sql).toContain('::double END) > $5');
    expect(json.params).toEqual(['$."props"."value"', 10]);
    // non-numeric value: text ordering (ISO dates)
    expect(compile([{ field: 'props.signupDate', op: 'lt', value: '2026-01-01' }]).sql).toContain('< $5');
  });

  it('binds JSON paths as parameters: nested for event props, a single key for OTel attributes', () => {
    expect(compile([{ field: 'props.props.plan', op: 'eq', value: 'pro' }]).params).toEqual(['$."props"."plan"', 'pro']);
    expect(compile([{ field: 'attributes.http.route', op: 'eq', value: '/x' }], 'logs').params).toEqual(['$."http.route"', '/x']);
    expect(compile([{ field: 'resource.service.version', op: 'set' }], 'spans').params).toEqual(['$."service.version"']);
    // quotes and backslashes inside a key are escaped within the quoted path segment
    expect(compile([{ field: 'props.a"b\\c', op: 'set' }]).params).toEqual(['$."a\\"b\\\\c"']);
  });

  it('never interpolates user input into SQL', () => {
    const evil = "x'); DROP TABLE events; --";
    const { sql, params } = compile([{ field: 'props.' + evil, op: 'eq', value: evil }]);
    expect(sql).not.toContain('DROP');
    expect(params).toContain(evil);
    expect(() => compile([{ field: evil, op: 'eq', value: '1' }])).toThrow(/Unknown field/);
    expect(() => compile([{ field: 'path', op: 'eq; DROP', value: '1' }])).toThrow(/Unknown filter op/);
  });

  it('rejects malformed input', () => {
    expect(() => parseFilters('{')).toThrow();
    expect(() => parseFilters('{"field":"path"}')).toThrow(/array/);
    expect(() => parseFilters(JSON.stringify([{ field: 'path', op: 'eq' }]))).toThrow(/needs a value/);
    expect(() => parseFilters(JSON.stringify(Array.from({ length: 21 }, () => ({ field: 'path', op: 'set' }))))).toThrow(/At most/);
    expect(() => compile([{ field: 'body', op: 'eq', value: 'x' }], 'events')).toThrow(/Unknown field/); // logs-only field
  });
});
