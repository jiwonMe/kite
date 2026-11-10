/* ============================================================================
 * Kite — Zero-Build Declarative & Manifold-Projected Diagram Engine
 * RFC-0001 implementation. Single-file, zero-dependency ES module.
 *
 *   Module 1. Tape & Autodiff Core
 *   Module 2. Pratt Parser & Tagged Template JIT
 *   Module 3. Inline Blob Worker & XPBD Solver
 *   Module 4. Scene / Domain / Substance / Style / SVG
 *   Module 5. <kite-diagram> & Public Exports
 *
 * The design follows Penrose's Trio model (Domain · Substance · Style) but
 * replaces the build-time optimizer stack with a flat bytecode tape, a
 * reverse-mode autodiff pass, and an XPBD manifold projector running in a
 * transferable-buffer Web Worker.  No COOP/COEP headers, no npm, no bundler.
 * ========================================================================== */

/* ========================================================================== *
 * Module 1 — Tape & Autodiff Core
 * ========================================================================== */

export const Op = Object.freeze({
  CONST: 0,
  VAR: 1,
  ADD: 2,
  SUB: 3,
  MUL: 4,
  DIV: 5,
  NEG: 6,
  POW2: 7,
  SQRT: 8,
  SIN: 9,
  COS: 10,
  MAX: 11,
  MIN: 12,
  ABS: 13,
  ATAN2: 14, // [ATAN2, yNode, xNode, 0] -> f = atan2(L, R)
});

export const ConstraintKind = Object.freeze({
  EQUALITY: 0,
  INEQUALITY: 1,
});

const NODE_STRIDE = 4;
const EPS_DENOM = 1e-12;
const DEFAULTS = Object.freeze({ width: 800, height: 600, seed: 0x9e3779b9 });

class Tape {
  constructor() {
    this.words = new Int32Array(1024);
    this.nodeCount = 0;
    this.consts = new Float64Array(256);
    this.constCount = 0;
    this._constNodes = new Map();
  }

  _growNodes(extra) {
    const need = (this.nodeCount + extra) * NODE_STRIDE;
    if (need <= this.words.length) return;
    let cap = this.words.length;
    while (cap < need) cap *= 2;
    const next = new Int32Array(cap);
    next.set(this.words.subarray(0, this.nodeCount * NODE_STRIDE));
    this.words = next;
  }

  emit(op, arg1 = -1, arg2 = -1, aux = 0) {
    this._growNodes(1);
    const id = this.nodeCount++;
    const o = id * NODE_STRIDE;
    this.words[o] = op;
    this.words[o + 1] = arg1;
    this.words[o + 2] = arg2;
    this.words[o + 3] = aux;
    return id;
  }

  emitConst(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) throw new TypeError('[kite] constant must be finite');
    const key = Object.is(v, -0) ? 0 : v;
    const hit = this._constNodes.get(key);
    if (hit !== undefined) return hit;
    if (this.constCount + 1 > this.consts.length) {
      let cap = this.consts.length;
      while (cap < this.constCount + 1) cap *= 2;
      const next = new Float64Array(cap);
      next.set(this.consts);
      this.consts = next;
    }
    const poolIndex = this.constCount++;
    this.consts[poolIndex] = v;
    const nodeId = this.emit(Op.CONST, -1, -1, poolIndex);
    this._constNodes.set(key, nodeId);
    return nodeId;
  }

  opcode(id) {
    return this.words[id * NODE_STRIDE];
  }

  serialize(fromNode = 0) {
    return this.words.slice(fromNode * NODE_STRIDE, this.nodeCount * NODE_STRIDE);
  }

  serializeConsts(fromConst = 0) {
    return this.consts.slice(fromConst, this.constCount);
  }
}

function evaluateTape(tape, consts, vars) {
  const n = tape.nodeCount;
  const out = new Float64Array(n);
  const words = tape.words;
  for (let i = 0; i < n; i++) {
    const o = i * NODE_STRIDE;
    const op = words[o];
    const a = words[o + 1];
    const b = words[o + 2];
    const aux = words[o + 3];
    let f = 0;
    switch (op) {
      case Op.CONST:
        f = consts[aux];
        break;
      case Op.VAR:
        f = vars[a];
        break;
      case Op.ADD:
        f = out[a] + out[b];
        break;
      case Op.SUB:
        f = out[a] - out[b];
        break;
      case Op.MUL:
        f = out[a] * out[b];
        break;
      case Op.DIV:
        f = out[a] / (out[b] + EPS_DENOM);
        break;
      case Op.NEG:
        f = -out[a];
        break;
      case Op.POW2:
        f = out[a] * out[a];
        break;
      case Op.SQRT:
        f = Math.sqrt(Math.max(out[a], 1e-12));
        break;
      case Op.SIN:
        f = Math.sin(out[a]);
        break;
      case Op.COS:
        f = Math.cos(out[a]);
        break;
      case Op.MAX:
        f = out[a] > out[b] ? out[a] : out[b];
        break;
      case Op.MIN:
        f = out[a] < out[b] ? out[a] : out[b];
        break;
      case Op.ABS:
        f = Math.abs(out[a]);
        break;
      case Op.ATAN2:
        f = Math.atan2(out[a], out[b]);
        break;
      default:
        f = NaN;
    }
    out[i] = f;
  }
  return out;
}

function nodeDependencies(tape, root) {
  const words = tape.words;
  const visited = new Set();
  const vars = new Set();
  const stack = [root];
  while (stack.length) {
    const id = stack.pop();
    if (id < 0 || id >= tape.nodeCount || visited.has(id)) continue;
    visited.add(id);
    const o = id * NODE_STRIDE;
    const op = words[o];
    const a = words[o + 1];
    const b = words[o + 2];
    if (op === Op.CONST) continue;
    if (op === Op.VAR) {
      vars.add(a);
      continue;
    }
    if (a >= 0) stack.push(a);
    if (b >= 0) stack.push(b);
  }
  const depNodes = Int32Array.from([...visited].sort((x, y) => x - y));
  const depVars = Int32Array.from([...vars].sort((x, y) => x - y));
  return { depNodes, depVars };
}

/* ========================================================================== *
 * Module 2 — Pratt Parser & Tagged Template JIT
 * ========================================================================== */

const templateAstCache = new WeakMap();

const BP = Object.freeze({
  '==': 10,
  '<=': 10,
  '>=': 10,
  '<': 10,
  '>': 10,
  '+': 20,
  '-': 20,
  '*': 30,
  '/': 30,
  '^': 50,
  '**': 50,
});

const CALL_BP = 60;
const UNARY_BP = 40;

