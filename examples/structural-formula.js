// Kite port of Penrose's structural-formula Domain / Style / Substance trio.
// https://github.com/penrose/penrose/tree/main/packages/examples/src/structural-formula
//
// The Style program is translated rule by rule; each block below names the
// Penrose rule it comes from.  Atom positions are free variables solved by
// the XPBD engine from the same `encourage` objectives Penrose uses.

import { scene, $, encourage, ops, rgba, none } from '../kite.js';

const SVG_BG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none">' +
      '<defs><radialGradient id="g" cx="50%" cy="38%" r="75%">' +
      '<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e8edf5"/>' +
      '</radialGradient></defs><rect width="100" height="100" fill="url(#g)"/></svg>',
  );

const SVG_SHADING =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<defs><radialGradient id="s" cx="36%" cy="30%" r="70%">' +
      '<stop offset="0" stop-color="#fff" stop-opacity=".85"/>' +
      '<stop offset=".45" stop-color="#fff" stop-opacity=".12"/>' +
      '<stop offset="1" stop-color="#000" stop-opacity=".22"/>' +
      '</radialGradient></defs><circle cx="50" cy="50" r="50" fill="url(#s)"/></svg>',
  );

export function mountStructuralFormula(el, options = {}) {
  const s = scene(el, { width: 800, height: 800, seed: options.seed ?? 7 });

  /* -------------------------------------------------------------------- */
  /* structural-formula.domain                                             */
  /* -------------------------------------------------------------------- */

  const Node = s.type('Node');
  const FunctionalGroup = s.type('FunctionalGroup', Node);
  const Atom = s.type('Atom', Node);
  const Hydrogen = s.type('Hydrogen', Atom);
  const Carbon = s.type('Carbon', Atom);
  const Nitrogen = s.type('Nitrogen', Atom);
  const Oxygen = s.type('Oxygen', Atom);
  const Sodium = s.type('Sodium', Atom);
  const Chlorine = s.type('Chlorine', Atom);

  const SingleBond = s.predicate('SingleBond', [Node, Node]);
  const DoubleBond = s.predicate('DoubleBond', [Node, Node]);
  const IonicBond = s.predicate('IonicBond', [Node, Node]);

  const Molecule = s.type('Molecule');
  const Contains = s.predicate('Contains', [Molecule, Node]);
  const Title = s.type('Title');

  /* -------------------------------------------------------------------- */
  /* style: Colors, Global                                                 */
  /* -------------------------------------------------------------------- */

  const a = 0.4;
  const Colors = {
    clear: rgba(0, 0, 0, 0),
    black: rgba(0, 0, 0, 1),
    clearblack: rgba(a, a, a, 1),
    gray: rgba(0.5, 0.5, 0.5, 1),
    cleargray: rgba(0.8, 0.8, 0.8, 1),
    lightGray: rgba(0.9, 0.9, 0.9, 1),
    white: rgba(1, 1, 1, 1),
    red: rgba(1, 0, 0, 1),
    clearred: rgba(1, a, a, 1),
    green: rgba(0, 0.7, 0, 1),
    cleargreen: rgba(a, 0.7, a, 1),
    blue: rgba(0, 0, 1, 1),
    clearblue: rgba(a, a, 1, 1),
    purple: rgba(0.66, 0.36, 0.95, 1),
    clearpurple: rgba(0.86, 0.56, 1, 1),
    turquoise: rgba(0.1, 0.7, 0.6, 1),
  };
  const Global = { atomRadius: 25, bondLength: 60 };

  // Layer numbers stand in for Penrose's `layer x above y` partial order:
  // background < shadows < bonds < atom icon < shading < labels < title.
  const L = { background: -10, shadow: 0, box: 1, bond: 2, bondInner: 3, icon: 4, shading: 5, label: 6, title: 7 };

  /* -------------------------------------------------------------------- */
  /* global { shape background = Image {...} }                             */
  /* -------------------------------------------------------------------- */

  s.image({
    href: SVG_BG,
    center: [0, 0],
    width: 800,
    height: 800,
    preserveAspectRatio: 'none',
    layer: L.background,
  });

  /* -------------------------------------------------------------------- */
  /* forall Node n { icon, shading, shadow }                               */
  /* -------------------------------------------------------------------- */

  const N = new Map(); // instance id -> { cx, cy, icon, shading, shadow, labelText }

  s.forall({ n: Node }, ({ n }) => {
    const cx = s.input({ init: n.x0 });
    const cy = s.input({ init: n.y0 });
    const R = Global.atomRadius;
    const icon = s.circle({
      r: R,
      center: [cx, cy],
      fillColor: Colors.white,
      strokeColor: Colors.black,
      strokeWidth: 3,
      layer: L.icon,
    });
    const shading = s.image({
      href: SVG_SHADING,
      center: [cx, cy],
      width: 2 * R - 1.5,
      height: 2 * R - 1.5,
      layer: L.shading,
    });
    const shadow = s.ellipse({
      rx: 2 * R,
      ry: R,
      center: [cx, $`${cy} - ${2 * R}`],
      fillColor: rgba(0, 0, 0, 1),
      strokeColor: Colors.clear,
      layer: L.shadow,
    });
    N.set(n.id, { cx, cy, icon, shading, shadow, labelText: null });
  });

  /* collect Node n into nodes { Group { shapes: shadows, opacity .1, blur } } */
  s.collect(
    Node,
    (n) => N.get(n.id)?.shadow,
    (shadows) => {
      s.group({ shapes: shadows, opacity: 0.1, style: 'filter:blur(5px);', layer: L.shadow });
    },
  );

  /* forall Node n where n has label { Equation } */
  s.forall({ n: Node }, ({ n }) => {
    if (!n.label) return;
    const node = N.get(n.id);
    node.labelText = s.equation({
      string: n.label,
      center: [node.cx, node.cy],
      fillColor: Colors.black,
      fontSize: '18px',
      layer: L.label,
    });
  });

  /* forall FunctionalGroup g { override ...; box = Rectangle } */
  s.forall({ g: FunctionalGroup }, ({ g }) => {
    const node = N.get(g.id);
    s.override(node.icon, { fillColor: Colors.clear, strokeColor: Colors.clear });
    s.override(node.shading, { opacity: 0 });
    if (node.labelText) s.override(node.labelText, { fillColor: Colors.black });
    s.override(node.shadow, { fillColor: Colors.clear });
    s.rect({
      center: [node.cx, node.cy],
      width: 3 * Global.atomRadius,
      height: 1.5 * Global.atomRadius,
      fillColor: Colors.lightGray,
      strokeColor: Colors.gray,
      strokeWidth: 3,
      cornerRadius: 10,
      layer: L.box,
    });
  });

  /* Per-element overrides */
  const element = (Type, fill, stroke, extra) => {
    s.forall({ x: Type }, ({ x }) => {
      const node = N.get(x.id);
      s.override(node.icon, { fillColor: fill, strokeColor: stroke });
      if (node.labelText) s.override(node.labelText, { fillColor: none() });
      if (extra) extra(node);
    });
  };
  element(Oxygen, Colors.clearred, Colors.red);
  element(Carbon, Colors.clearblack, Colors.black);
  element(Nitrogen, Colors.clearblue, Colors.blue);
  element(Chlorine, Colors.cleargreen, Colors.green);
  element(Sodium, Colors.clearpurple, Colors.purple);
  element(Hydrogen, Colors.cleargray, Colors.gray, (node) => {
    // make hydrogen atoms (and their shadows) smaller
    const R = 0.75 * Global.atomRadius;
    s.override(node.icon, { r: R });
    s.override(node.shading, { width: 2 * R - 1.5, height: 2 * R - 1.5 });
    s.override(node.shadow, { rx: 2 * R, ry: R });
  });

  /* -------------------------------------------------------------------- */
  /* Bonds                                                                 */
  /* -------------------------------------------------------------------- */

  const center = (n) => {
    const node = N.get(n.id);
    return [node.cx, node.cy];
  };

  const bondEnds = (x1, x2, offset) => {
    // u = unit(x1 - x2), v = (-u[1], u[0])
    const u = ops.vnormalize(ops.vsub(x1, x2));
    const v = ops.rot90(u);
    const r = Global.atomRadius;
    const side = ops.vmul(offset * r, v);
    return {
      start: ops.vadd(ops.vsub(x1, ops.vmul(0.5 * r, u)), side),
      end: ops.vadd(ops.vadd(x2, ops.vmul(0.5 * r, u)), side),
    };
  };

  const tube = (x1, x2, offset) => {
    const { start, end } = bondEnds(x1, x2, offset);
    s.line({ start, end, strokeWidth: 10, strokeColor: Colors.gray, strokeLinecap: 'round', layer: L.bond });
    s.line({ start, end, strokeWidth: 4, strokeColor: Colors.lightGray, strokeLinecap: 'round', layer: L.bondInner });
  };

  s.forallWhere({ n1: Node, n2: Node }, ({ n1, n2 }) => SingleBond.test(n1, n2), ({ n1, n2 }) => {
    const x1 = center(n1);
    const x2 = center(n2);
    tube(x1, x2, 0);
    encourage(ops.equal(ops.norm(ops.vsub(x1, x2)), Global.bondLength));
  });

  s.forallWhere({ n1: Node, n2: Node }, ({ n1, n2 }) => DoubleBond.test(n1, n2), ({ n1, n2 }) => {
    const x1 = center(n1);
    const x2 = center(n2);
    tube(x1, x2, -0.25);
    tube(x1, x2, 0.25);
    encourage(ops.equal(ops.norm(ops.vsub(x1, x2)), Global.bondLength));
  });

  s.forallWhere({ n1: Node, n2: Node }, ({ n1, n2 }) => IonicBond.test(n1, n2), ({ n1, n2 }) => {
    const x1 = center(n1);
    const x2 = center(n2);
    const { start, end } = bondEnds(x1, x2, 0);
    s.line({
      start,
      end,
      strokeWidth: 2.5,
      strokeColor: Colors.turquoise,
      strokeLinecap: 'butt',
      style: 'dashed',
      layer: L.bond,
    });
    encourage(ops.equal(ops.norm(ops.vsub(x1, x2)), Global.bondLength));
  });

  /* make bonds with hydrogen shorter */
  s.forallWhere({ n: Node, h: Hydrogen }, ({ n, h }) => SingleBond.test(n, h) || SingleBond.test(h, n), ({ n, h }) => {
    // encourage equal( 2.*norm(x1-x2), .5*Global.bondLength )
    encourage`${2} * ${ops.norm(ops.vsub(center(n), center(h)))} == ${0.5 * Global.bondLength}`;
  });

  /* give water molecules a physical bond angle */
  const bonded = (x, y) => SingleBond.test(x, y) || SingleBond.test(y, x);
  s.forallWhere(
    { o: Oxygen, h1: Hydrogen, h2: Hydrogen },
    ({ o, h1, h2 }) => h1.id < h2.id && bonded(o, h1) && bonded(o, h2),
    ({ o, h1, h2 }) => {
      const A = center(o);
      encourage(
        ops.equal(ops.angleBetween(ops.vsub(center(h1), A), ops.vsub(center(h2), A)), ops.toRadians(104.5)),
      );
    },
  );

  /* Coulomb-like repulsion: Penrose uses encourage 200000/normsq(x1-x2) == 0.
   * XPBD compliance is measured in units of the residual, so the term is
   * written in linear distance (not normsq) to keep its stiffness comparable
   * to the bond-length terms.  Same fixed points, no 1/r² blow-up. */
  // Pairs already governed by a bond length, or by a bond angle through a
  // shared neighbor, are skipped so the repulsion floor does not fight them.
  const anyBond = (x, y) =>
    SingleBond.test(x, y) || SingleBond.test(y, x) ||
    DoubleBond.test(x, y) || DoubleBond.test(y, x) ||
    IonicBond.test(x, y) || IonicBond.test(y, x);
  const neighbors = (x) => {
    const out = new Set();
    for (const P of [SingleBond, DoubleBond, IonicBond]) {
      for (const [p, q] of P.relations) {
        if (p === x) out.add(q);
        if (q === x) out.add(p);
      }
    }
    return out;
  };
  const sharesNeighbor = (x, y) => {
    const nx = neighbors(x);
    for (const z of neighbors(y)) if (nx.has(z)) return true;
    return false;
  };
  s.forallWhere(
    { n1: Node, n2: Node },
    ({ n1, n2 }) => n1.id < n2.id && !anyBond(n1, n2) && !sharesNeighbor(n1, n2),
    ({ n1, n2 }) => {
      const d = ops.norm(ops.vsub(center(n1), center(n2)));
      encourage`${d} >= ${1.6 * Global.atomRadius}`;
    },
  );

  /* forall Title t where t has label */
  s.forall({ t: Title }, ({ t }) => {
    s.text({
      string: t.label,
      fillColor: Colors.black,
      fontSize: '40px',
      fontFamily: 'HelveticaNeue-CondensedBold, Helvetica Neue, Helvetica, Arial, sans-serif',
      fontWeight: 'bold',
      center: [0, 340],
      layer: L.title,
    });
  });

  return {
    s,
    types: { Node, FunctionalGroup, Atom, Hydrogen, Carbon, Nitrogen, Oxygen, Sodium, Chlorine, Molecule, Title },
    predicates: { SingleBond, DoubleBond, IonicBond, Contains },
    nodes: N,
  };
}
