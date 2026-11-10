import assert from 'node:assert/strict';
import { scene, $, ensure, encourage, ops, Op, ConstraintKind, rgba, none } from '../kite.js';

let count = 0;
function test(name, fn) {
  try {
    fn();
    count++;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name);
    throw err;
  }
}
function value(s, sym) {
  s._computeNodes(true);
  return s._valueOfNode(sym.nodeId);
}

console.log('Kite unit tests');

test('Pratt parser precedence, power and functions', () => {
  const s = scene();
  const a = s.input({ init: 2 });
  const b = s.input({ init: 3 });
  assert.equal(value(s, $`${a} + ${b} * 2`), 8);
  assert.equal(value(s, $`(${a} + ${b}) * 2`), 10);
  assert.equal(value(s, $`-${a} ^ 2`), -4);
  assert.equal(value(s, $`${a} ^ 3`), 8);
  assert.ok(Math.abs(value(s, $`${a} ^ -2`) - 0.25) < 1e-9);
  assert.ok(Math.abs(value(s, $`sqrt(${a}) ^ 2`) - 2) < 1e-9);
  assert.ok(Math.abs(value(s, $`sin(pi / 2) + cos(0) + max(1, 2)` ) - 4) < 1e-12);
});

test('Tagged-template WeakMap cache reuses AST across calls', () => {
  const s = scene();
  const a = s.input({ init: 4 });
  const b = s.input({ init: 5 });
  const plus = (x, y) => $`${x} + ${y}`;
  const p1 = plus(a, b);
  const n0 = s.tape.nodeCount;
  const p2 = plus(b, a);
  assert.equal(value(s, p1), 9);
  assert.equal(value(s, p2), 9);
  // Only the constant-free ADD node is appended for the second binding.
  assert.equal(s.tape.nodeCount - n0, 1);
});

test('Comparison canonicalization and constraint kinds', () => {
  const s = scene();
  const a = s.input({ init: 1 });
  const b = s.input({ init: 4 });
  ensure`${a} <= ${b}`;
  ensure`${b} >= ${a}`;
  ensure`${a} == ${b}`;
  encourage`${a} >= ${b}`;
  assert.deepEqual(
    s.constraints.map((c) => c.kind),
    [ConstraintKind.INEQUALITY, ConstraintKind.INEQUALITY, ConstraintKind.EQUALITY, ConstraintKind.INEQUALITY],
  );
  assert.equal(value(s, { nodeId: s.constraints[0].rootNodeId }), -3);
  assert.equal(value(s, { nodeId: s.constraints[1].rootNodeId }), -3);
  assert.equal(value(s, { nodeId: s.constraints[2].rootNodeId }), -3);
  assert.equal(s.constraints[3].compliance, 1e-2);
  assert.deepEqual(Array.from(s.constraints[0].depVars), [0, 1]);
});

test('Raw ops.contains carries inequality metadata into ensure()', () => {
  const s = scene();
  const outer = { center: [s.input({ init: 0 }), s.input({ init: 0 })], r: s.input({ init: 100, optimized: false }) };
  const inner = { center: [s.input({ init: 50 }), s.input({ init: 0 })], r: s.input({ init: 30, optimized: false }) };
  ensure(ops.contains(outer, inner, 5));
  assert.equal(s.constraints.length, 1);
  assert.equal(s.constraints[0].kind, ConstraintKind.INEQUALITY);
  assert.equal(value(s, { nodeId: s.constraints[0].rootNodeId }), -15);

  // disjoint() carries a broad-phase body pair for the solver's spatial hash.
  ensure(ops.disjoint(outer, inner, 5));
  const pairConstraint = s.constraints[1];
  assert.deepEqual(pairConstraint.pair, { ax: 0, ay: 1, bx: 3, by: 4, margin: 5 });
  assert.equal(value(s, { nodeId: pairConstraint.rootNodeId }), 85);
});

test('Auto-slacking turns a derived draggable coordinate into a free var + hard equality', () => {
  const s = scene();
  const c1 = s.circle({ center: [0, 0], r: 30, drag: true });
  const varsBefore = s.varCount;
  const consBefore = s.constraints.length;
  const c2 = s.circle({
    center: [$`${c1.center[0]} + 80`, c1.center[1]],
    r: 30,
    drag: true,
  });
  assert.equal(s.tape.opcode(c2.center[0].nodeId), Op.VAR);
  assert.equal(s.vars[s._varIndex(c2.center[0])].invMass, 1);
  assert.equal(c2.center[1].nodeId, c1.center[1].nodeId);
  assert.equal(s.varCount, varsBefore + 1);
  assert.equal(s.constraints.length, consBefore + 1);
  assert.equal(s.constraints[consBefore].kind, ConstraintKind.EQUALITY);
  assert.equal(value(s, c2.center[0]) - value(s, c1.center[0]), 80);
});

