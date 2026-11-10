import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_CORE) candidates.push(process.env.PLAYWRIGHT_CORE);
  candidates.push('playwright-core', 'playwright');
  // Local convenience fallback for the development machine.
  candidates.push('/Users/jiwonpark/workspace/kirbyclone/node_modules/playwright-core/index.mjs');
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      if (mod && mod.chromium) return mod;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    'playwright-core or playwright is required for browser tests. Install one, or set PLAYWRIGHT_CORE.',
  );
}

const { chromium } = await loadPlaywright();
const chromePath =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const launchOptions = existsSync(chromePath) ? { executablePath: chromePath } : {};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function serve() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      let file = path.join(ROOT, decodeURIComponent(url.pathname));
      if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
      if (!file.startsWith(ROOT)) throw new Error('forbidden');
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const failures = [];
const passes = [];
function check(name, condition, detail) {
  if (condition) {
    passes.push(name);
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function near(a, b, tol = 1e-2) {
  return Math.abs(a - b) <= tol;
}
function dist(a, b) {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy);
}

async function drag(page, sceneName, from, to, opts = {}) {
  const { steps = 28, hold = 1100, settle = 800 } = opts;
  await page.evaluate((name) => {
    if (window.__KITE && window.__KITE.scrollTo) window.__KITE.scrollTo(name);
    else if (window.__KITE_STRESS) window.__KITE_STRESS.scroll();
  }, sceneName);
  await page.waitForTimeout(120);
  const a = await page.evaluate(
    ([name, x, y]) =>
      window.__KITE && window.__KITE.worldToClient
        ? window.__KITE.worldToClient(name, x, y)
        : window.__KITE_STRESS.worldToClient(x, y),
    [sceneName, from[0], from[1]],
  );
  const b = await page.evaluate(
    ([name, x, y]) =>
      window.__KITE && window.__KITE.worldToClient
        ? window.__KITE.worldToClient(name, x, y)
        : window.__KITE_STRESS.worldToClient(x, y),
    [sceneName, to[0], to[1]],
  );
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    await page.waitForTimeout(18);
  }
  await page.waitForTimeout(hold);
  await page.mouse.up();
  await page.waitForTimeout(settle);
}

const server = await serve();
const port = server.address().port;
const browser = await chromium.launch({ ...launchOptions, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error' && !msg.text().includes('favicon')) pageErrors.push(msg.text());
});