function tokenizeSource(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '#' && i + 1 < n && src[i + 1] >= '0' && src[i + 1] <= '9') {
      let j = i + 1;
      while (j < n && src[j] >= '0' && src[j] <= '9') j++;
      tokens.push({ k: 'ph', v: Number(src.slice(i + 1, j)) });
      i = j;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < n && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const rest = src.slice(i);
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
      if (!m) throw new SyntaxError('[kite] bad number near: ' + rest.slice(0, 12));
      tokens.push({ k: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      tokens.push({ k: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '**' || two === '==' || two === '<=' || two === '>=') {
      tokens.push({ k: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/^(),<>'.includes(ch)) {
      tokens.push({ k: 'op', v: ch });
      i++;
      continue;
    }
    throw new SyntaxError('[kite] unexpected character "' + ch + '" in expression');
  }
  tokens.push({ k: 'eof' });
  return tokens;
}

function parseExpressionSource(src) {
  const tokens = tokenizeSource(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (v) => peek().k === 'op' && peek().v === v;
  const expect = (v) => {
    if (!isOp(v)) throw new SyntaxError('[kite] expected "' + v + '" near token ' + pos);
    pos++;
  };

  function parseExpr(minBP) {
    let left = parsePrefix();
    for (;;) {
      const t = peek();
      if (t.k !== 'op') break;
      const bp = BP[t.v];
      if (bp === undefined || bp < minBP) break;
      next();
      const rightAssoc = t.v === '^' || t.v === '**';
      const right = parseExpr(rightAssoc ? bp : bp + 1);
      left = { t: 'bin', op: t.v === '**' ? '^' : t.v, a: left, b: right };
    }
    return left;
  }

  function parsePrefix() {
    const t = next();
    if (t.k === 'num') return { t: 'num', v: t.v };
    if (t.k === 'ph') return { t: 'ph', i: t.v };
    if (t.k === 'op' && (t.v === '-' || t.v === '+')) {
      const arg = parseExpr(UNARY_BP);
      return t.v === '-' ? { t: 'un', op: '-', a: arg } : arg;
    }
    if (t.k === 'op' && t.v === '(') {
      const e = parseExpr(0);
      expect(')');
      return e;
    }
    if (t.k === 'id') {
      if (isOp('(')) {
        next();
        const args = [];
        if (!isOp(')')) {
          for (;;) {
            args.push(parseExpr(0));
            if (isOp(',')) {
              next();
              continue;
            }
            break;
          }
        }
        expect(')');
        return { t: 'call', name: t.v, args };
      }
      if (t.v === 'pi') return { t: 'num', v: Math.PI };
      if (t.v === 'e') return { t: 'num', v: Math.E };
      throw new SyntaxError('[kite] unknown identifier "' + t.v + '" (only pi, e and math functions are supported)');
    }
    throw new SyntaxError('[kite] unexpected token in expression');
  }

  const ast = parseExpr(0);
  if (peek().k !== 'eof') throw new SyntaxError('[kite] trailing tokens in expression');
  return ast;
}

function astForTemplate(strings) {
  let ast = templateAstCache.get(strings);
  if (ast) return ast;
  let src = strings[0];
  for (let i = 0; i < strings.length - 1; i++) src += '#' + i + strings[i + 1];
  ast = parseExpressionSource(src);
  templateAstCache.set(strings, ast);
  return ast;
}

const COMPARISONS = new Set(['==', '<=', '>=', '<', '>']);

function compileAst(ast, values, scene) {
  const tape = scene.tape;
  switch (ast.t) {
    case 'num':
      return tape.emitConst(ast.v);
    case 'ph': {
      const v = values[ast.i];
      return valueToNode(v, scene);
    }
    case 'un': {
      const a = compileAst(ast.a, values, scene);
      if (ast.op === '-') return tape.emit(Op.NEG, a, -1, 0);
      return a;
    }
    case 'bin': {
      if (ast.op === '^') {
        const base = compileAst(ast.a, values, scene);
        const exp = constantExponent(ast.b);
        if (exp === null) {
          throw new SyntaxError('[kite] exponent must be a numeric literal (opcode set supports integer powers)');
        }
        return emitPower(base, exp, tape);
      }
      const a = compileAst(ast.a, values, scene);
      const b = compileAst(ast.b, values, scene);
      switch (ast.op) {
        case '+':
          return tape.emit(Op.ADD, a, b, 0);
        case '-':
          return tape.emit(Op.SUB, a, b, 0);
        case '*':
          return tape.emit(Op.MUL, a, b, 0);
        case '/':
          return tape.emit(Op.DIV, a, b, 0);
        default:
          throw new SyntaxError('[kite] unsupported operator "' + ast.op + '"');
      }
    }
    case 'call': {
      const arity = (n) => {
        if (ast.args.length !== n) {
          throw new SyntaxError('[kite] ' + ast.name + '() expects ' + n + ' argument(s)');
        }
      };
      switch (ast.name) {
        case 'sin':
          arity(1);
          return tape.emit(Op.SIN, compileAst(ast.args[0], values, scene), -1, 0);
        case 'cos':
          arity(1);
          return tape.emit(Op.COS, compileAst(ast.args[0], values, scene), -1, 0);
        case 'sqrt':
          arity(1);
          return tape.emit(Op.SQRT, compileAst(ast.args[0], values, scene), -1, 0);
        case 'abs':
          arity(1);
          return tape.emit(Op.ABS, compileAst(ast.args[0], values, scene), -1, 0);
        case 'min':
          arity(2);
          return tape.emit(
            Op.MIN,
            compileAst(ast.args[0], values, scene),
            compileAst(ast.args[1], values, scene),
            0,
          );
        case 'max':
          arity(2);
          return tape.emit(
            Op.MAX,
            compileAst(ast.args[0], values, scene),
            compileAst(ast.args[1], values, scene),
            0,
          );
        case 'toRadians':
          arity(1);
          return tape.emit(
            Op.MUL,
            compileAst(ast.args[0], values, scene),
            tape.emitConst(Math.PI / 180),
            0,
          );
        case 'toDegrees':
          arity(1);
          return tape.emit(
            Op.MUL,
            compileAst(ast.args[0], values, scene),
            tape.emitConst(180 / Math.PI),
            0,
          );
        case 'atan2':
          arity(2);
          return tape.emit(
            Op.ATAN2,
            compileAst(ast.args[0], values, scene),
            compileAst(ast.args[1], values, scene),
            0,
          );
        case 'pow': {
          arity(2);
          const base = compileAst(ast.args[0], values, scene);
          const exp = constantExponent(ast.args[1]);
          if (exp === null) {
            throw new SyntaxError('[kite] pow() exponent must be a numeric literal');
          }
          return emitPower(base, exp, tape);
        }
        default:
          throw new SyntaxError('[kite] unknown function "' + ast.name + '"');
      }
    }
    default:
      throw new SyntaxError('[kite] invalid expression AST');
  }
}

function constantExponent(ast) {
  if (ast.t === 'num') return ast.v;
  if (ast.t === 'un' && ast.op === '-') {
    const v = constantExponent(ast.a);
    return v === null ? null : -v;
  }
  return null;
}

function emitPower(base, exp, tape) {
  if (!Number.isFinite(exp)) throw new SyntaxError('[kite] exponent must be finite');
  if (exp === 0) return tape.emitConst(1);
  if (exp === 1) return base;
  if (exp === 2) return tape.emit(Op.POW2, base, -1, 0);
  if (exp === 0.5) return tape.emit(Op.SQRT, base, -1, 0);
  if (Number.isInteger(exp) && exp > 0) {
    // Exponentiation by squaring on the tape.
    let result = null;
    let factor = base;
    let e = exp;
    while (e > 0) {
      if (e & 1) result = result === null ? factor : tape.emit(Op.MUL, result, factor, 0);
      e >>= 1;
      if (e > 0) factor = tape.emit(Op.POW2, factor, -1, 0);
    }
    return result;
  }
  if (Number.isInteger(exp) && exp < 0) {
    const positive = emitPower(base, -exp, tape);
    return tape.emit(Op.DIV, tape.emitConst(1), positive, 0);
  }
  throw new SyntaxError('[kite] unsupported exponent ' + exp + ' (use integers or 0.5)');
}

function valueToNode(value, scene) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('[kite] non-finite number in expression');
    return scene.tape.emitConst(value);
  }
  if (value && value.__kiteSym) {
    if (value.__kiteScene && value.__kiteScene !== scene) {
      throw new Error('[kite] expression belongs to a different scene');
    }
    return value.nodeId;
  }
  if (typeof value === 'boolean') return scene.tape.emitConst(value ? 1 : 0);
  throw new TypeError('[kite] template value must be a number or SymExpr, got ' + typeof value);
}

function emitTemplate(strings, values, scene) {
  const ast = astForTemplate(strings);
  if (ast.t === 'bin' && COMPARISONS.has(ast.op)) {
    const tape = scene.tape;
    const l = compileAst(ast.a, values, scene);
    const r = compileAst(ast.b, values, scene);
    let node;
    let kind = ConstraintKind.INEQUALITY;
    if (ast.op === '==') {
      node = tape.emit(Op.SUB, l, r, 0);
      kind = ConstraintKind.EQUALITY;
    } else if (ast.op === '>=') {
      node = tape.emit(Op.SUB, r, l, 0);
    } else {
      node = tape.emit(Op.SUB, l, r, 0);
    }
    let pair = null;
    if (ast.a.t === 'ph' && values[ast.a.i] && values[ast.a.i].__kitePair) pair = values[ast.a.i].__kitePair;
    if (ast.b.t === 'ph' && values[ast.b.i] && values[ast.b.i].__kitePair) pair = values[ast.b.i].__kitePair;
    return { node, kind, pair };
  }
  const node = compileAst(ast, values, scene);
  // A helper such as ops.contains() carries its natural inequality direction.
  if (ast.t === 'ph') {
    const v = values[ast.i];
    if (v && v.__kiteSym && v.__kiteRel) {
      return { node, kind: ConstraintKind.INEQUALITY, pair: v.__kitePair || null };
    }
    if (v && v.__kiteSym && v.__kitePair) return { node, kind: null, pair: v.__kitePair };
  }
  return { node, kind: null };
}

/* ========================================================================== *
 * Module 3 — Inline Blob Worker & XPBD Solver
 * ========================================================================== */

/* This function is stringified into a Blob.  It must not close over anything
 * outside its own body.  Keep the opcode constants numerically in sync with
 * the Op object above. */
function kiteWorkerMain() {
  'use strict';

  const O = {
    CONST: 0,
    VAR: 1,
    ADD: 2,
    SUB: 3,
    MUL: 4,
    DIV: 5,
    NEG: 6,
    POW2: 7,
    SQRT: 8,
    SIN: 9,
    COS: 10,
    MAX: 11,
    MIN: 12,
    ABS: 13,
    ATAN2: 14,
  };
  const EQ = 0;
  const INEQ = 1;
  const EPS = 1e-12;
  const MAX_STEP_DISP = 25.0;
  const K_SUBSTEPS = 12;
  const DT = 1 / 60;
  const H = DT / K_SUBSTEPS;

  const S = {
    tape: new Int32Array(0),
    consts: new Float64Array(0),
    vars: new Float64Array(0),
    invMass: new Float64Array(0),
    nodeCount: 0,
    constraints: [],
    bodies: [],
    edges: [],
    val: new Float64Array(0),
    adj: new Float64Array(0),
    grad: new Float64Array(0),
    width: 800,
    height: 600,
    rng: 1,
    dragging: false,
    targets: [],
    mouseX: 0,
    mouseY: 0,
    prevVars: new Float64Array(0),
    activeTicks: 0,
  };

  function rand() {
    let x = S.rng >>> 0;
    x ^= (x << 13) >>> 0;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x >>>= 0;
    S.rng = x || 1;
    return S.rng / 4294967296;
  }

  function resizeNodeArrays(extra) {
    const n = S.tape.length / 4 + extra;
    if (S.val.length < n) {
      S.val = new Float64Array(n);
      S.adj = new Float64Array(n);
    }
    S.nodeCount = S.tape.length / 4;
  }

  function resizeVarArrays(extra) {
    const n = S.vars.length + extra;
    if (S.grad.length < n) S.grad = new Float64Array(n);
  }

  function normalizeConstraint(c) {
    return {
      rootNodeId: c.rootNodeId,
      kind: c.kind,
      compliance: c.compliance,
      lambda: 0,
      depNodes: new Int32Array(c.depNodes),
      depVars: new Int32Array(c.depVars),
      pair: c.pair || null,
      _skip: false,
    };
  }

  function sortConstraints() {
    // Soft constraints (alpha > 0) must run before hard constraints.
    S.constraints.sort((a, b) => (a.compliance > 0 ? 0 : 1) - (b.compliance > 0 ? 0 : 1));
  }

  function evalNodes() {
    const tape = S.tape;
    const consts = S.consts;
    const vars = S.vars;
    const val = S.val;
    const n = S.nodeCount;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const op = tape[o];
      const a = tape[o + 1];
      const b = tape[o + 2];
      const aux = tape[o + 3];
      let f = 0;
      switch (op) {
        case O.CONST:
          f = consts[aux];
          break;
        case O.VAR:
          f = vars[a];
          break;
        case O.ADD:
          f = val[a] + val[b];
          break;
        case O.SUB:
          f = val[a] - val[b];
          break;
        case O.MUL:
          f = val[a] * val[b];
          break;
        case O.DIV:
          f = val[a] / (val[b] + EPS);
          break;
        case O.NEG:
          f = -val[a];
          break;
        case O.POW2:
          f = val[a] * val[a];
          break;
        case O.SQRT:
          f = Math.sqrt(Math.max(val[a], 1e-12));
          break;
        case O.SIN:
          f = Math.sin(val[a]);
          break;
        case O.COS:
          f = Math.cos(val[a]);
          break;
        case O.MAX:
          f = val[a] > val[b] ? val[a] : val[b];
          break;
        case O.MIN:
          f = val[a] < val[b] ? val[a] : val[b];
          break;
        case O.ABS:
          f = Math.abs(val[a]);
          break;
        case O.ATAN2:
          f = Math.atan2(val[a], val[b]);
          break;
        default:
          f = NaN;
      }
      val[i] = f;
    }
  }

  function backward(c) {
    const tape = S.tape;
    const val = S.val;
    const adj = S.adj;
    const grad = S.grad;
    const dep = c.depNodes;
    const depVars = c.depVars;
    for (let k = 0; k < depVars.length; k++) grad[depVars[k]] = 0;
    for (let k = 0; k < dep.length; k++) adj[dep[k]] = 0;
    adj[c.rootNodeId] = 1;

    for (let k = dep.length - 1; k >= 0; k--) {
      const i = dep[k];
      const ai = adj[i];
      if (ai === 0) continue;
      const o = i * 4;
      const op = tape[o];
      const a = tape[o + 1];
      const b = tape[o + 2];
      switch (op) {
        case O.VAR:
          grad[a] += ai;
          break;
        case O.ADD:
          adj[a] += ai;
          adj[b] += ai;
          break;
        case O.SUB:
          adj[a] += ai;
          adj[b] -= ai;
          break;
        case O.MUL:
          adj[a] += ai * val[b];
          adj[b] += ai * val[a];
          break;
        case O.DIV: {
          const den = val[b] + EPS;
          adj[a] += ai / den;
          adj[b] -= (ai * val[a]) / (den * den);
          break;
        }
        case O.NEG:
          adj[a] -= ai;
          break;
        case O.POW2:
          adj[a] += 2 * ai * val[a];
          break;
        case O.SQRT:
          adj[a] += ai / (2 * Math.max(val[i], 1e-6));
          break;
        case O.SIN:
          adj[a] += ai * Math.cos(val[a]);
          break;
        case O.COS:
          adj[a] -= ai * Math.sin(val[a]);
          break;
        case O.MAX: {
          const chosen = val[a] >= val[b] ? a : b;
          adj[chosen] += ai;
          break;
        }
        case O.MIN: {
          const chosen = val[a] <= val[b] ? a : b;
          adj[chosen] += ai;
          break;
        }
        case O.ABS:
          if (val[a] > 0) adj[a] += ai;
          else if (val[a] < 0) adj[a] -= ai;
          break;
        case O.ATAN2: {
          // d/dy atan2(y,x) = x/(x²+y²),  d/dx = -y/(x²+y²)
          const yv = val[a];
          const xv = val[b];
          const den = xv * xv + yv * yv + EPS;
          adj[a] += (ai * xv) / den;
          adj[b] -= (ai * yv) / den;
          break;
        }
        default:
          break;
      }
    }
  }

  function applyDragConstraint(varIdx, target, compliance, lambdaRef) {
    const w = S.invMass[varIdx];
    if (!w) return 0;
    const C = S.vars[varIdx] - target;
    const Sxy = w; // gradient is exactly 1
    // The mouse target is a frame-rate constraint (it is refreshed every
    // animation frame), so its compliance is normalized with the frame
    // timestep rather than the substep.  This also keeps the pointer pull
    // authoritative enough to move bodies that are tied together by hard
    // constraints, while still remaining a finite-compliance soft constraint.
    const alphaT = compliance / (DT * DT);
    let dl = (-C - alphaT * lambdaRef.value) / (Sxy + alphaT);
    lambdaRef.value += dl;
    let dx = w * dl;
    if (dx > MAX_STEP_DISP) dx = MAX_STEP_DISP;
    else if (dx < -MAX_STEP_DISP) dx = -MAX_STEP_DISP;
    S.vars[varIdx] += dx;
    return dx;
  }

  function buildActivePairs() {
    let pairCount = 0;
    for (let i = 0; i < S.constraints.length; i++) if (S.constraints[i].pair) pairCount++;
    if (pairCount <= 32) {
      for (let i = 0; i < S.constraints.length; i++) S.constraints[i]._skip = false;
      return;
    }

    let maxMargin = 0;
    for (let i = 0; i < S.constraints.length; i++) {
      const c = S.constraints[i];
      if (c.pair && c.pair.margin > maxMargin) maxMargin = c.pair.margin;
    }
    const varToBody = new Map();
    let rmax = 1;
    for (let i = 0; i < S.bodies.length; i++) {
      const b = S.bodies[i];
      varToBody.set(b.xVar, i);
      varToBody.set(b.yVar, i);
      const r = b.r || 1;
      if (r > rmax) rmax = r;
    }
    const cell = Math.max(1, rmax * 2 + maxMargin * 2);
    const grid = new Map();
    for (let i = 0; i < S.bodies.length; i++) {
      const b = S.bodies[i];
      const gx = Math.floor(S.vars[b.xVar] / cell);
      const gy = Math.floor(S.vars[b.yVar] / cell);
      const key = gx + ',' + gy;
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(i);
    }

    const pairKey = (i, j) => (i < j ? i * 1048576 + j : j * 1048576 + i);
    const candidates = new Set();
    for (const [key, list] of grid) {
      const comma = key.indexOf(',');
      const gx = Number(key.slice(0, comma));
      const gy = Number(key.slice(comma + 1));
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          const other = grid.get(gx + dx + ',' + (gy + dy));
          if (!other) continue;
          for (let a = 0; a < list.length; a++) {
            for (let b = 0; b < other.length; b++) {
              if (list[a] === other[b]) continue;
              const bi = S.bodies[list[a]];
              const bj = S.bodies[other[b]];
              if (!bi || !bj) continue;
              const reach = (bi.r || 1) + (bj.r || 1) + maxMargin * 2;
              // Conservative AABB overlap: if either axis is farther apart
              // than the sum of radii, the pair cannot violate disjointness.
              if (Math.abs(S.vars[bi.xVar] - S.vars[bj.xVar]) > reach) continue;
              if (Math.abs(S.vars[bi.yVar] - S.vars[bj.yVar]) > reach) continue;
              candidates.add(pairKey(list[a], other[b]));
            }
          }
        }
      }
    }

    for (let i = 0; i < S.constraints.length; i++) {
      const c = S.constraints[i];
      if (!c.pair) {
        c._skip = false;
        continue;
      }
      const ai = varToBody.get(c.pair.ax);
      const bi = varToBody.get(c.pair.bx);
      if (ai === undefined || bi === undefined || ai === bi) {
        c._skip = false;
        continue;
      }
      c._skip = !candidates.has(pairKey(ai, bi));
    }
  }

  function applyConstraint(c) {
    if (c._skip) return;
    const C = S.val[c.rootNodeId];
    if (!Number.isFinite(C)) return;
    if (c.kind === INEQ && C <= 0) return;
    backward(c);
    let Sxy = 0;
    const depVars = c.depVars;
    for (let k = 0; k < depVars.length; k++) {
      const v = depVars[k];
      const g = S.grad[v];
      Sxy += S.invMass[v] * g * g;
    }
    if (Sxy < 1e-12) return;
    // Soft constraints are frame-rate objectives (λ resets every frame), so
    // like the mouse pull they are normalized by the frame timestep.  The
    // compliance is also scaled by the constraint's own gradient norm S so
    // an encourage() is unit-free: a distance (px) and an angle (rad) term
    // both relax the same fraction 1/(1+α/Δt²) of their residual per pass.
    const alphaT = c.compliance > 0 ? (c.compliance / (DT * DT)) * Sxy : 0;
    let dl;
    if (c.kind === INEQ) {
      // Inequalities are authored as C <= 0.  XPBD's multiplier is
      // non-negative for the equivalent residual C' = -C >= 0, so the
      // violated direction is -grad(C).
      dl = (C - alphaT * c.lambda) / (Sxy + alphaT);
    } else {
      dl = (-C - alphaT * c.lambda) / (Sxy + alphaT);
    }
    if (!Number.isFinite(dl)) return;
    if (c.kind === INEQ) {
      const nl = Math.max(0, c.lambda + dl);
      dl = nl - c.lambda;
      c.lambda = nl;
    } else {
      c.lambda += dl;
    }
    const flip = c.kind === INEQ ? -1 : 1;
    for (let k = 0; k < depVars.length; k++) {
      const v = depVars[k];
      let dx = flip * S.invMass[v] * S.grad[v] * dl;
      if (dx > MAX_STEP_DISP) dx = MAX_STEP_DISP;
      else if (dx < -MAX_STEP_DISP) dx = -MAX_STEP_DISP;
      S.vars[v] += dx;
    }
  }

  function resetLambdas() {
    for (let i = 0; i < S.constraints.length; i++) S.constraints[i].lambda = 0;
  }

  function solveSubsteps(count) {
    // One independent multiplier per axis.  Sharing a multiplier between x and
    // y couples the two soft constraints and turns the mouse pull into a
    // radial-only force, which a hard distance constraint then cancels.
    // Soft mouse constraints run at the front of every substep; hard
    // constraints then reproject the bodies onto the constraint manifold.
    // This is the ordering required by the RFC.
    const dragLambdas = S.dragging
      ? S.targets.map(() => ({ x: { value: 0 }, y: { value: 0 } }))
      : null;
    for (let step = 0; step < count; step++) {
      buildActivePairs();
      if (S.dragging) {
        for (let t = 0; t < S.targets.length; t++) {
          const target = S.targets[t];
          applyDragConstraint(target.varX, S.mouseX + target.offsetX, 1e-4, dragLambdas[t].x);
          applyDragConstraint(target.varY, S.mouseY + target.offsetY, 1e-4, dragLambdas[t].y);
        }
      }
      for (let i = 0; i < S.constraints.length; i++) {
        const c = S.constraints[i];
        if (c._skip) continue;
        evalNodes();
        applyConstraint(c);
      }
    }
  }

  function maxHardError() {
    evalNodes();
    let m = 0;
    for (let i = 0; i < S.constraints.length; i++) {
      const c = S.constraints[i];
      // Soft constraints (encourage / finite compliance) must not keep the
      // engine awake forever; convergence is defined by hard constraints.
      if (c.compliance > 0) continue;
      const C = S.val[c.rootNodeId];
      const e = c.kind === INEQ ? Math.max(0, C) : Math.abs(C);
      if (!Number.isFinite(e)) return Infinity;
      if (e > m) m = e;
    }
    return m;
  }

  function warmStart(iterations) {
    const vars = S.vars;
    const inv = S.invMass;
    const bodies = S.bodies;
    for (let it = 0; it < iterations; it++) {
      // Coulomb-like repulsion so coincident shapes escape a zero Jacobian.
      for (let i = 0; i < bodies.length; i++) {
        const bi = bodies[i];
        for (let j = i + 1; j < bodies.length; j++) {
          const bj = bodies[j];
          // Shapes that share a center (icon + label) are one body, and
          // pinned shapes (e.g. a canvas-sized background image) must not
          // shove movable bodies around.
          if (bi.xVar === bj.xVar && bi.yVar === bj.yVar) continue;
          if (
            (inv[bi.xVar] === 0 && inv[bi.yVar] === 0) ||
            (inv[bj.xVar] === 0 && inv[bj.yVar] === 0)
          ) {
            continue;
          }
          let dx = vars[bj.xVar] - vars[bi.xVar];
          let dy = vars[bj.yVar] - vars[bi.yVar];
          let d = Math.sqrt(dx * dx + dy * dy);
          if (d < 1e-4) {
            dx = rand() - 0.5;
            dy = rand() - 0.5;
            d = Math.sqrt(dx * dx + dy * dy) || 1;
          }
          const minD = (bi.r || 20) + (bj.r || 20) + 10;
          const closePush = d < minD ? (minD - d) * 0.18 : 0;
          const farPush = Math.min(1.5, 120 / (d * d + 1));
          const f = closePush + farPush;
          const ux = dx / d;
          const uy = dy / d;
          vars[bi.xVar] -= ux * f * inv[bi.xVar];
          vars[bi.yVar] -= uy * f * inv[bi.yVar];
          vars[bj.xVar] += ux * f * inv[bj.xVar];
          vars[bj.yVar] += uy * f * inv[bj.yVar];
        }
      }
      // Hooke attraction along explicit line edges.
      for (let e = 0; e < S.edges.length; e++) {
        const edge = S.edges[e];
        const bi = bodies[edge[0]];
        const bj = bodies[edge[1]];
        if (!bi || !bj) continue;
        const dx = vars[bj.xVar] - vars[bi.xVar];
        const dy = vars[bj.yVar] - vars[bi.yVar];
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const desired = Math.min(220, Math.max(60, ((bi.r || 20) + (bj.r || 20)) * 2.2));
        const f = Math.max(-3, Math.min(3, (d - desired) * 0.04));
        const ux = dx / d;
        const uy = dy / d;
        vars[bi.xVar] += ux * f * inv[bi.xVar];
        vars[bi.yVar] += uy * f * inv[bi.yVar];
        vars[bj.xVar] -= ux * f * inv[bj.xVar];
        vars[bj.yVar] -= uy * f * inv[bj.yVar];
      }
      // Keep hard constraints satisfied while relaxing the layout.
      resetLambdas();
      for (let p = 0; p < 3; p++) {
        const dragSave = S.dragging;
        S.dragging = false;
        solveSubsteps(1);
        S.dragging = dragSave;
      }
    }
  }

  function projectInitial() {
    resetLambdas();
    for (let i = 0; i < 24; i++) solveSubsteps(1);
  }

  function writeFrame(buffer, maxError, converged) {
    let out = buffer;
    const n = S.vars.length;
    if (!out || out.length < n) out = new Float64Array(n);
    out.set(S.vars.subarray(0, n));
    self.postMessage(
      { type: 'FRAME_DONE', buffer: out, maxError: maxError, converged: converged },
      [out.buffer],
    );
  }

  self.onmessage = function (ev) {
    const msg = ev.data;
    switch (msg.type) {
      case 'INIT_TAPE': {
        S.tape = new Int32Array(msg.tape);
        S.consts = new Float64Array(msg.consts);
        S.vars = new Float64Array(msg.vars);
        S.invMass = new Float64Array(msg.invMass);
        S.constraints = msg.constraints.map(normalizeConstraint);
        S.bodies = (msg.bodies || []).slice();
        S.edges = (msg.edges || []).slice();
        S.width = msg.width || 800;
        S.height = msg.height || 600;
        S.rng = (msg.seed >>> 0) || 1;
        S.nodeCount = S.tape.length / 4;
        S.val = new Float64Array(S.nodeCount);
        S.adj = new Float64Array(S.nodeCount);
        S.grad = new Float64Array(S.vars.length);
        sortConstraints();
        // Sub-pixel jitter breaks perfectly symmetric starting states.
        for (let i = 0; i < S.vars.length; i++) {
          if (S.invMass[i] > 0) S.vars[i] += (rand() - 0.5) * 0.05;
        }
        warmStart(15);
        projectInitial();
        self.postMessage({ type: 'READY' });
        break;
      }
      case 'APPEND_TAPE': {
        S.activeTicks = 0;
        const tapeDelta = new Int32Array(msg.tapeDelta || []);
        if (tapeDelta.length) {
          const nextTape = new Int32Array(S.tape.length + tapeDelta.length);
          nextTape.set(S.tape);
          nextTape.set(tapeDelta, S.tape.length);
          S.tape = nextTape;
        }
        const constsDelta = new Float64Array(msg.constsDelta || []);
        if (constsDelta.length) {
          const nextConsts = new Float64Array(S.consts.length + constsDelta.length);
          nextConsts.set(S.consts);
          nextConsts.set(constsDelta, S.consts.length);
          S.consts = nextConsts;
        }
        const varsDelta = new Float64Array(msg.varsDelta || []);
        if (varsDelta.length) {
          const nextVars = new Float64Array(S.vars.length + varsDelta.length);
          nextVars.set(S.vars);
          nextVars.set(varsDelta, S.vars.length);
          S.vars = nextVars;
        }
        const invDelta = new Float64Array(msg.invMassDelta || []);
        if (invDelta.length) {
          const nextInv = new Float64Array(S.invMass.length + invDelta.length);
          nextInv.set(S.invMass);
          nextInv.set(invDelta, S.invMass.length);
          S.invMass = nextInv;
        }
        const cDelta = msg.constraintsDelta || [];
        for (let i = 0; i < cDelta.length; i++) S.constraints.push(normalizeConstraint(cDelta[i]));
        if ((msg.bodiesDelta || []).length) S.bodies = S.bodies.concat(msg.bodiesDelta);
        if ((msg.edgesDelta || []).length) S.edges = S.edges.concat(msg.edgesDelta);
        resizeNodeArrays(0);
        resizeVarArrays(0);
        if (S.grad.length < S.vars.length) S.grad = new Float64Array(S.vars.length);
        sortConstraints();
        break;
      }
      case 'DRAG_START': {
        S.dragging = true;
        S.activeTicks = 0;
        S.mouseX = msg.mouseX;
        S.mouseY = msg.mouseY;
        const targets = msg.targets || [{ varX: msg.varX, varY: msg.varY, offsetX: 0, offsetY: 0 }];
        S.targets = targets.map((t) => ({
          varX: t.varX,
          varY: t.varY,
          offsetX: t.offsetX || 0,
          offsetY: t.offsetY || 0,
        }));
        break;
      }
      case 'DRAG_MOVE': {
        S.mouseX = msg.mouseX;
        S.mouseY = msg.mouseY;
        break;
      }
      case 'DRAG_END': {
        S.dragging = false;
        S.targets = [];
        break;
      }
      case 'SET_VAR': {
        S.activeTicks = 0;
        if (msg.varIdx >= 0 && msg.varIdx < S.vars.length) S.vars[msg.varIdx] = msg.value;
        break;
      }
      case 'TICK': {
        if (S.prevVars.length !== S.vars.length) S.prevVars = new Float64Array(S.vars.length);
        S.prevVars.set(S.vars);
        resetLambdas();
        solveSubsteps(K_SUBSTEPS);
        const err = maxHardError();
        // Soft-only layouts (encourage) have no hard residual, so convergence
        // also requires the frame's net motion to settle.  A time cap keeps
        // mutually conflicting soft constraints from spinning forever.
        let disp = 0;
        for (let i = 0; i < S.vars.length; i++) {
          const d = Math.abs(S.vars[i] - S.prevVars[i]);
          if (d > disp) disp = d;
        }
        S.activeTicks++;
        const settled = disp < 1e-2 || S.activeTicks > 300;
        const converged = !S.dragging && err < 1e-3 && settled;
        if (converged) S.activeTicks = 0;
        writeFrame(msg.buffer, err, converged);
        break;
      }
      default:
        break;
    }
  };
}

