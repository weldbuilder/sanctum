/** Source-level cascade checks, not a browser, DOM mount, font measurement or screenshot.
 * Supports only the selectors/properties used by the material regression fixtures. */
import postcss from 'postcss';

export interface CssNode {
  tag?: string;
  classes?: string[];
  attrs?: Record<string, string>;
  state?: string;
  pseudo?: string;
  parent?: CssNode;
}

function split(s: string, separator: string): string[] {
  let level = 0, quoted = '', start = 0;
  const parts: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) { if (c === quoted && s[i - 1] !== '\\') quoted = ''; continue; }
    if (c === '"' || c === "'") { quoted = c; continue; }
    if (c === '(' || c === '[') level++;
    if (c === ')' || c === ']') level--;
    if (!level && c === separator) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  return [...parts, s.slice(start)].map(p => p.trim()).filter(Boolean);
}

function functions(s: string): { rest: string; groups: Array<{ name: string; args: string[] }> } {
  const groups: Array<{ name: string; args: string[] }> = [];
  let rest = s, match: RegExpExecArray | null;
  while ((match = /:(is|not|where)\(/.exec(rest))) {
    const start = match.index, open = start + match[0].length;
    let depth = 1, end = open;
    for (; end < rest.length && depth; end++) {
      if (rest[end] === '(') depth++;
      if (rest[end] === ')') depth--;
    }
    groups.push({ name: match[1], args: split(rest.slice(open, end - 1), ',') });
    rest = rest.slice(0, start) + rest.slice(end);
  }
  return { rest, groups };
}

function compoundMatches(s: string, node: CssNode): boolean {
  const { rest, groups } = functions(s);
  const argumentMatches = (a: string) => matches(a, { ...node, pseudo: a.includes('::') ? node.pseudo : undefined });
  if (groups.some(g => g.name === 'not' ? g.args.some(argumentMatches) : !g.args.some(argumentMatches))) return false;
  if ((rest.match(/::[\w-]+/)?.[0] ?? '') !== (node.pseudo ?? '')) return false;
  if (rest.includes(':root') && node.parent) return false;
  const states = [...rest.replace(/::[\w-]+/g, '').matchAll(/:(?!root\b)([\w-]+)/g)].map(m => m[1]);
  if (states.some(s => s !== node.state)) return false;
  if ([...rest.matchAll(/\.([\w-]+)/g)].some(m => !node.classes?.includes(m[1]))) return false;
  if ([...rest.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)].some(m => m[2] === undefined ? !(m[1] in (node.attrs ?? {})) : node.attrs?.[m[1]] !== m[2])) return false;
  const tag = rest.match(/^[a-z][\w-]*/)?.[0];
  return !tag || tag === node.tag;
}

function matches(selector: string, node: CssNode): boolean {
  const parts = split(selector, ' ');
  let current: CssNode | undefined = node;
  if (!compoundMatches(parts.pop()!, current)) return false;
  while (parts.length) {
    const direct = parts[parts.length - 1] === '>';
    if (direct) parts.pop();
    const part = parts.pop()!;
    current = current.parent;
    if (!direct) while (current && !compoundMatches(part, current)) current = current.parent;
    if (!current || !compoundMatches(part, current)) return false;
  }
  return true;
}

function specificity(selector: string): number {
  const { rest, groups } = functions(selector);
  return groups.reduce((sum, g) => sum + (g.name === 'where' ? 0 : Math.max(...g.args.map(specificity))), 0)
    + [...rest.matchAll(/#[\w-]+/g)].length * 10000
    + [...rest.matchAll(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g)].length * 100
    + split(rest.replace(/::[\w-]+/g, ''), ' ').filter(s => /^[a-z]/.test(s)).length;
}

function expanded(prop: string, value: string): Array<[string, string]> {
  if (prop === 'padding' || prop === 'margin') {
    const [top, right = top, bottom = top, left = right] = split(value, ' ');
    return [[`${prop}-top`, top], [`${prop}-right`, right], [`${prop}-bottom`, bottom], [`${prop}-left`, left]];
  }
  if (prop === 'background') return [[prop, value], ['background-image', /url\(|gradient\(/.test(value) ? value : 'none'], ['background-color', /^(?:#[\w]+|rgba?\(|var\()/.test(value) ? value : 'transparent']];
  return [[prop, value]];
}

export function sourceCascade(source: string) {
  const css = postcss.parse(source);
  const cache = new Map<string, Record<string, string>>();
  return function declarations(node: CssNode, width = 1440): Record<string, string> {
    const key = JSON.stringify([node, width]);
    const prior = cache.get(key);
    if (prior) return prior;
    const inherited = node.parent ? declarations(node.parent, width) : {};
    const local: Record<string, { weight: number; value: string }> = {};
    css.walkRules(rule => {
      let parent = rule.parent;
      while (parent?.type === 'atrule') {
        const a = parent as postcss.AtRule;
        if (a.name === 'media') {
          const max = a.params.match(/max-width:\s*(\d+)px/), min = a.params.match(/min-width:\s*(\d+)px/);
          if ((!max && !min) || (max && width > +max[1]) || (min && width < +min[1])) return;
        } else if (a.name !== 'supports') return;
        parent = parent.parent;
      }
      for (const selector of rule.selectors) if (matches(selector, node)) rule.walkDecls(d => {
        const weight = specificity(selector) + (d.important ? 1e9 : 0);
        for (const [prop, value] of expanded(d.prop, d.value)) if (!local[prop] || weight >= local[prop].weight) local[prop] = { weight, value };
      });
    });
    const all = { ...Object.fromEntries(Object.entries(inherited).filter(([k]) => k.startsWith('--') || ['color', 'font-size', 'font-family', 'line-height'].includes(k))), ...Object.fromEntries(Object.entries(local).map(([k, v]) => [k, v.value])) };
    const resolve = (value: string, depth = 0): string => {
      if (depth > 16) return value;
      const next = value.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_s, k, fallback) => resolve(all[k] ?? fallback ?? '', depth + 1));
      return next === value ? value : resolve(next, depth + 1);
    };
    // Resolve custom properties at their defining element before inheritance. Root aliases
    // must not be silently rebound to route/chrome variables on descendant elements.
    const result = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, resolve(v)]));
    cache.set(key, result);
    return result;
  };
}

/** Evaluates only px/rem plus generated calc sums; no claim about browser layout. */
export function cssPixels(value: string, rootPx = 15): number {
  const expr = value.replace(/^calc\((.*)\)$/, '$1').replace(/(-?[\d.]+)rem/g, (_s, n) => String(+n * rootPx)).replace(/px/g, '');
  if (!/^[\d.\s+*-]+$/.test(expr)) throw new Error(`Unsupported source geometry: ${value}`);
  return Function(`return (${expr});`)() as number;
}