try {
  await page.goto(`http://127.0.0.1:${port}/tests/acceptance.html`, { waitUntil: 'load' });
  const initial = await page.evaluate(() => window.__KITE.ready);
  if (initial.errors.length) throw new Error(initial.errors.join('\n'));

  console.log('\nTest 1 — Manifold Projection');
  const t1 = initial.tests.t1;
  check('orbit center pinned', near(t1.orbit.cx, 0, 1e-3) && near(t1.orbit.cy, 0, 1e-3), JSON.stringify(t1.orbit));
  check('planet starts on orbit', near(Math.hypot(t1.planet.cx, t1.planet.cy), 150, 1e-2));
  check('initial convergence', t1.maxError < 1e-3, String(t1.maxError));

  await drag(page, 't1', [150, 0], [300, 300], { hold: 1500, settle: 900 });
  let snap = await page.evaluate(() => window.__KITE.snapshot());
  let planet = snap.t1.planet;
  check('drag outside: stays on manifold', near(Math.hypot(planet.cx, planet.cy), 150, 0.15), JSON.stringify(planet));
  check('drag outside: follows mouse angle', Math.abs(Math.atan2(planet.cy, planet.cx) - Math.PI / 4) < 0.12, JSON.stringify(planet));

  const fromOutside = [planet.cx, planet.cy];
  await drag(page, 't1', fromOutside, [0, 0], { hold: 1200, settle: 900 });
  snap = await page.evaluate(() => window.__KITE.snapshot());
  planet = snap.t1.planet;
  check('drag to center: no escape', near(Math.hypot(planet.cx, planet.cy), 150, 0.2), JSON.stringify(planet));
  check('drag to center: finite / smooth', Number.isFinite(planet.cx) && Number.isFinite(planet.cy) && Math.hypot(planet.cx, planet.cy) > 10);
  check('manifold residual', snap.t1.maxError < 1e-3, String(snap.t1.maxError));

  console.log('\nTest 2 — Auto-Slacking');
  const t2 = initial.tests.t2;
  check('c2 derived center initialized', near(t2.c2.cx - t2.c1.cx, 80, 1e-3) && near(t2.c2.cy, t2.c1.cy, 1e-3), JSON.stringify(t2));
  check('auto-slack emitted hard constraint', t2.autoSlackConstraints >= 1, String(t2.autoSlackConstraints));

  await drag(page, 't2', [t2.c1.cx, t2.c1.cy], [100, 50], { hold: 900, settle: 700 });
  snap = await page.evaluate(() => window.__KITE.snapshot());
  check('drag c1: c1 follows', near(snap.t2.c1.cx, 100, 4) && near(snap.t2.c1.cy, 50, 4), JSON.stringify(snap.t2.c1));
  check('drag c1: c2 keeps 80px', near(snap.t2.c2.cx - snap.t2.c1.cx, 80, 1.5) && near(snap.t2.c2.cy, snap.t2.c1.cy, 1.5), JSON.stringify(snap.t2));

  const c2Now = [snap.t2.c2.cx, snap.t2.c2.cy];
  await drag(page, 't2', c2Now, [-100, -60], { hold: 1100, settle: 800 });
  snap = await page.evaluate(() => window.__KITE.snapshot());
  check('drag c2: c2 follows', near(snap.t2.c2.cx, -100, 5) && near(snap.t2.c2.cy, -60, 5), JSON.stringify(snap.t2.c2));
  check('drag c2: c1 dragged backwards', near(snap.t2.c2.cx - snap.t2.c1.cx, 80, 1.5) && near(snap.t2.c2.cy, snap.t2.c1.cy, 1.5), JSON.stringify(snap.t2));

  console.log('\nTest 3 — Subtyping & Euler Diagram');
  const t3 = initial.tests.t3;
  check('supertypes: Set matched all 5', t3.typeMatches === 5, String(t3.typeMatches));
  check('multiple inheritance: Element matched all 5', t3.elementMatches === 5, String(t3.elementMatches));
  check('multiple inheritance: NamedSet matched 1', t3.namedSetMatches === 1, String(t3.namedSetMatches));
  check('initial Euler convergence < 500ms', t3.elapsed < 500, t3.elapsed.toFixed(1) + 'ms');
  check('initial Euler residual < 1e-2', t3.maxError < 1e-2, String(t3.maxError));

  function eulerInvariants(pos) {
    const dAB = dist(pos.A, pos.B);
    const dAC = dist(pos.A, pos.C);
    const dBC = dist(pos.B, pos.C);
    const dBD = dist(pos.B, pos.D);
    const dCE = dist(pos.C, pos.E);
    return {
      bInA: dAB + pos.B.r + 8 <= pos.A.r + 0.02,
      cInA: dAC + pos.C.r + 8 <= pos.A.r + 0.02,
      bcDisjoint: dBC >= pos.B.r + pos.C.r + 10 - 0.02,
      dInB: dBD + pos.D.r + 8 <= pos.B.r + 0.02,
      eInC: dCE + pos.E.r + 8 <= pos.C.r + 0.02,
      dAB,
      dAC,
      dBC,
      dBD,
      dCE,
    };
  }
  const inv0 = eulerInvariants(t3.positions);
  check('contains(A,B)', inv0.bInA, JSON.stringify(inv0));
  check('contains(A,C)', inv0.cInA, JSON.stringify(inv0));
  check('disjoint(B,C)', inv0.bcDisjoint, JSON.stringify(inv0));
  check('contains(B,D)', inv0.dInB, JSON.stringify(inv0));
  check('contains(C,E)', inv0.eInC, JSON.stringify(inv0));

  await drag(page, 't3', [t3.positions.A.cx, t3.positions.A.cy], [150, 60], { hold: 1100, settle: 900 });
  snap = await page.evaluate(() => window.__KITE.snapshot());
  const A = snap.t3.positions.A;
  check('outer set follows drag', near(A.cx, 150, 8) && near(A.cy, 60, 8), JSON.stringify(A));
  const inv1 = eulerInvariants(snap.t3.positions);
  check('all Euler constraints hold after drag', Object.values(inv1).slice(0, 5).every(Boolean), JSON.stringify(inv1));
  check('Euler residual after drag', snap.t3.maxError < 1e-2, String(snap.t3.maxError));

  console.log('\nTest 4 — Incremental Topology');
  const t4 = initial.tests.t4;
  check('initial body count 3', t4.bodyCount === 3, String(t4.bodyCount));
  const before = t4.before;
  const beforeArr = Object.entries(before).map(([id, c]) => ({ id, ...c }));
  await page.evaluate(() => window.__KITE.addDynamicBody(420, 250));
  await page.waitForTimeout(1400);
  snap = await page.evaluate(() => window.__KITE.snapshot());
  check('new body appended', snap.t4.bodies.length === 4, String(snap.t4.bodies.length));
  check('new body keeps its seed position', near(snap.t4.bodies[3].cx, 420, 12) && near(snap.t4.bodies[3].cy, 250, 12), JSON.stringify(snap.t4.bodies[3]));
  let maxOldShift = 0;
  for (const b of beforeArr) {
    const after = snap.t4.bodies.find((x) => x.id === b.id);
    if (after) maxOldShift = Math.max(maxOldShift, Math.hypot(after.cx - b.cx, after.cy - b.cy));
  }
  check('existing bodies not reset', maxOldShift < 12, maxOldShift.toFixed(3) + 'px');
  let minPair = Infinity;
  for (let i = 0; i < snap.t4.bodies.length; i++) {
    for (let j = i + 1; j < snap.t4.bodies.length; j++) minPair = Math.min(minPair, dist(snap.t4.bodies[i], snap.t4.bodies[j]));
  }
  check('all bodies disjoint after append', minPair >= 68 + 12 - 0.05, minPair.toFixed(2));
  check('incremental residual', snap.t4.maxError < 1e-2, String(snap.t4.maxError));
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  console.log('\nStress — spatial hash (>32 disjoint pairs)');
  pageErrors.length = 0;
  await page.goto(`http://127.0.0.1:${port}/tests/stress.html`, { waitUntil: 'load' });
  const stress = await page.evaluate(() => window.__KITE_STRESS.ready);
  check('36 bodies / 630 disjoint pairs built', stress.pairCount === 630 && stress.bodies.length === 36, String(stress.pairCount));
  check('stress initial convergence', stress.maxError < 1e-2, String(stress.maxError));

  await page.evaluate(() => window.__KITE_STRESS.scroll());
  await page.waitForTimeout(120);
  const from = stress.bodies[0];
  const to = stress.bodies[13];
  await drag(page, 'stress', [from.x, from.y], [to.x, to.y], { hold: 1300, settle: 2200 });
  const stressSnap = await page.evaluate(() => window.__KITE_STRESS.snapshot());
  let minStress = Infinity;
  for (let i = 0; i < stressSnap.bodies.length; i++) {
    for (let j = i + 1; j < stressSnap.bodies.length; j++) {
      const a = stressSnap.bodies[i];
      const b = stressSnap.bodies[j];
      minStress = Math.min(minStress, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  check('broad-phase keeps all pairs disjoint', minStress >= 44 + 8 - 0.1, minStress.toFixed(3));
  check('stress residual after drag', stressSnap.maxError < 1e-2, String(stressSnap.maxError));
  check('stress has no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  console.log('\nDemo page');
  pageErrors.length = 0;
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const demo = await page.evaluate(() => ({
    scenes: Object.keys(window.__kiteDemo || {}).length,
    svgs: document.querySelectorAll('svg').length,
    customSvg: document.querySelectorAll('kite-diagram svg').length,
    customCircles: document.querySelectorAll('kite-diagram svg circle').length,
  }));
  check('demo scenes boot', demo.scenes === 10, JSON.stringify(demo));
  check('custom element renders', demo.customSvg === 1 && demo.customCircles >= 2, JSON.stringify(demo));
  check('demo has no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  // Labels are ordinary text shapes whose centers are derived from their
  // set's center.  Dragging the set must carry the label along exactly.
  const readEulerLabel = () =>
    page.evaluate(() => {
      const s = window.__kiteDemo.es;
      const svg = s._svg;
      const circles = [...svg.querySelectorAll('circle')];
      const b = circles[1];
      const label = [...svg.querySelectorAll('text')].find((t) => t.textContent === 'B');
      const client = (x, y) => {
        const p = svg.createSVGPoint();
        p.x = x;
        p.y = -y;
        const out = p.matrixTransform(svg.getScreenCTM());
        return { x: out.x, y: out.y };
      };
      const bx = Number(b.getAttribute('cx'));
      const by = -Number(b.getAttribute('cy'));
      return {
        circle: { x: bx, y: by },
        label: { x: Number(label.getAttribute('x')), y: -Number(label.getAttribute('y')) },
        from: client(bx, by),
        to: client(bx + 42, by + 18),
      };
    });
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto';
    document.getElementById('euler-stage').scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(300);
  const eulerBefore = await readEulerLabel();
  await page.mouse.move(eulerBefore.from.x, eulerBefore.from.y);
  await page.mouse.down();
  await page.mouse.move(eulerBefore.to.x, eulerBefore.to.y, { steps: 14 });
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const eulerAfter = await readEulerLabel();
  const cd = { x: eulerAfter.circle.x - eulerBefore.circle.x, y: eulerAfter.circle.y - eulerBefore.circle.y };
  const ld = { x: eulerAfter.label.x - eulerBefore.label.x, y: eulerAfter.label.y - eulerBefore.label.y };
  check(
    'Euler labels follow their sets',
    Math.hypot(cd.x, cd.y) > 20 && Math.hypot(cd.x - ld.x, cd.y - ld.y) < 0.05,
    JSON.stringify({ cd, ld }),
  );

  console.log('\nStructural formula — caffeine');
  pageErrors.length = 0;
  await page.goto(`http://127.0.0.1:${port}/examples/caffeine.html`, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const caffeine = await page.evaluate(() => {
    const k = window.__KITE_CAFFEINE;
    if (!k) return null;
    const texts = [...document.querySelectorAll('#mol-stage svg text')].map((t) => t.textContent);
    return {
      atoms: k.atoms,
      bonds: k.bonds,
      groups: k.groups,
      title: k.title,
      shapes: k.s.shapes.length,
      circles: document.querySelectorAll('#mol-stage svg circle').length,
      lines: document.querySelectorAll('#mol-stage svg line').length,
      hasTitle: texts.includes('caffeine'),
      hasOxygen: texts.includes('O'),
      hasNitrogen: texts.includes('N'),
    };
  });
  check('caffeine: 24 atoms / 25 bonds / 3 groups', !!caffeine && caffeine.atoms === 24 && caffeine.bonds === 25 && caffeine.groups === 3, JSON.stringify(caffeine));
  check('caffeine: SVG graph rendered', !!caffeine && caffeine.circles >= 40 && caffeine.lines >= 50, JSON.stringify(caffeine));
  check('caffeine: labels and title', !!caffeine && caffeine.hasTitle && caffeine.hasOxygen && caffeine.hasNitrogen, JSON.stringify(caffeine));
  check('caffeine: no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  console.log('\nstructural-formula — Penrose port');
  pageErrors.length = 0;
  await page.goto(`http://127.0.0.1:${port}/examples/structural-formula.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__KITE_SF && window.__KITE_SF.s.converged, null, { timeout: 20000 }).catch(() => {});
  const sf = await page.evaluate(() => {
    const { s, sf, atoms, singles, doubles } = window.__KITE_SF;
    const pos = (k) => {
      const n = sf.nodes.get(atoms[k].id);
      return [s._val(n.cx), s._val(n.cy)];
    };
    const d = (a, b) => Math.hypot(pos(a)[0] - pos(b)[0], pos(a)[1] - pos(b)[1]);
    const heavy = [...singles, ...doubles].filter(([a, b]) => a[0] !== 'H' && b[0] !== 'H').map(([a, b]) => d(a, b));
    const hyd = singles.filter(([a, b]) => a[0] === 'H' || b[0] === 'H').map(([a, b]) => d(a, b));
    const svg = s._svg;
    const blur = [...svg.querySelectorAll('g')].find((g) => (g.getAttribute('style') || '').includes('blur(5px)'));
    const fills = [...svg.querySelectorAll('circle')].map((c) => c.getAttribute('fill'));
    return {
      converged: s.converged,
      heavy: [Math.min(...heavy), Math.max(...heavy)],
      hyd: [Math.min(...hyd), Math.max(...hyd)],
      ellipses: svg.querySelectorAll('ellipse').length,
      images: svg.querySelectorAll('image').length,
      blurChildren: blur ? blur.querySelectorAll('ellipse').length : 0,
      blurOpacity: blur ? Number(blur.getAttribute('opacity')) : null,
      labelsHidden: [...svg.querySelectorAll('text')].filter((t) => t.getAttribute('fill') === 'none').length,
      oxygen: fills.filter((f) => f === 'rgb(255,102,102)').length,
      hydrogenR: [...svg.querySelectorAll('circle')].filter((c) => Math.abs(Number(c.getAttribute('r')) - 18.75) < 1e-6).length,
    };
  });
  check('SF: soft layout settles (sleep mode)', sf.converged, JSON.stringify(sf));
  check('SF: heavy-atom bonds near bondLength 60', sf.heavy[0] > 54 && sf.heavy[1] < 80, JSON.stringify(sf.heavy));
  // SingleBond says |d| = 60 and the hydrogen rule says 2|d| = 30.  With
  // unit-free soft constraints the compromise is the mean of 60 and 15.
  check('SF: hydrogen bonds at the 60 / 15 compromise (≈37.5)', sf.hyd[0] > 32 && sf.hyd[1] < 44, JSON.stringify(sf.hyd));
  check('SF: Ellipse shadows + Image background/shading', sf.ellipses === 24 && sf.images === 25, JSON.stringify(sf));
  check('SF: collect → one blurred Group of 24 shadows', sf.blurChildren === 24 && sf.blurOpacity === 0.1, JSON.stringify(sf));
  check('SF: override + rgba/none (O fill, H radius, hidden labels)', sf.oxygen === 2 && sf.hydrogenR === 10 && sf.labelsHidden === 24, JSON.stringify(sf));

  await page.click('#add-water');
  await page.waitForTimeout(200);
  await page.waitForFunction(() => window.__KITE_SF.s.converged, null, { timeout: 20000 }).catch(() => {});
  const water = await page.evaluate(() => {
    const { s, sf } = window.__KITE_SF;
    const all = [...sf.nodes.values()];
    const [o, h1, h2] = all.slice(-3).map((n) => [s._val(n.cx), s._val(n.cy)]);
    const u = [h1[0] - o[0], h1[1] - o[1]];
    const v = [h2[0] - o[0], h2[1] - o[1]];
    const ang = Math.atan2(Math.abs(u[0] * v[1] - u[1] * v[0]), u[0] * v[0] + u[1] * v[1]);
    const blur = [...s._svg.querySelectorAll('g')].find((g) => (g.getAttribute('style') || '').includes('blur(5px)'));
    return { deg: (ang * 180) / Math.PI, nodes: all.length, blurChildren: blur.querySelectorAll('ellipse').length };
  });
  check('SF: appended H2O, angleBetween → 104.5°', Math.abs(water.deg - 104.5) < 3, JSON.stringify(water));
  check('SF: collect re-runs on growth (27 shadows)', water.nodes === 27 && water.blurChildren === 27, JSON.stringify(water));

  // Atoms are free variables and carry drag:true, so the icon, shading,
  // shadow, label and every attached bond must follow the pointer.
  await page.evaluate(() => document.getElementById('stage').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  const atomPoint = await page.evaluate(() => {
    const { s, sf, atoms } = window.__KITE_SF;
    const n = sf.nodes.get(atoms.C1.id);
    const x = s._val(n.cx);
    const y = s._val(n.cy);
    const svg = s._svg;
    const client = (wx, wy) => {
      const p = svg.createSVGPoint();
      p.x = wx;
      p.y = -wy;
      const o = p.matrixTransform(svg.getScreenCTM());
      return { x: o.x, y: o.y };
    };
    return { x, y, from: client(x, y), to: client(x + 60, y + 35) };
  });
  await page.mouse.move(atomPoint.from.x, atomPoint.from.y);
  await page.mouse.down();
  await page.mouse.move(atomPoint.to.x, atomPoint.to.y, { steps: 10 });
  await page.waitForTimeout(450);
  const dragged = await page.evaluate(() => {
    const { s, sf, atoms } = window.__KITE_SF;
    const n = sf.nodes.get(atoms.C1.id);
    return { x: s._val(n.cx), y: s._val(n.cy), dragging: s._dragActive };
  });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check(
    'SF: atoms are draggable (icon + bonds + labels follow)',
    dragged.dragging && Math.hypot(dragged.x - atomPoint.x, dragged.y - atomPoint.y) > 25,
    JSON.stringify({ from: [atomPoint.x, atomPoint.y], to: [dragged.x, dragged.y] }),
  );
  check('SF: no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  console.log('\nPenrose examples gallery');
  pageErrors.length = 0;
  await page.goto(`http://127.0.0.1:${port}/examples/penrose-gallery.html`, { waitUntil: 'load' });
  await page.waitForTimeout(1800);
  const gallery = await page.evaluate(() => {
    const g = window.__GALLERY;
    const stages = [...document.querySelectorAll('.stage')];
    return {
      examples: g ? g.examples.length : 0,
      scenes: g ? g.scenes.length : 0,
      cards: document.querySelectorAll('.card').length,
      svgs: document.querySelectorAll('.stage svg').length,
      nonEmpty: stages.filter((st) => st.querySelector('svg') && st.querySelectorAll('svg *').length > 5).length,
      sierpinski: document.querySelectorAll('#stage-sierpinski circle').length,
      caffeine: document.querySelectorAll('#stage-caffeine circle').length,
      regression: [...document.querySelectorAll('#stage-linearreg line')].filter((l) => l.getAttribute('stroke') === '#dc2626').length,
      halfAdder: [...document.querySelectorAll('#stage-half-adder text')].map((t) => t.textContent).join('|'),
    };
  });
  check('gallery: 13 example cards / Kite scenes', gallery.examples === 13 && gallery.scenes === 13 && gallery.cards === 13 && gallery.svgs === 13, JSON.stringify(gallery));
  check('gallery: every scene rendered', gallery.nonEmpty === 13, JSON.stringify(gallery));
  check('gallery: chaos game + caffeine + regression content', gallery.sierpinski > 690 && gallery.caffeine === 24 && gallery.regression === 1, JSON.stringify(gallery));
  check('gallery: half-adder labels', gallery.halfAdder.includes('XOR') && gallery.halfAdder.includes('AND'), gallery.halfAdder);

  // A graph node drags its circle, label and incident edges together.
  const dragGalleryNode = async () => {
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = 'auto';
      document.getElementById('stage-hamiltonian-cycle').scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(250);
    const before = await page.evaluate(() => {
      const g = window.__GALLERY;
      const s = g.scenes[g.examples.indexOf('hamiltonian-cycle')];
      const svg = s._svg;
      const c = svg.querySelector('circle');
      const x = Number(c.getAttribute('cx'));
      const y = -Number(c.getAttribute('cy'));
      const client = (wx, wy) => {
        const p = svg.createSVGPoint();
        p.x = wx;
        p.y = -wy;
        const o = p.matrixTransform(svg.getScreenCTM());
        return { x: o.x, y: o.y };
      };
      return { x, y, from: client(x, y), to: client(x + 55, y + 25) };
    });
    await page.mouse.move(before.from.x, before.from.y);
    await page.mouse.down();
    await page.mouse.move(before.to.x, before.to.y, { steps: 8 });
    await page.waitForTimeout(350);
    await page.mouse.up();
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => {
      const g = window.__GALLERY;
      const s = g.scenes[g.examples.indexOf('hamiltonian-cycle')];
      const c = s._svg.querySelector('circle');
      return { x: Number(c.getAttribute('cx')), y: -Number(c.getAttribute('cy')) };
    });
    return { before, after, delta: Math.hypot(after.x - before.x, after.y - before.y) };
  };
  const nodeDrag = await dragGalleryNode();
  check('gallery: graph nodes are draggable', nodeDrag.delta > 30, JSON.stringify(nodeDrag));

  // Procedural cards pan when the background is dragged.
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto';
    document.getElementById('stage-sierpinski').scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(200);
  const panBefore = await page.evaluate(() => {
    const g = window.__GALLERY;
    const s = g.scenes[g.examples.indexOf('sierpinski')];
    const r = s._svg.getBoundingClientRect();
    return { vb: s._svg.getAttribute('viewBox'), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(panBefore.x, panBefore.y);
  await page.mouse.down();
  await page.mouse.move(panBefore.x + 50, panBefore.y + 25, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const panAfter = await page.evaluate(() => {
    const g = window.__GALLERY;
    return g.scenes[g.examples.indexOf('sierpinski')]._svg.getAttribute('viewBox');
  });
  check('gallery: procedural cards pan on drag', panAfter !== panBefore.vb, panBefore.vb + ' -> ' + panAfter);
  check('gallery: no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  console.log(`\n${passes.length} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(' -', f.name, f.detail || '');
    process.exitCode = 1;
  }
} catch (err) {
  console.error('\nFATAL:', err);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
