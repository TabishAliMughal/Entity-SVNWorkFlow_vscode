/** Minimal evaluator for VS Code `when` clauses as used in package.json: ! && || == != =~ in, parentheses, bare keys. */
type Ctx = Record<string, unknown>;

export function evalWhen(expr: string, ctx: Ctx): boolean {
  const toks: string[] = [];
  const re = /\s*(\/(?:\\.|[^/\\])+\/[a-z]*|&&|\|\||==|!=|=~|\(|\)|!|[^\s&|=!()]+)/gy;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) && m[0].length) toks.push(m[1]);
  let i = 0;
  const peek = (): string | undefined => toks[i];
  const value = (t: string): unknown => (t === 'true' ? true : t === 'false' ? false : /^'.*'$/.test(t) ? t.slice(1, -1) : t in ctx ? ctx[t] : /^[\w.]+$/.test(t) && isNaN(Number(t)) ? undefined : t);

  const atom = (): boolean => {
    const t = toks[i++];
    if (t === '!') return !atom();
    if (t === '(') {
      const v = or();
      i++;
      return v;
    }
    const op = peek();
    if (op === '==' || op === '!=') {
      i++;
      const rhs = toks[i++];
      const eq = String(value(t) ?? '') === String(/^[\w.]+$/.test(rhs) && rhs in ctx ? ctx[rhs] : value(rhs) === undefined ? rhs : value(rhs));
      return op === '==' ? eq : !eq;
    }
    if (op === '=~') {
      i++;
      const lit = toks[i++];
      const last = lit.lastIndexOf('/');
      return new RegExp(lit.slice(1, last), lit.slice(last + 1)).test(String(value(t) ?? ''));
    }
    if (op === 'in') {
      i++;
      const coll = ctx[toks[i++]];
      const needle = String(value(t) ?? '');
      return Array.isArray(coll) ? coll.includes(needle) : !!coll && typeof coll === 'object' && needle in (coll as object);
    }
    return !!value(t);
  };
  const and = (): boolean => {
    let v = atom();
    while (peek() === '&&') {
      i++;
      const r = atom();
      v = v && r;
    }
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (peek() === '||') {
      i++;
      const r = and();
      v = v || r;
    }
    return v;
  };
  return or();
}