/* ========================================================================== *
 * Module 4 — Scene, Domain / Substance / Style engine, SVG renderer
 * ========================================================================== */

const SVG_NS = 'http://www.w3.org/2000/svg';
let ACTIVE_SCENE = null;
let NEXT_SHAPE_ID = 1;

function isSym(v) {
  return !!(v && typeof v === 'object' && v.__kiteSym === true);
}

function makeSym(nodeId, scene, rel) {
  const s = { __kiteSym: true, nodeId: nodeId };
  Object.defineProperty(s, '__kiteScene', { value: scene, enumerable: false });
  if (rel) Object.defineProperty(s, '__kiteRel', { value: rel, enumerable: false });
  return s;
}

function isTemplate(strings) {
  return Array.isArray(strings) && Object.prototype.hasOwnProperty.call(strings, 'raw');
}

/* -------------------------------------------------------------------------- */
/* Colors — Penrose-style rgba() with 0..1 channels, and none()                */
/* -------------------------------------------------------------------------- */

const NONE_COLOR = Object.freeze({ __kiteColor: true, none: true });

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TypeError('[kite] color channel must be finite');
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function rgba(r, g, b, a = 1) {
  return Object.freeze({
    __kiteColor: true,
    none: false,
    r: clamp01(r),
    g: clamp01(g),
    b: clamp01(b),
    a: clamp01(a),
  });
}

export function none() {
  return NONE_COLOR;
}

/* -------------------------------------------------------------------------- */
/* Equation — dependency-free TeX subset rendered as SVG <tspan>s              */
/* -------------------------------------------------------------------------- */

const TEX_SYMBOLS = Object.freeze({
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  cdot: '·', times: '×', pm: '±', mp: '∓', leq: '≤', geq: '≥', neq: '≠', approx: '≈',
  infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫', to: '→',
  rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', rightleftharpoons: '⇌',
  in: '∈', subset: '⊂', cup: '∪', cap: '∩', circ: '∘', degree: '°',
});

// Parse a TeX subset into runs: { text, shift: -1 | 0 | 1, italic }.
function parseTexRuns(src) {
  const runs = [];
  let i = 0;
  const push = (text, shift, italic) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && last.shift === shift && last.italic === italic) last.text += text;
    else runs.push({ text, shift, italic });
  };
  const readGroup = () => {
    if (src[i] === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      const inner = src.slice(i + 1, j - 1);
      i = j;
      return inner;
    }
    if (src[i] === '\\') {
      const m = /^\\([A-Za-z]+)/.exec(src.slice(i));
      if (m) {
        i += m[0].length;
        return m[0];
      }
    }
    return src[i++] || '';
  };
  const flat = (tex) => parseTexRuns(tex).map((r) => r.text).join('');
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
      const name = m[1];
      i += m[0].length;
      if (name === 'frac') {
        const num = flat(readGroup());
        const den = flat(readGroup());
        push(num + '/' + den, 0, false);
      } else if (name === 'mathrm' || name === 'text' || name === 'mathbf') {
        push(flat(readGroup()), 0, false);
      } else if (name === ',' || name === ';' || name === ' ' || name === 'quad') {
        push(' ', 0, false);
      } else if (TEX_SYMBOLS[name]) {
        push(TEX_SYMBOLS[name], 0, /^[a-z]/.test(name) && name.length > 1 && name !== 'cdot');
      } else {
        push(name, 0, false);
      }
      continue;
    }
    if (ch === '_' || ch === '^') {
      i++;
      push(flat(readGroup()), ch === '_' ? -1 : 1, false);
      continue;
    }
    if (ch === '{' || ch === '}') {
      i++;
      continue;
    }
    if (ch === '$') {
      i++;
      continue;
    }
    push(ch, 0, false);
    i++;
  }
  return runs;
}

function renderEquationInto(textEl, src) {
  while (textEl.firstChild) textEl.removeChild(textEl.firstChild);
  const runs = parseTexRuns(String(src));
  for (const run of runs) {
    const t = document.createElementNS(SVG_NS, 'tspan');
    t.textContent = run.text;
    if (run.shift !== 0) {
      t.setAttribute('font-size', '70%');
      t.setAttribute('baseline-shift', run.shift < 0 ? 'sub' : 'super');
    }
    if (run.italic) t.setAttribute('font-style', 'italic');
    textEl.appendChild(t);
  }
}