test('Bitmask subtyping and injective incremental matching', () => {
  const s = scene();
  const Base = s.type('Base');
  const Mid = s.type('Mid', Base);
  const Named = s.type('Named');
  const Thing = s.type('Thing', Mid, Named);
  const t = Thing({});
  const m = Mid({});
  assert.equal((t.typeMask & Base.bitmask) === Base.bitmask, true);
  assert.equal((t.typeMask & Named.bitmask) === Named.bitmask, true);
  assert.equal((m.typeMask & Named.bitmask) === Named.bitmask, false);

  let matches = 0;
  let elementMatches = 0;
  s.forall({ x: Base }, () => {
    matches++;
  });
  s.forall({ x: Named }, () => {
    elementMatches++;
  });
  let pairs = 0;
  s.forall({ a: Base, b: Base }, () => {
    pairs++;
  });
  s.step();
  assert.equal(matches, 2);
  assert.equal(elementMatches, 1);
  assert.equal(pairs, 2); // injective: (t,m) and (m,t), never (t,t)

  const third = Mid({});
  s.step();
  assert.equal(matches, 3);
  assert.equal(pairs, 6); // all 3*2 ordered pairs
  assert.ok(third.id > 0);
});

test('Substance predicates and forallWhere guards', () => {
  const s = scene();
  const SetT = s.type('Set');
  const Subset = s.predicate('Subset', [SetT, SetT]);
  const A = SetT({ label: 'A' });
  const B = SetT({ label: 'B' });
  const C = SetT({ label: 'C' });
  Subset(B, A);
  Subset(C, A);
  let pairs = 0;
  s.forallWhere({ a: SetT, b: SetT }, ({ a, b }) => Subset.test(a, b), () => {
    pairs++;
  });
  s.step();
  assert.equal(pairs, 2);
  assert.equal(Subset.test(A, B), false);
  assert.equal(Subset.test(B, A), true);
});

test('Named inputs, setInput, getInput and subscribe', () => {
  const s = scene();
  const v = s.input({ name: 'speed', init: 5 });
  assert.equal(s.getInput('speed'), 5);
  const seen = [];
  const off = s.subscribe('speed', (x) => seen.push(x));
  s.setInput('speed', 9);
  assert.equal(s.getInput('speed'), 9);
  assert.deepEqual(seen, [9]);
  off();
  s.setInput('speed', 11);
  assert.deepEqual(seen, [9]);
  assert.equal(value(s, v), 11);
});

test('Shape factories: line, rect, text, defaults and shape ids', () => {
  const s = scene();
  const c = s.circle({ center: [10, 20], r: 5 });
  const l = s.line({ start: [-10, 0], end: [10, 0], arrowEnd: true, drag: true });
  const r = s.rect({ center: [0, 0], width: 40, height: 20 });
  const t = s.text({ center: [0, 0], string: 'A', fontSize: 18 });
  assert.equal(typeof c.shapeId, 'number');
  assert.ok(l.shapeId !== c.shapeId && r.shapeId !== l.shapeId && t.shapeId !== r.shapeId);
  assert.equal(l.arrowEnd, true);
  assert.equal(s.shapes.length, 4);
  assert.equal(s.tape.opcode(l.start[0].nodeId), Op.VAR);
  assert.equal(s.vars[s._varIndex(l.start[0])].invMass, 1);
});

test('ops residuals are signed correctly', () => {
  const s = scene();
  const p = (x, y) => [s.input({ init: x, optimized: false }), s.input({ init: y, optimized: false })];
  const r = (v) => s.input({ init: v, optimized: false });
  const A = { center: p(0, 0), r: r(100) };
  const B = { center: p(50, 0), r: r(30) };
  assert.equal(value(s, ops.dist(A.center, B.center)), 50);
  assert.equal(value(s, ops.contains(A, B, 5)), -15);
  assert.equal(value(s, ops.disjoint(A, B, 5)), 85);
  assert.equal(value(s, ops.overlapping(A, B, 10)), -70);
  assert.equal(value(s, ops.dot([1, 2], [3, 4])), 11);
  assert.ok(Math.abs(value(s, ops.overlapping(A, B, 10)) + 70) < 1e-9);
});

test('Dynamic exponent is rejected with a useful error', () => {
  const s = scene();
  const a = s.input({ init: 2 });
  const b = s.input({ init: 3 });
  assert.throws(() => $`${a} ^ ${b}`, /exponent must be a numeric literal/);
});