function colorToCss(c) {
  if (c === undefined || c === null) return 'none';
  if (typeof c === 'string') return c;
  if (c && c.__kiteColor) {
    if (c.none || c.a === 0) return 'none';
    const to255 = (v) => Math.round(v * 255);
    const rgb = to255(c.r) + ',' + to255(c.g) + ',' + to255(c.b);
    return c.a >= 1 ? 'rgb(' + rgb + ')' : 'rgba(' + rgb + ',' + +c.a.toFixed(4) + ')';
  }
  throw new TypeError('[kite] color must be a CSS string, rgba(...) or none()');
}

function assertScene() {
  if (!ACTIVE_SCENE) {
    throw new Error(
      '[kite] no active scene. Call scene(), or use $/ensure inside a scene method or forall body.',
    );
  }
  return ACTIVE_SCENE;
}

function defaultContainer() {
  if (typeof document === 'undefined') throw new Error('[kite] mount() requires a browser DOM');
  return document.body;
}

function resolveContainer(container) {
  if (container == null) return defaultContainer();
  if (typeof container === 'string') {
    const el = document.querySelector(container);
    if (!el) throw new Error('[kite] container not found: ' + container);
    return el;
  }
  if (container instanceof Element) return container;
  throw new Error('[kite] container must be an HTMLElement or selector');
}

class KiteSceneImpl {
  constructor(container, options) {
    const opts = options || {};
    this.width = Number(opts.width) > 0 ? Number(opts.width) : DEFAULTS.width;
    this.height = Number(opts.height) > 0 ? Number(opts.height) : DEFAULTS.height;
    this.seed = (Number(opts.seed) | 0) || DEFAULTS.seed;

    this.tape = new Tape();
    this.vars = [];
    this.varCount = 0;
    this.varValues = new Float64Array(64);
    this.constraints = [];
    this.shapes = [];
    this.types = [];
    this.instances = [];
    this.rules = [];
    this.inputs = new Map();
    this.subscriptions = new Map();
    this._typeCount = 0;
    this._instanceCount = 1;
    this._nodeVals = new Float64Array(0);
    this._nodesDirty = true;
    this._randState = (this.seed >>> 0) || 1;

    this._container = container == null ? null : container;
    this._mountPromise = null;
    this._mounted = false;
    this._destroyed = false;
    this._svg = null;
    this._host = null;
    this._worker = null;
    this._workerURL = null;
    this._workerInited = false;
    this._inFlight = false;
    this._freeBuf = null;
    this._buffers = [];
    this._bufTurn = 0;
    this._rafId = null;
    this._sleeping = true;
    this._wakeRequested = false;
    this._dragActive = false;
    this._dragShape = null;
    this._dragPointerId = null;
    this._pointerHandlers = null;
    this._topologyDirty = false;
    this._flushScheduled = false;
    this._syncedNodes = 0;
    this._syncedConsts = 0;
    this._syncedVars = 0;
    this._syncedConstraints = 0;
    this._syncedBodies = 0;
    this._syncedEdges = 0;
    this._maxError = Infinity;
    this._converged = false;
    this._frameCount = 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Basic utilities                                                         */
  /* ---------------------------------------------------------------------- */

  _activate() {
    ACTIVE_SCENE = this;
    return this;
  }

  _rand() {
    let x = this._randState >>> 0;
    x ^= (x << 13) >>> 0;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x >>>= 0;
    this._randState = x || 1;
    return this._randState / 4294967296;
  }

  _randomInit() {
    return (this._rand() * 2 - 1) * (Math.min(this.width, this.height) / 3);
  }

  _growVarValues(min) {
    if (this.varValues.length >= min) return;
    let cap = this.varValues.length;
    while (cap < min) cap *= 2;
    const next = new Float64Array(cap);
    next.set(this.varValues.subarray(0, this.varCount));
    this.varValues = next;
  }

  _computeNodes(force) {
    const n = this.tape.nodeCount;
    if (!force && !this._nodesDirty && this._nodeVals.length === n) return;
    this._nodeVals = evaluateTape(this.tape, this.tape.consts, this.varValues);
    this._nodesDirty = false;
  }

  _valueOfNode(nodeId) {
    this._computeNodes(false);
    return this._nodeVals[nodeId];
  }

  _val(v) {
    if (typeof v === 'number') return v;
    if (isSym(v)) return this._valueOfNode(v.nodeId);
    return 0;
  }

  get maxError() {
    return this._maxError;
  }

  get converged() {
    return this._converged;
  }

  get frameCount() {
    return this._frameCount;
  }

  /* ---------------------------------------------------------------------- */
  /* Domain API                                                              */
  /* ---------------------------------------------------------------------- */

  type(name, ...supertypes) {
    this._activate();
    if (!name || typeof name !== 'string') throw new TypeError('[kite] type name must be a string');
    const id = this._typeCount++;
    if (id >= 30) {
      throw new Error('[kite] JS bitmask domain supports at most 30 types per scene');
    }
    let mask = (1 << id) >>> 0;
    for (const st of supertypes) {
      if (!st || st.__kiteType !== true) throw new TypeError('[kite] supertype must be a DomainType');
      mask = (mask | st.bitmask) >>> 0;
    }
    const scene = this;
    const def = { __kiteType: true, name: name, bitmask: mask, typeId: id };
    function DomainType(initialProps) {
      scene._activate();
      const inst = Object.assign({}, initialProps || {});
      Object.defineProperties(inst, {
        __kiteInstance: { value: true, enumerable: false },
        id: { value: scene._instanceCount++, enumerable: false },
        typeMask: { value: mask, enumerable: false },
        __kiteTypeRef: { value: def, enumerable: false },
      });
      scene.instances.push(inst);
      return inst;
    }
    Object.defineProperties(DomainType, {
      __kiteType: { value: true },
      bitmask: { value: mask },
      typeId: { value: id },
      typeName: { value: name },
      supertypes: { value: Object.freeze(supertypes.slice()) },
    });
    try {
      Object.defineProperty(DomainType, 'name', { value: name });
    } catch (_) {
      /* Function#name is configurable in modern engines; ignore exotic hosts. */
    }
    this.types.push(DomainType);
    return DomainType;
  }

  predicate(name, argTypes) {
    this._activate();
    if (!Array.isArray(argTypes)) throw new TypeError('[kite] predicate argTypes must be an array');
    for (const T of argTypes) {
      if (!T || T.__kiteType !== true) throw new TypeError('[kite] predicate argument types must be DomainTypes');
    }
    const scene = this;
    const relations = [];
    const signatures = new Set();

    function typeOk(inst, T) {
      return !!(inst && inst.__kiteInstance && (inst.typeMask & T.bitmask) === T.bitmask);
    }

    function Predicate(...args) {
      scene._activate();
      if (args.length !== argTypes.length) {
        throw new TypeError('[kite] predicate ' + name + ' expects ' + argTypes.length + ' arguments');
      }
      for (let i = 0; i < args.length; i++) {
        if (!typeOk(args[i], argTypes[i])) {
          throw new TypeError('[kite] predicate ' + name + ' argument ' + i + ' has the wrong domain type');
        }
      }
      relations.push(args.slice());
      signatures.add(args.map((a) => a.id).join(','));
    }

    Predicate.test = (...args) => {
      if (args.length !== argTypes.length) return false;
      for (let i = 0; i < args.length; i++) if (!typeOk(args[i], argTypes[i])) return false;
      return signatures.has(args.map((a) => a.id).join(','));
    };
    Predicate.relations = relations;
    Object.defineProperties(Predicate, {
      __kitePredicate: { value: true },
      predicateName: { value: name },
      argTypes: { value: Object.freeze(argTypes.slice()) },
    });
    try {
      Object.defineProperty(Predicate, 'name', { value: name });
    } catch (_) {
      /* noop */
    }
    return Predicate;
  }

  /* ---------------------------------------------------------------------- */
  /* Style / Substance matching                                              */
  /* ---------------------------------------------------------------------- */

  forall(selector, body) {
    return this._registerRule(selector, null, body);
  }

  forallWhere(selector, guard, body) {
    return this._registerRule(selector, guard, body);
  }

  _registerRule(selector, guard, body) {
    this._activate();
    if (!selector || typeof selector !== 'object') throw new TypeError('[kite] selector must be an object');
    if (typeof body !== 'function') throw new TypeError('[kite] forall body must be a function');
    if (guard != null && typeof guard !== 'function') throw new TypeError('[kite] guard must be a function');
    const keys = Object.keys(selector);
    if (keys.length === 0) throw new Error('[kite] selector must have at least one key');
    for (const k of keys) {
      if (!selector[k] || selector[k].__kiteType !== true) {
        throw new TypeError('[kite] selector "' + k + '" is not a DomainType');
      }
    }
    const rule = {
      selector: selector,
      keys: keys,
      guard: guard || null,
      body: body,
      executed: new Set(),
    };
    this.rules.push(rule);
    return rule;
  }

  _runRules() {
    let passes = 0;
    let progress = true;
    while (progress && passes++ < 64) {
      progress = false;
      for (const rule of this.rules) {
        if (this._runRule(rule)) progress = true;
      }
    }
  }

  _runRule(rule) {
    const keys = rule.keys;
    const nslots = keys.length;
    const pools = keys.map((k) => {
      const T = rule.selector[k];
      return this.instances.filter((inst) => (inst.typeMask & T.bitmask) === T.bitmask);
    });
    if (pools.some((p) => p.length === 0)) return false;
    const combo = new Array(nslots);
    const used = new Set();
    let executedAny = false;

    const walk = (slot) => {
      if (slot === nslots) {
        const sig = combo.map((inst) => inst.id).join(',');
        if (rule.executed.has(sig)) return false;
        const matched = {};
        for (let i = 0; i < nslots; i++) matched[keys[i]] = combo[i];
        if (rule.guard) {
          this._activate();
          let ok = false;
          try {
            ok = !!rule.guard(matched);
          } catch (err) {
            throw err;
          }
          if (!ok) return false;
        }
        rule.executed.add(sig);
        this._activate();
        rule.body(matched);
        executedAny = true;
        return true;
      }
      for (const inst of pools[slot]) {
        if (used.has(inst.id)) continue;
        used.add(inst.id);
        combo[slot] = inst;
        if (walk(slot + 1)) {
          // Continue scanning: later slots may still have new combinations.
        }
        used.delete(inst.id);
      }
      return false;
    };

    walk(0);
    return executedAny;
  }

  step() {
    this._activate();
    this._runRules();
    this._runCollectRules();
    if (this._mounted) {
      this._flushToWorker();
      this._wake();
      this._render();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Inputs                                                                  */
  /* ---------------------------------------------------------------------- */

  input(options) {
    this._activate();
    const opts = options || {};
    if (opts.name && this.inputs.has(opts.name)) {
      throw new Error('[kite] duplicate input name: ' + opts.name);
    }
    const init = opts.init === undefined ? this._randomInit() : Number(opts.init);
    if (!Number.isFinite(init)) throw new TypeError('[kite] input init must be finite');
    const idx = this.varCount++;
    this._growVarValues(this.varCount);
    const rec = {
      index: idx,
      name: opts.name || null,
      invMass: opts.optimized === false ? 0 : 1,
      value: init,
    };
    this.vars.push(rec);
    this.varValues[idx] = init;
    if (rec.name) this.inputs.set(rec.name, rec);
    this._nodesDirty = true;
    // A variable is represented by a tape node whose arg1 is the variable slot.
    const nodeId = this.tape.emit(Op.VAR, idx, -1, -1);
    return makeSym(nodeId, this);
  }

  _varIndex(v) {
    return this.tape.words[v.nodeId * NODE_STRIDE + 1];
  }

  getInput(name) {
    const rec = this.inputs.get(name);
    if (!rec) throw new Error('[kite] unknown input: ' + name);
    return this.varValues[rec.index];
  }

  setInput(name, value) {
    const rec = this.inputs.get(name);
    if (!rec) throw new Error('[kite] unknown input: ' + name);
    const v = Number(value);
    if (!Number.isFinite(v)) throw new TypeError('[kite] input value must be finite');
    this.varValues[rec.index] = v;
    rec.value = v;
    this._nodesDirty = true;
    if (this._worker) this._worker.postMessage({ type: 'SET_VAR', varIdx: rec.index, value: v });
    this._notify(name, v);
    if (this._mounted) {
      this._wake();
      this._render();
    }
  }

  subscribe(name, callback) {
    if (!this.inputs.has(name)) throw new Error('[kite] unknown input: ' + name);
    if (typeof callback !== 'function') throw new TypeError('[kite] subscribe callback must be a function');
    let set = this.subscriptions.get(name);
    if (!set) {
      set = new Set();
      this.subscriptions.set(name, set);
    }
    set.add(callback);
    return () => set.delete(callback);
  }

  _notify(name, value) {
    const set = this.subscriptions.get(name);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(value);
      } catch (err) {
        console.error('[kite] subscriber error', err);
      }
    }
  }

  _notifyChangedVars() {
    for (const [name, rec] of this.inputs) {
      const v = this.varValues[rec.index];
      if (Math.abs(v - rec.value) > 1e-6) {
        rec.value = v;
        this._notify(name, v);
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Shapes                                                                  */
  /* ---------------------------------------------------------------------- */

  _coord(value, drag, label) {
    if (typeof value === 'number') {
      return this.input({ init: value, optimized: !!drag });
    }
    if (!isSym(value)) {
      throw new TypeError('[kite] ' + label + ' must be a number or SymExpr');
    }
    if (value.__kiteScene && value.__kiteScene !== this) {
      throw new Error('[kite] ' + label + ' belongs to a different scene');
    }
    const op = this.tape.opcode(value.nodeId);
    if (op === Op.VAR) return value;
    if (!drag) return value;

    // Auto-Slacking: allocate a free variable u and hard-link u = expr.
    const initial = this._valueOfNode(value.nodeId);
    const slack = this.input({ init: initial, optimized: true });
    this.addConstraint(
      this.tape.emit(Op.SUB, slack.nodeId, value.nodeId, 0),
      ConstraintKind.EQUALITY,
      0,
    );
    return slack;
  }

  _center(value, drag, label) {
    let arr = value;
    if (arr === undefined || arr === null) arr = [0, 0];
    if (!Array.isArray(arr) || arr.length !== 2) {
      throw new TypeError('[kite] ' + label + '.center must be [x, y]');
    }
    const x = this._coord(arr[0], drag, label + '.center[0]');
    const y = this._coord(arr[1], drag, label + '.center[1]');
    return [x, y];
  }

  _scalar(value, fallback, label) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('[kite] ' + label + ' must be finite');
      return value;
    }
    if (isSym(value)) {
      if (value.__kiteScene && value.__kiteScene !== this) {
        throw new Error('[kite] ' + label + ' belongs to a different scene');
      }
      return value;
    }
    throw new TypeError('[kite] ' + label + ' must be a number or SymExpr');
  }

  _commonProps(props, kind) {
    const isLine = kind === 'line';
    const isText = kind === 'text' || kind === 'equation';
    const fill =
      props.fill !== undefined
        ? props.fill
        : props.fillColor !== undefined
          ? props.fillColor
          : isLine ? 'none' : isText ? '#0f172a' : '#7c9cff';
    const stroke =
      props.stroke !== undefined
        ? props.stroke
        : props.strokeColor !== undefined
          ? props.strokeColor
          : isText ? 'none' : '#1f2937';
    colorToCss(fill);
    colorToCss(stroke);
    return {
      fill: fill,
      stroke: stroke,
      strokeWidth: this._scalar(props.strokeWidth, 2, 'strokeWidth'),
      opacity: this._scalar(props.opacity, 1, 'opacity'),
      layer: props.layer === undefined ? 0 : Number(props.layer),
      drag: !!props.drag,
      style: typeof props.style === 'string' ? props.style : '',
      strokeLinecap: typeof props.strokeLinecap === 'string' ? props.strokeLinecap : null,
      strokeDasharray:
        typeof props.strokeDasharray === 'string' || typeof props.strokeDasharray === 'number'
          ? String(props.strokeDasharray)
          : null,
    };
  }

  _registerShape(shape, extra) {
    shape.el = null;
    shape.arrowEl = null;
    shape.parent = null;
    shape.removed = false;
    this.shapes.push(shape);
    this._markTopologyDirty();
    this._requestRender();
    const handle = Object.assign({}, shape.common, extra, { shapeId: shape.id });
    Object.defineProperty(handle, '__kiteShape', { value: shape, enumerable: false });
    return handle;
  }

  circle(props) {
    this._activate();
    const p = props || {};
    const common = this._commonProps(p, 'circle');
    const center = this._center(p.center, common.drag, 'circle');
    const r = this._scalar(p.r, 40, 'circle.r');
    const shape = { id: NEXT_SHAPE_ID++, kind: 'circle', x: center[0], y: center[1], r: r, common: common };
    return this._registerShape(shape, { center: center, r: r });
  }

  ellipse(props) {
    this._activate();
    const p = props || {};
    const common = this._commonProps(p, 'ellipse');
    const center = this._center(p.center, common.drag, 'ellipse');
    const rx = this._scalar(p.rx, 60, 'ellipse.rx');
    const ry = this._scalar(p.ry, 30, 'ellipse.ry');
    const shape = { id: NEXT_SHAPE_ID++, kind: 'ellipse', x: center[0], y: center[1], rx: rx, ry: ry, common: common };
    return this._registerShape(shape, { center: center, rx: rx, ry: ry });
  }

  line(props) {
    this._activate();
    const p = props || {};
    const common = this._commonProps(p, 'line');
    const start = this._center(p.start === undefined ? [-100, 0] : p.start, common.drag, 'line.start');
    const end = this._center(p.end === undefined ? [100, 0] : p.end, common.drag, 'line.end');
    if (p.style === 'dashed' && !common.strokeDasharray) common.strokeDasharray = '7,5';
    const shape = { id: NEXT_SHAPE_ID++, kind: 'line', start: start, end: end, arrowEnd: !!p.arrowEnd, common: common };
    return this._registerShape(shape, { start: start, end: end, arrowEnd: !!p.arrowEnd });
  }

  rect(props) {
    this._activate();
    const p = props || {};
    const common = this._commonProps(p, 'rect');
    const center = this._center(p.center, common.drag, 'rect');
    const width = this._scalar(p.width, 120, 'rect.width');
    const height = this._scalar(p.height, 80, 'rect.height');
    const cornerRadius = this._scalar(p.cornerRadius, 0, 'rect.cornerRadius');
    const shape = {
      id: NEXT_SHAPE_ID++,
      kind: 'rect',
      x: center[0],
      y: center[1],
      width: width,
      height: height,
      cornerRadius: cornerRadius,
      common: common,
    };
    return this._registerShape(shape, { center: center, width: width, height: height, cornerRadius: cornerRadius });
  }

  _textLike(kind, props) {
    this._activate();
    const p = props || {};
    if (typeof p.string !== 'string') throw new TypeError('[kite] ' + kind + '.string is required');
    const common = this._commonProps(p, kind);
    const center = this._center(p.center, common.drag, kind);
    const fontSize = p.fontSize === undefined ? 16 : p.fontSize;
    if (typeof fontSize !== 'number' && typeof fontSize !== 'string' && !isSym(fontSize)) {
      throw new TypeError('[kite] ' + kind + '.fontSize must be a number, string or SymExpr');
    }
    if (isSym(fontSize) && fontSize.__kiteScene && fontSize.__kiteScene !== this) {
      throw new Error('[kite] ' + kind + '.fontSize belongs to a different scene');
    }
    const shape = {
      id: NEXT_SHAPE_ID++,
      kind: kind,
      x: center[0],
      y: center[1],
      string: p.string,
      fontSize: fontSize,
      fontFamily: typeof p.fontFamily === 'string' ? p.fontFamily : null,
      fontWeight: p.fontWeight !== undefined ? String(p.fontWeight) : null,
      common: common,
    };
    return this._registerShape(shape, { center: center, string: p.string, fontSize: fontSize });
  }

  text(props) {
    return this._textLike('text', props);
  }

  /**
   * Equation renders a small TeX-like subset without external dependencies:
   * `_` / `^` scripts (single char or `{...}`), `\frac{a}{b}` as a/b, Greek
   * letters, and a few operators.  Digits after element symbols in chemical
   * formulas (`H_2O`) are therefore expressed as `H_2O`.
   */
  equation(props) {
    return this._textLike('equation', props);
  }

  image(props) {
    this._activate();
    const p = props || {};
    if (typeof p.href !== 'string' || !p.href) throw new TypeError('[kite] image.href is required');
    const common = this._commonProps(p, 'image');
    const center = this._center(p.center, common.drag, 'image');
    const width = this._scalar(p.width, 100, 'image.width');
    const height = this._scalar(p.height, 100, 'image.height');
    const shape = {
      id: NEXT_SHAPE_ID++,
      kind: 'image',
      x: center[0],
      y: center[1],
      width: width,
      height: height,
      href: p.href,
      preserveAspectRatio: typeof p.preserveAspectRatio === 'string' ? p.preserveAspectRatio : 'xMidYMid meet',
      common: common,
    };
    return this._registerShape(shape, { center: center, width: width, height: height, href: p.href });
  }

  /**
   * Group re-parents existing shapes into one <g>.  Group opacity, style
   * (e.g. "filter:blur(5px)") and layer apply to the whole set.  Members keep
   * their own relative paint order inside the group.
   */
  group(props) {
    this._activate();
    const p = props || {};
    const members = Array.isArray(p.shapes) ? p.shapes : [];
    const common = this._commonProps(p, 'group');
    const shape = { id: NEXT_SHAPE_ID++, kind: 'group', members: [], common: common };
    const handle = this._registerShape(shape, { shapes: members });
    for (const m of members) {
      const child = this._shapeOf(m, 'group.shapes');
      if (child === shape) throw new Error('[kite] a group cannot contain itself');
      if (child.parent && child.parent !== shape) {
        throw new Error('[kite] shape ' + child.id + ' already belongs to another group');
      }
      child.parent = shape;
      shape.members.push(child);
      if (child.el && child.el.parentNode) child.el.parentNode.removeChild(child.el);
    }
    return handle;
  }

  /**
   * collect(Type, project, body) gathers every matching Substance instance
   * into a list, maps it through `project`, and calls `body(list)` once.  It
   * re-runs on step() only when the matched set grows, replacing the shapes
   * produced by the previous run.
   */
  collect(selectorType, project, body) {
    this._activate();
    if (!selectorType || selectorType.__kiteType !== true) {
      throw new TypeError('[kite] collect() needs a DomainType');
    }
    if (typeof project !== 'function' || typeof body !== 'function') {
      throw new TypeError('[kite] collect(Type, project, body) needs two functions');
    }
    const rule = { type: selectorType, project: project, body: body, seen: '', produced: [] };
    this._collectRules = this._collectRules || [];
    this._collectRules.push(rule);
    return rule;
  }

  _runCollectRules() {
    if (!this._collectRules) return;
    for (const rule of this._collectRules) {
      const T = rule.type;
      const matched = this.instances.filter((inst) => (inst.typeMask & T.bitmask) === T.bitmask);
      const sig = matched.map((m) => m.id).join(',');
      if (sig === rule.seen) continue;
      rule.seen = sig;
      for (const old of rule.produced) this._removeShape(old);
      const before = this.shapes.length;
      this._activate();
      const items = [];
      for (const inst of matched) {
        const v = rule.project(inst);
        if (v !== undefined && v !== null) items.push(v);
      }
      rule.body(items);
      rule.produced = this.shapes.slice(before);
    }
  }

  _removeShape(shape) {
    if (!shape || shape.removed) return;
    shape.removed = true;
    if (shape.kind === 'group') {
      for (const child of shape.members) {
        child.parent = null;
        if (child.el && child.el.parentNode) child.el.parentNode.removeChild(child.el);
        if (this._svg && child.el && !child.removed) this._insertByLayer(child.el, child.common.layer);
      }
      shape.members = [];
    }
    if (shape.el && shape.el.parentNode) shape.el.parentNode.removeChild(shape.el);
    const i = this.shapes.indexOf(shape);
    if (i >= 0) this.shapes.splice(i, 1);
    this._requestRender();
  }

  _shapeOf(handle, label) {
    const shape = handle && (handle.__kiteShape || (handle.kind && handle.common ? handle : null));
    if (!shape) throw new TypeError('[kite] ' + (label || 'value') + ' is not a shape handle');
    return shape;
  }

  /**
   * override(shapeHandle, props) replaces style or geometry props after a
   * shape is created, mirroring Penrose's `override x.icon.fillColor = ...`.
   * Later rules win.  Geometry props accept numbers or SymExprs.
   */
  override(handle, props) {
    this._activate();
    const shape = this._shapeOf(handle, 'override target');
    const p = props || {};
    const c = shape.common;
    for (const key of Object.keys(p)) {
      const v = p[key];
      switch (key) {
        case 'fill':
        case 'fillColor':
          colorToCss(v);
          c.fill = v;
          break;
        case 'stroke':
        case 'strokeColor':
          colorToCss(v);
          c.stroke = v;
          break;
        case 'strokeWidth':
        case 'opacity':
          c[key] = this._scalar(v, c[key], key);
          break;
        case 'layer':
          c.layer = Number(v);
          if (shape.el) {
            shape.el.__kiteLayer = c.layer;
            if (!shape.parent && shape.el.parentNode) {
              shape.el.parentNode.removeChild(shape.el);
              this._insertByLayer(shape.el, c.layer);
            }
          }
          break;
        case 'style':
          c.style = String(v || '');
          break;
        case 'strokeLinecap':
          c.strokeLinecap = v == null ? null : String(v);
          break;
        case 'strokeDasharray':
          c.strokeDasharray = v == null ? null : String(v);
          break;
        case 'r':
        case 'rx':
        case 'ry':
        case 'width':
        case 'height':
        case 'cornerRadius':
          if (!(key in shape)) throw new Error('[kite] ' + shape.kind + ' has no "' + key + '" property');
          shape[key] = this._scalar(v, shape[key], key);
          break;
        case 'fontSize':
          if (!('fontSize' in shape)) throw new Error('[kite] ' + shape.kind + ' has no fontSize');
          shape.fontSize = v;
          break;
        case 'string':
          if (!('string' in shape)) throw new Error('[kite] ' + shape.kind + ' has no string');
          shape.string = String(v);
          if (shape.primitiveEl) shape._renderedString = null;
          break;
        case 'href':
          if (shape.kind !== 'image') throw new Error('[kite] only images have href');
          shape.href = String(v);
          break;
        case 'fontFamily':
        case 'fontWeight':
          shape[key] = v == null ? null : String(v);
          break;
        default:
          throw new Error('[kite] override: unsupported property "' + key + '"');
      }
    }
    this._requestRender();
    return handle;
  }

  _requestRender() {
    if (!this._svg || this._renderQueued) return;
    this._renderQueued = true;
    queueMicrotask(() => {
      this._renderQueued = false;
      if (!this._destroyed) this._render();
    });
  }

  addConstraint(rootNodeId, kind, compliance, pair) {
    const deps = nodeDependencies(this.tape, rootNodeId);
    let broadphase = null;
    if (pair) {
      const asVar = (v) => {
        if (!isSym(v) || this.tape.opcode(v.nodeId) !== Op.VAR) return -1;
        return this._varIndex(v);
      };
      const ax = asVar(pair.a.center[0]);
      const ay = asVar(pair.a.center[1]);
      const bx = asVar(pair.b.center[0]);
      const by = asVar(pair.b.center[1]);
      if (ax >= 0 && ay >= 0 && bx >= 0 && by >= 0) {
        let margin = 0;
        if (pair.pad !== undefined) {
          const pv = typeof pair.pad === 'number' ? pair.pad : this._val(pair.pad);
          if (Number.isFinite(pv)) margin = Math.abs(pv);
        }
        broadphase = { ax, ay, bx, by, margin };
      }
    }
    const rec = {
      rootNodeId: rootNodeId,
      kind: kind,
      compliance: compliance,
      lambda: 0,
      depNodes: deps.depNodes,
      depVars: deps.depVars,
      pair: broadphase,
    };
    this.constraints.push(rec);
    this._markTopologyDirty();
    return rec;
  }

  ensureTemplate(strings, values) {
    const { node, kind, pair } = emitTemplate(strings, values, this);
    return this.addConstraint(node, kind == null ? ConstraintKind.EQUALITY : kind, 0, pair);
  }

  encourageTemplate(strings, values) {
    const { node, kind, pair } = emitTemplate(strings, values, this);
    return this.addConstraint(node, kind == null ? ConstraintKind.EQUALITY : kind, 1e-2, pair);
  }

  /* ---------------------------------------------------------------------- */
  /* Topology sync                                                           */
  /* ---------------------------------------------------------------------- */

  _markTopologyDirty() {
    this._topologyDirty = true;
    if (!this._mounted || this._destroyed) return;
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    queueMicrotask(() => {
      this._flushScheduled = false;
      if (this._destroyed) return;
      this._flushToWorker();
      this._wake();
    });
  }

  _buildBodies() {
    const bodies = [];
    const varToBody = new Map();
    for (const shape of this.shapes) {
      if (shape.kind === 'line' || shape.kind === 'group') continue;
      let xVar = null;
      let yVar = null;
      if (isSym(shape.x) && this.tape.opcode(shape.x.nodeId) === Op.VAR) xVar = this._varIndex(shape.x);
      if (isSym(shape.y) && this.tape.opcode(shape.y.nodeId) === Op.VAR) yVar = this._varIndex(shape.y);
      if (xVar == null || yVar == null) {
        shape._bodyIndex = -1;
        continue;
      }
      let radius = 30;
      if (shape.kind === 'circle') radius = Math.abs(this._val(shape.r)) || 1;
      else if (shape.kind === 'rect') radius = Math.max(Math.abs(this._val(shape.width)), Math.abs(this._val(shape.height))) / 2;
      else if (shape.kind === 'ellipse') radius = Math.max(Math.abs(this._val(shape.rx)), Math.abs(this._val(shape.ry)));
      else if (shape.kind === 'image') radius = Math.max(Math.abs(this._val(shape.width)), Math.abs(this._val(shape.height))) / 2;
      else if (shape.kind === 'text' || shape.kind === 'equation') radius = 16;
      const existing = varToBody.get(xVar);
      if (existing !== undefined && bodies[existing].yVar === yVar) {
        bodies[existing].r = Math.max(bodies[existing].r, radius);
        shape._bodyIndex = existing;
        continue;
      }
      const body = { xVar: xVar, yVar: yVar, r: radius };
      shape._bodyIndex = bodies.length;
      varToBody.set(xVar, bodies.length);
      varToBody.set(yVar, bodies.length);
      bodies.push(body);
    }
    this._varToBody = varToBody;
    return bodies;
  }

  _buildEdges(bodies) {
    const edges = [];
    const varToBody = this._varToBody || new Map();
    for (const shape of this.shapes) {
      if (shape.kind !== 'line') continue;
      const sx = isSym(shape.start[0]) ? varToBody.get(this._varIndex(shape.start[0])) : undefined;
      const sy = isSym(shape.start[1]) ? varToBody.get(this._varIndex(shape.start[1])) : undefined;
      const ex = isSym(shape.end[0]) ? varToBody.get(this._varIndex(shape.end[0])) : undefined;
      const ey = isSym(shape.end[1]) ? varToBody.get(this._varIndex(shape.end[1])) : undefined;
      let a = sx !== undefined ? sx : sy;
      let b = ex !== undefined ? ex : ey;
      if (a === undefined || b === undefined) {
        // Fall back to nearest bodies by evaluated position.
        const s = [this._val(shape.start[0]), this._val(shape.start[1])];
        const e = [this._val(shape.end[0]), this._val(shape.end[1])];
        const nearest = (pt) => {
          let best = -1;
          let bestD = 90;
          for (let i = 0; i < bodies.length; i++) {
            const body = bodies[i];
            const dx = this.varValues[body.xVar] - pt[0];
            const dy = this.varValues[body.yVar] - pt[1];
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          return best;
        };
        if (a === undefined) a = nearest(s);
        if (b === undefined) b = nearest(e);
      }
      if (a !== undefined && b !== undefined && a !== b && a >= 0 && b >= 0) edges.push([a, b]);
    }
    return edges;
  }

  _serializeConstraints(from) {
    const out = [];
    for (let i = from; i < this.constraints.length; i++) {
      const c = this.constraints[i];
      out.push({
        rootNodeId: c.rootNodeId,
        kind: c.kind,
        compliance: c.compliance,
        depNodes: Array.from(c.depNodes),
        depVars: Array.from(c.depVars),
        pair: c.pair || null,
      });
    }
    return out;
  }

  _flushToWorker() {
    if (!this._mounted || !this._worker || this._destroyed) return;
    const bodies = this._buildBodies();
    const edges = this._buildEdges(bodies);

    if (!this._workerInited) {
      this._workerInited = true;
      const vars = this.varValues.slice(0, this.varCount);
      const invMass = new Float64Array(this.varCount);
      for (let i = 0; i < this.varCount; i++) invMass[i] = this.vars[i].invMass;
      this._worker.postMessage({
        type: 'INIT_TAPE',
        tape: this.tape.serialize(0),
        consts: this.tape.serializeConsts(0),
        vars: vars,
        invMass: invMass,
        constraints: this._serializeConstraints(0),
        bodies: bodies,
        edges: edges,
        width: this.width,
        height: this.height,
        seed: this.seed,
      });
    } else {
      const tapeDelta = this.tape.serialize(this._syncedNodes);
      const constsDelta = this.tape.serializeConsts(this._syncedConsts);
      const varsDelta = this.varValues.slice(this._syncedVars, this.varCount);
      const invMassDelta = new Float64Array(Math.max(0, this.varCount - this._syncedVars));
      for (let i = this._syncedVars; i < this.varCount; i++) invMassDelta[i - this._syncedVars] = this.vars[i].invMass;
      const constraintsDelta = this._serializeConstraints(this._syncedConstraints);
      const bodiesDelta = bodies.slice(this._syncedBodies);
      const edgesDelta = edges.slice(this._syncedEdges);
      if (
        tapeDelta.length ||
        constsDelta.length ||
        varsDelta.length ||
        constraintsDelta.length ||
        bodiesDelta.length ||
        edgesDelta.length
      ) {
        this._worker.postMessage({
          type: 'APPEND_TAPE',
          tapeDelta: tapeDelta,
          constsDelta: constsDelta,
          varsDelta: varsDelta,
          invMassDelta: invMassDelta,
          constraintsDelta: constraintsDelta,
          bodiesDelta: bodiesDelta,
          edgesDelta: edgesDelta,
        });
      }
    }
    this._syncedNodes = this.tape.nodeCount;
    this._syncedConsts = this.tape.constCount;
    this._syncedVars = this.varCount;
    this._syncedConstraints = this.constraints.length;
    this._syncedBodies = bodies.length;
    this._syncedEdges = edges.length;
    this._topologyDirty = false;
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  mount(container) {
    if (this._mountPromise) return this._mountPromise;
    if (typeof document === 'undefined') {
      return Promise.reject(new Error('[kite] mount() requires a browser DOM'));
    }
    this._mountPromise = (async () => {
      this._setupDOM(container == null ? this._container : container);
      this._createWorker();
      this._mounted = true;
      this._flushToWorker();
      this._render();
      this._wake();
    })();
    return this._mountPromise;
  }

  _setupDOM(container) {
    const host = resolveContainer(container);
    this._host = host;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', -this.width / 2 + ' ' + -this.height / 2 + ' ' + this.width + ' ' + this.height);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('role', 'img');
    svg.style.display = 'block';
    svg.style.touchAction = 'none';
    svg.style.userSelect = 'none';
    svg.style.overflow = 'visible';

    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('x', String(-this.width / 2));
    bg.setAttribute('y', String(-this.height / 2));
    bg.setAttribute('width', String(this.width));
    bg.setAttribute('height', String(this.height));
    bg.setAttribute('fill', 'transparent');
    bg.setAttribute('pointer-events', 'all');
    svg.appendChild(bg);

    this._svg = svg;
    host.appendChild(svg);
    this._attachPointerHandlers();
  }

  _createWorker() {
    try {
      const src = '(' + kiteWorkerMain.toString() + ')();';
      const blob = new Blob([src], { type: 'text/javascript' });
      this._workerURL = URL.createObjectURL(blob);
      this._worker = new Worker(this._workerURL);
      this._worker.onmessage = (ev) => this._onWorkerMessage(ev.data);
      this._worker.onerror = (err) => {
        console.error('[kite] worker error', err.message || err);
        this._inFlight = false;
        this._sleeping = true;
      };
      const url = this._workerURL;
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {
          /* noop */
        }
      }, 0);
    } catch (err) {
      console.error('[kite] failed to create worker', err);
      this._worker = null;
    }
  }

  _onWorkerMessage(msg) {
    if (!msg || this._destroyed) return;
    if (msg.type === 'FRAME_DONE') {
      this._inFlight = false;
      const buf = msg.buffer;
      const n = Math.min(this.varCount, buf.length);
      for (let i = 0; i < n; i++) this.varValues[i] = buf[i];
      this._freeBuf = buf;
      this._nodesDirty = true;
      this._maxError = msg.maxError;
      this._converged = !!msg.converged;
      this._frameCount++;
      this._notifyChangedVars();
      this._render();
      if (msg.converged && !this._dragActive) this._sleeping = true;
    }
  }

  _ensureBuffers() {
    const n = this.varCount;
    if (this._buffers.length === 0 || this._buffers[0].length < n) {
      this._buffers = [new Float64Array(n), new Float64Array(n)];
      this._freeBuf = null;
    }
  }

  _sendTick() {
    if (!this._worker || this._inFlight) return;
    this._ensureBuffers();
    let buf = this._freeBuf;
    this._freeBuf = null;
    if (!buf || buf.length < this.varCount) {
      buf = this._buffers[this._bufTurn];
      this._bufTurn = (this._bufTurn + 1) % 2;
      if (buf.length < this.varCount) buf = new Float64Array(this.varCount);
    }
    this._inFlight = true;
    try {
      this._worker.postMessage({ type: 'TICK', buffer: buf }, [buf.buffer]);
    } catch (err) {
      this._inFlight = false;
      console.error('[kite] tick failed', err);
    }
  }

  _wake() {
    if (!this._mounted || this._destroyed) return;
    this._sleeping = false;
    if (this._rafId == null) {
      this._rafId = requestAnimationFrame(this._loop);
    }
  }

  _loop = () => {
    this._rafId = null;
    if (this._destroyed || !this._mounted) return;
    if (!this._worker) {
      this._sleeping = true;
      return;
    }
    if (this._sleeping && !this._dragActive) return;
    if (!this._inFlight) this._sendTick();
    if (!this._sleeping || this._dragActive) {
      this._rafId = requestAnimationFrame(this._loop);
    }
  };

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._rafId != null) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
    if (this._workerURL) {
      try {
        URL.revokeObjectURL(this._workerURL);
      } catch (_) {
        /* noop */
      }
      this._workerURL = null;
    }
    if (this._svg) {
      this._detachPointerHandlers();
      if (this._svg.parentNode) this._svg.parentNode.removeChild(this._svg);
      this._svg = null;
    }
    this._mounted = false;
  }