test('rgba() / none() produce CSS colors and validate input', () => {
  const s = scene();
  const c = s.circle({ fill: rgba(1, 0.4, 0.4, 1), stroke: none() });
  const sh = c.__kiteShape;
  assert.equal(sh.common.fill.r, 1);
  assert.equal(sh.common.stroke.none, true);
  assert.throws(() => s.circle({ fill: 42 }), /color must be/);
  assert.deepEqual([rgba(2, -1, 0.5).r, rgba(2, -1, 0.5).g], [1, 0]);
});

test('Ellipse, Image, Equation and Group shapes are created', () => {
  const s = scene();
  const e = s.ellipse({ center: [0, 0], rx: 50, ry: 25, fillColor: rgba(0, 0, 0, 1) });
  const im = s.image({ href: 'data:image/svg+xml,<svg/>', center: [0, 0], width: 40, height: 20 });
  const eq = s.equation({ center: [0, 0], string: 'H_2O' });
  const g = s.group({ shapes: [e, im], opacity: 0.1, style: 'filter:blur(5px);' });
  assert.equal(e.rx, 50);
  assert.equal(im.href.startsWith('data:'), true);
  assert.equal(eq.string, 'H_2O');
  assert.equal(e.__kiteShape.parent, g.__kiteShape);
  assert.equal(g.__kiteShape.members.length, 2);
  assert.equal(g.__kiteShape.common.style, 'filter:blur(5px);');
  assert.throws(() => s.group({ shapes: [e] }), /already belongs/);
  assert.throws(() => s.image({}), /href is required/);
});

test('override() replaces style and geometry; later rules win', () => {
  const s = scene();
  const Atom = s.type('Atom');
  const H = s.type('Hydrogen', Atom);
  const icons = new Map();
  H({});
  s.forall({ a: Atom }, ({ a }) => {
    icons.set(a.id, s.circle({ r: 25, fill: 'white' }));
  });
  s.forall({ a: H }, ({ a }) => {
    s.override(icons.get(a.id), { fillColor: rgba(0.8, 0.8, 0.8), r: 0.75 * 25 });
  });
  s.step();
  const sh = [...icons.values()][0].__kiteShape;
  assert.equal(sh.r, 18.75);
  assert.equal(sh.common.fill.r, 0.8);
  assert.throws(() => s.override([...icons.values()][0], { bogus: 1 }), /unsupported property/);
  assert.throws(() => s.override([...icons.values()][0], { rx: 1 }), /no "rx"/);
});

test('collect() gathers all matches once and re-runs when the set grows', () => {
  const s = scene();
  const Node = s.type('Node');
  const shadows = new Map();
  Node({});
  Node({});
  s.forall({ n: Node }, ({ n }) => {
    shadows.set(n.id, s.ellipse({ rx: 10, ry: 5 }));
  });
  const runs = [];
  s.collect(Node, (n) => shadows.get(n.id), (list) => {
    runs.push(list.length);
    s.group({ shapes: list, opacity: 0.1 });
  });
  s.step();
  assert.deepEqual(runs, [2]);
  s.step();
  assert.deepEqual(runs, [2]); // unchanged set: no re-run
  Node({});
  s.step();
  assert.deepEqual(runs, [2, 3]);
  const groups = s.shapes.filter((x) => x.kind === 'group');
  assert.equal(groups.length, 1, 'old group was replaced');
  assert.equal(groups[0].members.length, 3);
});

test('normsq, angleBetween, toRadians and atan2 are differentiable expressions', () => {
  const s = scene();
  const a = [s.input({ init: 0 }), s.input({ init: 0 })];
  const b = [s.input({ init: 1 }), s.input({ init: 0 })];
  const c = [s.input({ init: 0 }), s.input({ init: 2 })];
  const u = ops.vsub(b, a);
  const v = ops.vsub(c, a);
  assert.equal(value(s, ops.normsq(v)), 4);
  assert.ok(Math.abs(value(s, ops.angleBetween(u, v)) - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(value(s, ops.angleFrom(v, u)) + Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(ops.toRadians(104.5) - (104.5 * Math.PI) / 180) < 1e-15);
  assert.ok(Math.abs(value(s, $`toRadians(180)`) - Math.PI) < 1e-12);
  assert.ok(Math.abs(value(s, $`atan2(1, 1)`) - Math.PI / 4) < 1e-12);
  assert.equal(value(s, ops.equal(ops.normsq(v), 4)), 0);
  assert.equal(s.tape.opcode(ops.atan2(1, 1).nodeId), Op.ATAN2);
});

console.log(`\n${count} unit tests passed`);