  /* ---------------------------------------------------------------------- */
  /* SVG renderer                                                            */
  /* ---------------------------------------------------------------------- */

  _render() {
    if (!this._svg) return;
    this._computeNodes(false);
    // Groups first so their <g> exists before members are moved into it.
    for (const shape of this.shapes) {
      if (shape.kind === 'group' && !shape.el) this._createShapeDOM(shape);
    }
    for (const shape of this.shapes) {
      if (!shape.el) this._createShapeDOM(shape);
      this._attachToParent(shape);
      this._renderShape(shape);
    }
  }

  _attachToParent(shape) {
    const parent = shape.parent;
    if (!parent || !parent.el) return;
    if (shape.el.parentNode === parent.el) return;
    if (shape.el.parentNode) shape.el.parentNode.removeChild(shape.el);
    // Keep member order stable inside the group by layer, then creation id.
    const siblings = parent.el.children;
    for (let i = 0; i < siblings.length; i++) {
      const sib = siblings[i];
      const sl = Number(sib.__kiteLayer ?? 0);
      const sid = Number(sib.getAttribute('data-kite-shape'));
      if (sl > shape.common.layer || (sl === shape.common.layer && sid > shape.id)) {
        parent.el.insertBefore(shape.el, sib);
        return;
      }
    }
    parent.el.appendChild(shape.el);
  }

  _insertByLayer(group, layer) {
    const svg = this._svg;
    const children = svg.children;
    for (let i = 1; i < children.length; i++) {
      const el = children[i];
      if (el.tagName === 'defs') continue;
      const l = Number(el.__kiteLayer ?? 0);
      if (l > layer) {
        svg.insertBefore(group, el);
        return;
      }
    }
    svg.appendChild(group);
  }

  _createShapeDOM(shape) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-kite-shape', String(shape.id));
    g.setAttribute('data-kite-kind', shape.kind);
    g.style.pointerEvents = 'none';
    g.__kiteLayer = shape.common.layer;
    shape.el = g;
    let el = null;
    switch (shape.kind) {
      case 'circle':
      case 'ellipse':
      case 'rect':
      case 'line':
        el = document.createElementNS(SVG_NS, shape.kind);
        break;
      case 'image':
        el = document.createElementNS(SVG_NS, 'image');
        break;
      case 'text':
      case 'equation':
        el = document.createElementNS(SVG_NS, 'text');
        el.setAttribute('text-anchor', 'middle');
        el.setAttribute('dominant-baseline', 'central');
        break;
      case 'group':
        break;
      default:
        break;
    }
    if (el) {
      g.appendChild(el);
      shape.primitiveEl = el;
    }
    if (shape.kind === 'line' && shape.arrowEnd) {
      const arrow = document.createElementNS(SVG_NS, 'polygon');
      g.appendChild(arrow);
      shape.arrowEl = arrow;
    }
    if (!shape.parent) this._insertByLayer(g, shape.common.layer);
  }

  _setNum(el, key, value) {
    if (!Number.isFinite(value)) return;
    const attrs = el.__kiteAttrs || (el.__kiteAttrs = {});
    const prev = attrs[key];
    if (prev === undefined || Math.abs(prev - value) > 1e-2) {
      el.setAttribute(key, String(value));
      attrs[key] = value;
    }
  }

  _setStyleNum(el, key, value) {
    if (!Number.isFinite(value)) return;
    const attrs = el.__kiteAttrs || (el.__kiteAttrs = {});
    if (attrs[key] === undefined || Math.abs(attrs[key] - value) > 1e-3) {
      el.setAttribute(key, String(value));
      attrs[key] = value;
    }
  }

  _setStr(el, key, value) {
    const attrs = el.__kiteStrAttrs || (el.__kiteStrAttrs = {});
    if (value === null || value === undefined) {
      if (attrs[key] !== undefined) {
        el.removeAttribute(key);
        delete attrs[key];
      }
      return;
    }
    const v = String(value);
    if (attrs[key] !== v) {
      el.setAttribute(key, v);
      attrs[key] = v;
    }
  }

  _fontSizeOf(shape) {
    const fs = shape.fontSize;
    if (typeof fs === 'number') return fs;
    if (isSym(fs)) return this._val(fs);
    const n = parseFloat(fs);
    return Number.isFinite(n) ? n : 16;
  }

  _renderShape(shape) {
    const c = shape.common;
    const g = shape.el;
    const opacity = this._val(c.opacity);
    if (g.__kiteOpacity === undefined || Math.abs(g.__kiteOpacity - opacity) > 1e-3) {
      g.setAttribute('opacity', String(opacity));
      g.__kiteOpacity = opacity;
    }
    if (g.__kiteStyle !== c.style) {
      if (c.style) g.setAttribute('style', 'pointer-events:none;' + c.style);
      else g.setAttribute('style', 'pointer-events:none');
      g.__kiteStyle = c.style;
    }
    if (shape.kind === 'group') return;
    const el = shape.primitiveEl;
    if (!el) return;

    if (shape.kind !== 'image') {
      this._setStr(el, 'fill', shape.kind === 'line' ? 'none' : colorToCss(c.fill));
      this._setStr(el, 'stroke', colorToCss(c.stroke));
      this._setStyleNum(el, 'stroke-width', this._val(c.strokeWidth));
      this._setStr(el, 'stroke-linecap', c.strokeLinecap || (shape.kind === 'line' ? 'round' : null));
      this._setStr(el, 'stroke-dasharray', c.strokeDasharray);
    }

    switch (shape.kind) {
      case 'circle': {
        this._setNum(el, 'cx', this._val(shape.x));
        this._setNum(el, 'cy', -this._val(shape.y));
        this._setNum(el, 'r', Math.max(0, this._val(shape.r)));
        break;
      }
      case 'ellipse': {
        this._setNum(el, 'cx', this._val(shape.x));
        this._setNum(el, 'cy', -this._val(shape.y));
        this._setNum(el, 'rx', Math.max(0, this._val(shape.rx)));
        this._setNum(el, 'ry', Math.max(0, this._val(shape.ry)));
        break;
      }
      case 'rect': {
        const cx = this._val(shape.x);
        const cy = this._val(shape.y);
        const w = Math.max(0, this._val(shape.width));
        const h = Math.max(0, this._val(shape.height));
        this._setNum(el, 'x', cx - w / 2);
        this._setNum(el, 'y', -cy - h / 2);
        this._setNum(el, 'width', w);
        this._setNum(el, 'height', h);
        const rr = Math.max(0, this._val(shape.cornerRadius));
        this._setNum(el, 'rx', rr);
        this._setNum(el, 'ry', rr);
        break;
      }
      case 'image': {
        const cx = this._val(shape.x);
        const cy = this._val(shape.y);
        const w = Math.max(0, this._val(shape.width));
        const h = Math.max(0, this._val(shape.height));
        this._setNum(el, 'x', cx - w / 2);
        this._setNum(el, 'y', -cy - h / 2);
        this._setNum(el, 'width', w);
        this._setNum(el, 'height', h);
        this._setStr(el, 'href', shape.href);
        this._setStr(el, 'preserveAspectRatio', shape.preserveAspectRatio);
        break;
      }
      case 'line': {
        const x1 = this._val(shape.start[0]);
        const y1 = this._val(shape.start[1]);
        const x2 = this._val(shape.end[0]);
        const y2 = this._val(shape.end[1]);
        this._setNum(el, 'x1', x1);
        this._setNum(el, 'y1', -y1);
        this._setNum(el, 'x2', x2);
        this._setNum(el, 'y2', -y2);
        if (shape.arrowEl) {
          const dx = x2 - x1;
          const dy = y2 - y1;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const ux = dx / len;
          const uy = dy / len;
          const size = Math.max(6, this._val(c.strokeWidth) * 4);
          const bx = x2 - ux * size;
          const by = y2 - uy * size;
          const px = -uy * size * 0.5;
          const py = ux * size * 0.5;
          const points =
            x2 + ',' + -y2 + ' ' + (bx + px) + ',' + -(by + py) + ' ' + (bx - px) + ',' + -(by - py);
          this._setStr(shape.arrowEl, 'points', points);
          this._setStr(shape.arrowEl, 'fill', colorToCss(c.stroke));
        }
        break;
      }
      case 'text':
      case 'equation': {
        this._setNum(el, 'x', this._val(shape.x));
        this._setNum(el, 'y', -this._val(shape.y));
        const fsRaw = shape.fontSize;
        if (typeof fsRaw === 'string') this._setStr(el, 'font-size', fsRaw);
        else this._setStyleNum(el, 'font-size', this._fontSizeOf(shape));
        this._setStr(el, 'font-family', shape.fontFamily);
        this._setStr(el, 'font-weight', shape.fontWeight);
        if (shape.kind === 'equation') {
          this._setStr(el, 'font-style', null);
          if (shape._renderedString !== shape.string) {
            renderEquationInto(el, shape.string);
            shape._renderedString = shape.string;
          }
        } else if (shape._renderedString !== shape.string) {
          el.textContent = shape.string;
          shape._renderedString = shape.string;
        }
        break;
      }
      default:
        break;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Pointer interaction / manifold-projected dragging                       */
  /* ---------------------------------------------------------------------- */

  _attachPointerHandlers() {
    const svg = this._svg;
    const down = (e) => this._onPointerDown(e);
    const move = (e) => this._onPointerMove(e);
    const up = (e) => this._onPointerUp(e);
    svg.addEventListener('pointerdown', down);
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    this._pointerHandlers = { down, move, up };
  }

  _detachPointerHandlers() {
    if (!this._svg || !this._pointerHandlers) return;
    const { down, move, up } = this._pointerHandlers;
    this._svg.removeEventListener('pointerdown', down);
    this._svg.removeEventListener('pointermove', move);
    this._svg.removeEventListener('pointerup', up);
    this._svg.removeEventListener('pointercancel', up);
    this._pointerHandlers = null;
  }

  _worldFromEvent(e) {
    const svg = this._svg;
    try {
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const ctm = svg.getScreenCTM();
      if (ctm) {
        const p = pt.matrixTransform(ctm.inverse());
        return [p.x, -p.y];
      }
    } catch (_) {
      /* fall through */
    }
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * this.width - this.width / 2;
    const y = this.height / 2 - ((e.clientY - rect.top) / rect.height) * this.height;
    return [x, y];
  }

  _shapeGeometry(shape) {
    if (shape.kind === 'circle') {
      return {
        kind: 'circle',
        x: this._val(shape.x),
        y: this._val(shape.y),
        r: Math.abs(this._val(shape.r)),
      };
    }
    if (shape.kind === 'ellipse') {
      return {
        kind: 'ellipse',
        x: this._val(shape.x),
        y: this._val(shape.y),
        rx: Math.abs(this._val(shape.rx)),
        ry: Math.abs(this._val(shape.ry)),
      };
    }
    if (shape.kind === 'group') return { kind: 'none' };
    if (shape.kind === 'rect' || shape.kind === 'image') {
      return {
        kind: 'rect',
        x: this._val(shape.x),
        y: this._val(shape.y),
        w: Math.abs(this._val(shape.width)),
        h: Math.abs(this._val(shape.height)),
      };
    }
    if (shape.kind === 'text' || shape.kind === 'equation') {
      const fs = this._fontSizeOf(shape);
      return {
        kind: 'rect',
        x: this._val(shape.x),
        y: this._val(shape.y),
        w: Math.max(20, shape.string.length * fs * 0.62),
        h: fs * 1.4,
      };
    }
    return {
      kind: 'line',
      x1: this._val(shape.start[0]),
      y1: this._val(shape.start[1]),
      x2: this._val(shape.end[0]),
      y2: this._val(shape.end[1]),
    };
  }

  _hitTest(px, py, onlyDraggable) {
    const sorted = this.shapes.slice().sort((a, b) => (a.common.layer - b.common.layer) || (a.id - b.id));
    for (let i = sorted.length - 1; i >= 0; i--) {
      const shape = sorted[i];
      if (onlyDraggable && !shape.common.drag) continue;
      const g = this._shapeGeometry(shape);
      if (g.kind === 'circle') {
        const dx = px - g.x;
        const dy = py - g.y;
        if (dx * dx + dy * dy <= (g.r + 6) * (g.r + 6)) return shape;
      } else if (g.kind === 'ellipse') {
        const ex = (px - g.x) / (g.rx + 6 || 1);
        const ey = (py - g.y) / (g.ry + 6 || 1);
        if (ex * ex + ey * ey <= 1) return shape;
      } else if (g.kind === 'rect') {
        if (Math.abs(px - g.x) <= g.w / 2 + 3 && Math.abs(py - g.y) <= g.h / 2 + 3) return shape;
      } else if (g.kind === 'line') {
        const dx = g.x2 - g.x1;
        const dy = g.y2 - g.y1;
        const len2 = dx * dx + dy * dy || 1;
        let t = ((px - g.x1) * dx + (py - g.y1) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const qx = g.x1 + t * dx;
        const qy = g.y1 + t * dy;
        const d = Math.sqrt((px - qx) ** 2 + (py - qy) ** 2);
        if (d <= 9) return shape;
      }
    }
    return null;
  }

  _freeVar(v) {
    if (!isSym(v) || this.tape.opcode(v.nodeId) !== Op.VAR) return false;
    const idx = this._varIndex(v);
    return !!(this.vars[idx] && this.vars[idx].invMass > 0);
  }

  _dragTargetsFor(shape) {
    const pairs = [];
    if (shape.kind === 'line') {
      if (this._freeVar(shape.start[0]) && this._freeVar(shape.start[1])) {
        pairs.push([this._varIndex(shape.start[0]), this._varIndex(shape.start[1])]);
      }
      if (this._freeVar(shape.end[0]) && this._freeVar(shape.end[1])) {
        pairs.push([this._varIndex(shape.end[0]), this._varIndex(shape.end[1])]);
      }
    } else if (this._freeVar(shape.x) && this._freeVar(shape.y)) {
      pairs.push([this._varIndex(shape.x), this._varIndex(shape.y)]);
    }
    if (pairs.length === 0) return null;
    const mouse = this._lastPointerWorld || [0, 0];
    return pairs.map((pair) => ({
      varX: pair[0],
      varY: pair[1],
      offsetX: this.varValues[pair[0]] - mouse[0],
      offsetY: this.varValues[pair[1]] - mouse[1],
    }));
  }

  _onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const world = this._worldFromEvent(e);
    this._lastPointerWorld = world;
    const shape = this._hitTest(world[0], world[1], true);
    if (!shape || !shape.common.drag) return;
    const targets = this._dragTargetsFor(shape);
    if (!targets) return;
    e.preventDefault();
    this._dragActive = true;
    this._dragShape = shape;
    this._dragPointerId = e.pointerId;
    try {
      this._svg.setPointerCapture(e.pointerId);
    } catch (_) {
      /* noop */
    }
    this._svg.style.cursor = 'grabbing';
    if (this._worker) {
      this._worker.postMessage({
        type: 'DRAG_START',
        varX: targets[0].varX,
        varY: targets[0].varY,
        mouseX: world[0],
        mouseY: world[1],
        targets: targets,
      });
    }
    this._wake();
  }

  _onPointerMove(e) {
    const world = this._worldFromEvent(e);
    this._lastPointerWorld = world;
    if (!this._dragActive) {
      if (this._svg) {
        const shape = this._hitTest(world[0], world[1], true);
        this._svg.style.cursor = shape ? 'grab' : 'default';
      }
      return;
    }
    e.preventDefault();
    if (this._worker) {
      this._worker.postMessage({ type: 'DRAG_MOVE', mouseX: world[0], mouseY: world[1] });
    }
    this._wake();
  }

  _onPointerUp(e) {
    if (!this._dragActive) return;
    this._dragActive = false;
    this._dragShape = null;
    if (this._dragPointerId != null) {
      try {
        this._svg.releasePointerCapture(this._dragPointerId);
      } catch (_) {
        /* noop */
      }
    }
    this._dragPointerId = null;
    if (this._svg) this._svg.style.cursor = 'default';
    if (this._worker) this._worker.postMessage({ type: 'DRAG_END' });
    this._wake();
  }
}

/* ========================================================================== *
 * Public helpers: $, ensure, encourage, ops
 * ========================================================================== */

export function $(strings, ...values) {
  const scene = assertScene();
  if (!isTemplate(strings)) {
    throw new TypeError('[kite] $ must be used as a tagged template');
  }
  return scene._activate(), makeSym(emitTemplate(strings, values, scene).node, scene);
}

export function ensure(strings, ...values) {
  const scene = assertScene();
  if (isTemplate(strings)) {
    scene.ensureTemplate(strings, values);
    return;
  }
  if (isSym(strings)) {
    if (strings.__kiteScene && strings.__kiteScene !== scene) {
      throw new Error('[kite] ensure() expression belongs to a different scene');
    }
    scene.addConstraint(
      strings.nodeId,
      strings.__kiteRel ? ConstraintKind.INEQUALITY : ConstraintKind.EQUALITY,
      0,
      strings.__kitePair || null,
    );
    return;
  }
  throw new TypeError('[kite] ensure must be used as a tagged template or receive a SymExpr');
}

export function encourage(strings, ...values) {
  const scene = assertScene();
  if (isTemplate(strings)) {
    scene.encourageTemplate(strings, values);
    return;
  }
  if (isSym(strings)) {
    if (strings.__kiteScene && strings.__kiteScene !== scene) {
      throw new Error('[kite] encourage() expression belongs to a different scene');
    }
    scene.addConstraint(
      strings.nodeId,
      strings.__kiteRel ? ConstraintKind.INEQUALITY : ConstraintKind.EQUALITY,
      1e-2,
      strings.__kitePair || null,
    );
    return;
  }
  throw new TypeError('[kite] encourage must be used as a tagged template or receive a SymExpr');
}

function relSym(scene, node, rel) {
  return makeSym(node, scene, rel);
}

function attachPair(scene, sym, a, b, pad) {
  Object.defineProperty(sym, '__kitePair', {
    value: { a: a, b: b, pad: pad },
    enumerable: false,
  });
  return sym;
}

export const ops = Object.freeze({
  dist(p, q) {
    const scene = assertScene();
    const dx = scene.tape.emit(Op.SUB, valueToNode(p[0], scene), valueToNode(q[0], scene), 0);
    const dy = scene.tape.emit(Op.SUB, valueToNode(p[1], scene), valueToNode(q[1], scene), 0);
    const x2 = scene.tape.emit(Op.POW2, dx, -1, 0);
    const y2 = scene.tape.emit(Op.POW2, dy, -1, 0);
    const sum = scene.tape.emit(Op.ADD, x2, y2, 0);
    return makeSym(scene.tape.emit(Op.SQRT, sum, -1, 0), scene);
  },

  norm(v) {
    const scene = assertScene();
    const x2 = scene.tape.emit(Op.POW2, valueToNode(v[0], scene), -1, 0);
    const y2 = scene.tape.emit(Op.POW2, valueToNode(v[1], scene), -1, 0);
    const sum = scene.tape.emit(Op.ADD, x2, y2, 0);
    return makeSym(scene.tape.emit(Op.SQRT, sum, -1, 0), scene);
  },

  dot(u, v) {
    const scene = assertScene();
    const ux = valueToNode(u[0], scene);
    const uy = valueToNode(u[1], scene);
    const vx = valueToNode(v[0], scene);
    const vy = valueToNode(v[1], scene);
    const a = scene.tape.emit(Op.MUL, ux, vx, 0);
    const b = scene.tape.emit(Op.MUL, uy, vy, 0);
    return makeSym(scene.tape.emit(Op.ADD, a, b, 0), scene);
  },

  vadd(u, v) {
    const scene = assertScene();
    return [
      makeSym(scene.tape.emit(Op.ADD, valueToNode(u[0], scene), valueToNode(v[0], scene), 0), scene),
      makeSym(scene.tape.emit(Op.ADD, valueToNode(u[1], scene), valueToNode(v[1], scene), 0), scene),
    ];
  },

  vsub(u, v) {
    const scene = assertScene();
    return [
      makeSym(scene.tape.emit(Op.SUB, valueToNode(u[0], scene), valueToNode(v[0], scene), 0), scene),
      makeSym(scene.tape.emit(Op.SUB, valueToNode(u[1], scene), valueToNode(v[1], scene), 0), scene),
    ];
  },

  vmul(s, v) {
    const scene = assertScene();
    const sn = valueToNode(s, scene);
    return [
      makeSym(scene.tape.emit(Op.MUL, sn, valueToNode(v[0], scene), 0), scene),
      makeSym(scene.tape.emit(Op.MUL, sn, valueToNode(v[1], scene), 0), scene),
    ];
  },

  vnormalize(v) {
    const scene = assertScene();
    const n = ops.norm(v);
    return [
      makeSym(scene.tape.emit(Op.DIV, valueToNode(v[0], scene), n.nodeId, 0), scene),
      makeSym(scene.tape.emit(Op.DIV, valueToNode(v[1], scene), n.nodeId, 0), scene),
    ];
  },

  /** Squared Euclidean norm |v|². Smooth everywhere (no sqrt). */
  normsq(v) {
    const scene = assertScene();
    const x2 = scene.tape.emit(Op.POW2, valueToNode(v[0], scene), -1, 0);
    const y2 = scene.tape.emit(Op.POW2, valueToNode(v[1], scene), -1, 0);
    return makeSym(scene.tape.emit(Op.ADD, x2, y2, 0), scene);
  },

  /** Squared distance |p - q|². */
  distsq(p, q) {
    return ops.normsq(ops.vsub(p, q));
  },

  /** 2D cross product u × v (z-component). */
  cross(u, v) {
    const scene = assertScene();
    const a = scene.tape.emit(Op.MUL, valueToNode(u[0], scene), valueToNode(v[1], scene), 0);
    const b = scene.tape.emit(Op.MUL, valueToNode(u[1], scene), valueToNode(v[0], scene), 0);
    return makeSym(scene.tape.emit(Op.SUB, a, b, 0), scene);
  },

  /** Rotate v by +90°: (-v.y, v.x). */
  rot90(v) {
    const scene = assertScene();
    return [makeSym(scene.tape.emit(Op.NEG, valueToNode(v[1], scene), -1, 0), scene), v[0]];
  },

  /**
   * Unsigned angle between u and v in [0, π], computed as
   * atan2(|u × v|, u · v).  Unlike acos(u·v / |u||v|) it stays well
   * conditioned near 0 and π and needs no normalization.
   */
  angleBetween(u, v) {
    const scene = assertScene();
    const cr = ops.cross(u, v);
    const absCr = scene.tape.emit(Op.ABS, cr.nodeId, -1, 0);
    const dt = ops.dot(u, v);
    return makeSym(scene.tape.emit(Op.ATAN2, absCr, dt.nodeId, 0), scene);
  },

  /** Signed angle from u to v in (-π, π]. */
  angleFrom(u, v) {
    const scene = assertScene();
    const cr = ops.cross(u, v);
    const dt = ops.dot(u, v);
    return makeSym(scene.tape.emit(Op.ATAN2, cr.nodeId, dt.nodeId, 0), scene);
  },

  /** atan2(y, x) as a differentiable expression. */
  atan2(y, x) {
    const scene = assertScene();
    return makeSym(scene.tape.emit(Op.ATAN2, valueToNode(y, scene), valueToNode(x, scene), 0), scene);
  },

  /** Degrees → radians. Plain numbers fold to a number. */
  toRadians(deg) {
    if (typeof deg === 'number') return (deg * Math.PI) / 180;
    const scene = assertScene();
    return makeSym(scene.tape.emit(Op.MUL, valueToNode(deg, scene), scene.tape.emitConst(Math.PI / 180), 0), scene);
  },

  /** Radians → degrees. Plain numbers fold to a number. */
  toDegrees(rad) {
    if (typeof rad === 'number') return (rad * 180) / Math.PI;
    const scene = assertScene();
    return makeSym(scene.tape.emit(Op.MUL, valueToNode(rad, scene), scene.tape.emitConst(180 / Math.PI), 0), scene);
  },

  /** Penrose-style equal(a, b): returns a - b for use with ensure/encourage. */
  equal(a, b) {
    const scene = assertScene();
    return makeSym(scene.tape.emit(Op.SUB, valueToNode(a, scene), valueToNode(b, scene), 0), scene);
  },

  contains(outerCircle, innerCircle, padding) {
    const scene = assertScene();
    const pad = padding === undefined ? 0 : padding;
    const d = ops.dist(outerCircle.center, innerCircle.center);
    const node = scene.tape.emit(
      Op.SUB,
      scene.tape.emit(
        Op.ADD,
        scene.tape.emit(Op.ADD, d.nodeId, valueToNode(innerCircle.r, scene), 0),
        valueToNode(pad, scene),
        0,
      ),
      valueToNode(outerCircle.r, scene),
      0,
    );
    return relSym(scene, node, '<=');
  },

  disjoint(c1, c2, padding) {
    const scene = assertScene();
    const pad = padding === undefined ? 0 : padding;
    const d = ops.dist(c1.center, c2.center);
    const node = scene.tape.emit(
      Op.SUB,
      scene.tape.emit(
        Op.ADD,
        scene.tape.emit(Op.ADD, valueToNode(c1.r, scene), valueToNode(c2.r, scene), 0),
        valueToNode(pad, scene),
        0,
      ),
      d.nodeId,
      0,
    );
    return attachPair(scene, relSym(scene, node, '<='), c1, c2, pad);
  },

  overlapping(c1, c2, overlap) {
    const scene = assertScene();
    const ov = overlap === undefined ? 0 : overlap;
    const d = ops.dist(c1.center, c2.center);
    const node = scene.tape.emit(
      Op.SUB,
      scene.tape.emit(Op.ADD, valueToNode(ov, scene), d.nodeId, 0),
      scene.tape.emit(Op.ADD, valueToNode(c1.r, scene), valueToNode(c2.r, scene), 0),
      0,
    );
    return relSym(scene, node, '<=');
  },
});

/* ========================================================================== *
 * Module 5 — <kite-diagram> & Public Exports
 * ========================================================================== */

function parseDslTokens(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let out = '';
      while (j < line.length && line[j] !== quote) {
        if (line[j] === '\\' && j + 1 < line.length) {
          out += line[j + 1];
          j += 2;
        } else {
          out += line[j];
          j++;
        }
      }
      tokens.push(out);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] !== ' ' && line[j] !== '\t') j++;
    tokens.push(line.slice(i, j));
    i = j;
  }
  return tokens;
}

function parseDslProps(tokens) {
  const props = {};
  for (const t of tokens) {
    if (t === 'drag' || t === 'arrow' || t === 'arrowEnd') {
      props[t === 'drag' ? 'drag' : 'arrowEnd'] = true;
      continue;
    }
    const eq = t.indexOf('=');
    if (eq > 0) {
      const k = t.slice(0, eq);
      let v = t.slice(eq + 1);
      const n = Number(v);
      props[k] = v !== '' && Number.isFinite(n) ? n : v;
    }
  }
  return props;
}

function interpretDsl(text, kite) {
  const lines = String(text).split(/\r?\n/);
  for (let raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const comment = line.indexOf(' // ');
    if (comment >= 0) line = line.slice(0, comment).trim();
    const t = parseDslTokens(line);
    if (!t.length) continue;
    const cmd = t[0];
    const nums = t.slice(1).filter((x) => x !== '' && Number.isFinite(Number(x))).map(Number);
    const nonNums = t.slice(1).filter((x) => x === '' || !Number.isFinite(Number(x)));
    const propTokens = t.slice(1).filter((x) => x.includes('=') || x === 'drag' || x === 'arrow' || x === 'arrowEnd');
    const props = parseDslProps(propTokens);
    try {
      if (cmd === 'canvas') {
        continue;
      }
      if (cmd === 'circle') {
        const cx = nums[0] || 0;
        const cy = nums[1] || 0;
        const r = nums[2] === undefined ? 40 : nums[2];
        kite.circle(Object.assign({ center: [cx, cy], r: r }, props));
      } else if (cmd === 'rect') {
        const cx = nums[0] || 0;
        const cy = nums[1] || 0;
        const w = nums[2] === undefined ? 120 : nums[2];
        const h = nums[3] === undefined ? 80 : nums[3];
        kite.rect(Object.assign({ center: [cx, cy], width: w, height: h }, props));
      } else if (cmd === 'line') {
        kite.line(
          Object.assign(
            {
              start: [nums[0] || 0, nums[1] || 0],
              end: [nums[2] || 0, nums[3] || 0],
            },
            props,
          ),
        );
      } else if (cmd === 'text') {
        const str = nonNums.find((x) => !x.includes('=') && x !== 'drag' && x !== 'arrow' && x !== 'arrowEnd') || '';
        const cx = nums[0] || 0;
        const cy = nums[1] || 0;
        kite.text(Object.assign({ center: [cx, cy], string: str }, props));
      } else if (cmd === 'orbit') {
        const cx = nums[0] || 0;
        const cy = nums[1] || 0;
        const R = nums[2] === undefined ? 150 : nums[2];
        const pr = nums[3] === undefined ? 18 : nums[3];
        const orbit = kite.circle({ center: [cx, cy], r: R, fill: 'none', stroke: '#94a3b8', strokeWidth: 2 });
        const planet = kite.circle({
          center: [cx + R, cy],
          r: pr,
          fill: '#2563eb',
          stroke: '#1e3a8a',
          drag: true,
        });
        ensure`${ops.dist(planet.center, orbit.center)} == ${R}`;
      } else if (cmd === 'link') {
        const d = $`${ops.dist([nums[0] || 0, nums[1] || 0], [nums[2] || 0, nums[3] || 0])}`;
        ensure`${d} == ${nums[4] === undefined ? 100 : nums[4]}`;
      } else {
        console.warn('[kite] unknown kite-diagram command:', cmd);
      }
    } catch (err) {
      console.error('[kite] failed to interpret line "' + line + '"', err);
    }
  }
}

function dslCanvasSize(text) {
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('canvas')) continue;
    const t = parseDslTokens(line);
    const w = Number(t[1]);
    const h = Number(t[2]);
    if (Number.isFinite(w) && Number.isFinite(h)) return [w, h];
  }
  return null;
}

const KITE_ELEMENT_STYLE = 'kite-diagram{display:block;position:relative;min-height:120px}';
const HTMLElementBase = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

class KiteDiagramElement extends HTMLElementBase {
  constructor() {
    super();
    this._kite = null;
    this._mounting = false;
  }

  connectedCallback() {
    if (this._kite || this._mounting) return;
    this._mounting = true;
    const text = this._source || this.textContent || '';
    this._source = text;
    // The DSL is source text, not content.  Remove it before mounting the SVG.
    this.textContent = '';
    const size = dslCanvasSize(text);
    const width = size ? size[0] : Number(this.getAttribute('width')) || DEFAULTS.width;
    const height = size ? size[1] : Number(this.getAttribute('height')) || DEFAULTS.height;
    const k = scene(this, { width: width, height: height, seed: Number(this.getAttribute('seed')) || DEFAULTS.seed });
    this._kite = k;
    try {
      interpretDsl(text, k);
    } catch (err) {
      console.error('[kite] kite-diagram parse error', err);
    }
    k.mount().catch((err) => console.error('[kite] kite-diagram mount error', err));
  }

  disconnectedCallback() {
    if (this._kite) {
      this._kite.destroy();
      this._kite = null;
    }
    this._mounting = false;
  }
}

let _elementRegistered = false;
function registerKiteElement() {
  if (_elementRegistered) return;
  if (typeof customElements === 'undefined' || typeof document === 'undefined') return;
  _elementRegistered = true;
  try {
    if (!customElements.get('kite-diagram')) customElements.define('kite-diagram', KiteDiagramElement);
  } catch (err) {
    console.error('[kite] custom element registration failed', err);
  }
}

if (typeof document !== 'undefined') {
  try {
    if (!document.getElementById('kite-diagram-style')) {
      const st = document.createElement('style');
      st.id = 'kite-diagram-style';
      st.textContent = KITE_ELEMENT_STYLE;
      (document.head || document.documentElement).appendChild(st);
    }
  } catch (_) {
    /* noop */
  }
  registerKiteElement();
}

export function scene(container, options) {
  const s = new KiteSceneImpl(container, options);
  ACTIVE_SCENE = s;
  if (container != null && typeof document !== 'undefined') {
    queueMicrotask(() => {
      if (!s._destroyed) {
        s.mount().catch((err) => console.error('[kite] auto-mount failed', err));
      }
    });
  }
  return s;
}

const Kite = {
  scene: scene,
  $: $,
  ensure: ensure,
  encourage: encourage,
  ops: ops,
  rgba: rgba,
  none: none,
  Op: Op,
  ConstraintKind: ConstraintKind,
  KiteDiagramElement: KiteDiagramElement,
};

export { KiteDiagramElement };
export default Kite;
