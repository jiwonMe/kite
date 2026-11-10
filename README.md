# Kite

**RFC-0001 — Zero-Build Declarative & Manifold-Projected Diagram Engine**

Penrose의 Trio(도메인 · 서브스턴스 · 스타일) 철학을 계승하되, 빌드 도구와 외부 최적화 스택을
걷어내고 단일 ES 모듈로 재설계한 다이어그램 엔진입니다.

- **단일 파일**: `kite.js` (외부 npm, 번들러, wasm, 별도 `worker.js` 없음)
- **무헤더 동시성**: `SharedArrayBuffer` 대신 인라인 Blob Worker + Transferable `ArrayBuffer`
- **선언형 제약**: `ensure`(하드) / `encourage`(소프트) + `$` 태그드 템플릿 JIT
- **자동 슬래킹**: `drag: true` + 파생 좌표 → 자유 변수 + 하드 등식 자동 삽입
- **다양체 정사영**: 마우스 인력을 유한 컴플라이언스 소프트 제약으로 처리, XPBD가 매 프레임 재사영
- **증분 토폴로지**: `scene.step()`이 새 규칙 일치만 실행해 바이트코드 테이프 끝에 append

---

## 빠른 시작

```html
<div id="stage" style="width: 600px; height: 600px"></div>

<script type="module">
  import { scene, ensure, ops } from "./kite.js";

  const s = scene("#stage", { width: 600, height: 600, seed: 42 });

  const orbit = s.circle({ center: [0, 0], r: 150, fill: "none", stroke: "#94a3b8" });
  const planet = s.circle({
    center: [150, 0],
    r: 18,
    fill: "#2f5de3",
    drag: true,
  });

  // 하드 등식. 마우스로 끌어도 행성은 이 원 위에 유지됩니다.
  ensure`${ops.dist(planet.center, orbit.center)} == ${orbit.r}`;

  await s.mount();
</script>
```

`scene(container)`은 컨테이너가 주어지면 마이크로태스크에서 자동으로 `mount()`를 시작합니다.
명시적으로 `await s.mount()`를 호출해도 동일한 Promise를 공유합니다.

> `$`, `ensure`, `encourage`, `ops`는 현재 활성 장면(`ACTIVE_SCENE`)을 사용합니다.
> `scene()` 호출과 각 도형 메서드, `forall` body가 활성 장면을 갱신하므로, 여러 장면을
> 만들 때는 해당 장면의 `forall` body 안에서 제약을 선언하세요.

로컬 데모:

```bash
npm run serve
# http://127.0.0.1:4173/
# http://127.0.0.1:4173/tests/acceptance.html
```

---

## RFC 대응표

| RFC | 구현 위치 |
| --- | --- |
| 불변성 1 — Zero Build / Zero Dependency | `kite.js` 단일 파일, import 없음 |
| 불변성 2 — Zero Header Concurrency | `kiteWorkerMain.toString()` → Blob Worker, `postMessage(..., [buffer])` |
| 불변성 3 — No `ops.add` Boilerplate | Module 2의 Pratt 파서 + `templateAstCache` (`WeakMap<TemplateStringsArray>`) |
| 불변성 4 — No `bindToInput` | `KiteSceneImpl._coord()`의 Auto-Slacking |
| 불변성 5 — No `dragConstraint` | Worker의 `applyDragConstraint()` + 소프트/하드 순서 정렬 |
| 불변성 6 — Incremental Topology | `_flushToWorker()`의 `APPEND_TAPE`, 규칙별 `executed: Set<string>` |
| §3 Tape VM | `Tape`, `evaluateTape`, `nodeDependencies`, Worker의 `backward()` |
| §4 JIT / Auto-Slack | `astForTemplate`, `emitTemplate`, `resolve` 경로 `_coord` |
| §5 Domain / Substance / Style | `type()`, `predicate()`, `forall()`, `forallWhere()`, 비트마스크 매칭 |
| §6 XPBD Manifold Projection | `kiteWorkerMain`의 `warmStart`, `solveSubsteps`, `applyConstraint` |
| §7 Worker / SVG / Custom Element | Transferable 버퍼, `_renderShape`, `<kite-diagram>` |
| §8 인수 테스트 | `tests/unit-node.mjs`, `tests/acceptance.html`, `tests/run.mjs` |

---

## 검증

```bash
npm test                 # Node 단위 테스트 + 실제 Chrome 브라우저 인수 테스트
npm run test:unit        # DOM 없이 파서 / 테이프 / 도메인 / 오토슬랙 검증
npm run test:browser     # Playwright로 4개 인수 시나리오 + 실제 포인터 드래그
```

브라우저 테스트는 `playwright-core` 또는 `playwright`가 설치되어 있으면 이를 사용하고,
없으면 macOS의 Google Chrome을 직접 실행합니다.

```bash
# 선택
export CHROME_PATH="/path/to/Chrome"
export PLAYWRIGHT_CORE="/path/to/playwright-core/index.mjs"
```

### 인수 테스트 구성

1. **Manifold Projection** — 반경 150 원 위 행성을 원 밖 `(300,300)`과 중심 `(0,0)`으로 드래그.
   반경 오차와 각도 추종, 발산 없음, 잔차 `< 1e-3` 검증.
2. **Auto-Slacking** — `c2.center = [c1.x + 80, c1.y]`, 양쪽 모두 `drag: true`.
   c1을 끌면 c2가 따라오고, c2를 끌면 c1이 80px 간격을 유지한 채 뒤로 끌려옴.
3. **Subtyping / Euler** — `NamedSet`이 `Set`과 `Named`를 동시에 상속.
   5개 집합의 `contains` / `disjoint` 제약이 0.5초 내 `1e-2` 이하로 수렴.
   외곽 A를 드래그한 뒤에도 모든 포함·분리 불변식 유지.
4. **Incremental Topology** — 실행 중 `Body` 인스턴스 추가 → `scene.step()`.
   기존 변수 위치는 재초기화되지 않고, 새 변수/제약만 테이프에 append되어 즉시 상호작용.
5. **Spatial hash stress (보조)** — 36개 원, 630개 `disjoint` 쌍.
   32쌍 초과 시 균일 격자 광역 단계가 활성 쌍만 XPBD에 투입하는지 검증.

현재 결과: **단위 테스트 11개 + 브라우저 인수 검증 43개 통과.**

---

## API

전체 타입은 [`kite.d.ts`](./kite.d.ts)에 있습니다.

```ts
export function scene(container?: HTMLElement | string, options?: {
  width?: number; height?: number; seed?: number;
}): KiteScene;

export function $(
  strings: TemplateStringsArray,
  ...values: (SymExpr | number)[]
): SymExpr;

export function ensure(
  strings: TemplateStringsArray | SymExpr,
  ...values: (SymExpr | number)[]
): void;

export function encourage(/* ensure와 동일 */): void;

export const ops: {
  dist, norm, dot, vadd, vsub, vmul, vnormalize,
  contains, disjoint, overlapping
};
```

`KiteScene` 주요 메서드:

| 메서드 | 설명 |
| --- | --- |
| `type(name, ...supertypes)` | 비트마스크 다중 상속 도메인 타입 정의 |
| `predicate(name, argTypes)` | Substance 관계 정의. `P(a,b)`로 기록, `P.test(a,b)`로 질의 |
| `forall(selector, body)` | 선택자 카티션 곱(주입적: 서로 다른 슬롯은 서로 다른 인스턴스) |
| `forallWhere(selector, guard, body)` | 가드가 참인 조합만 실행 |
| `input({ name, init, optimized })` | 자유/고정 변수. `optimized: false` → 역질량 0 |
| `circle / line / rect / text` | SVG 도형. `drag: true`면 좌표가 자유 변수화 |
| `mount(container?)` | SVG + Blob Worker 생성, 렌더 루프 시작 |
| `step()` | 규칙 재실행 + 새 바이트코드/제약 증분 append |
| `getInput / setInput / subscribe` | 명명된 외부 상태 바인딩 |
| `destroy()` | RAF/Worker/SVG/이벤트 정리 |

진단용 확장(공개 API 계약 외): `scene.maxError`, `scene.converged`, `scene.frameCount`.

### Auto-Slacking 예시

```js
const c1 = s.circle({ center: [0, 0], r: 30, drag: true });

const c2 = s.circle({
  center: [$`${c1.center[0]} + 80`, c1.center[1]],
  r: 30,
  drag: true,
});
```

`c2.center[0]`은 `ADD` 노드이므로 엔진이 자유 변수 `u`를 만들고
`u - (c1.x + 80) == 0` 하드 제약을 자동 등록합니다. `c2.center[1]`은 이미 자유 변수이므로
그대로 재사용됩니다.

### `ops` 헬퍼의 부등식 방향

`contains`, `disjoint`, `overlapping`은 `SymExpr`에 자연스러운 부등식 방향 메타데이터를
붙입니다. 따라서 아래 두 형태가 모두 동작합니다.

```js
ensure(ops.contains(outer, inner, 8));          // C <= 0
ensure`${ops.contains(outer, inner, 8)} <= 0`;  // 동일
```

---

## `<kite-diagram>`

스크립트 로드 시 자동 등록되는 선언형 커스텀 엘리먼트입니다.

```html
<kite-diagram width="720" height="360">
  canvas 720 360
  orbit 0 0 118 16
  circle -235 88 38 fill=#fde68a stroke=#d97706
  text -235 88 "zero-build"
  line -160 88 -60 16 arrow
</kite-diagram>
```

지원 명령:

```
canvas W H
circle CX CY R [fill=...] [stroke=...] [strokeWidth=...] [drag]
rect CX CY W H [fill=...]
line X1 Y1 X2 Y2 [stroke=...] [arrow]
text CX CY "content" [fontSize=...] [fill=...]
orbit CX CY RADIUS PLANET_RADIUS
link X1 Y1 X2 Y2 DISTANCE
```

`#`로 시작하는 줄과 ` // ` 뒤는 주석입니다. 좌표계는 중심이 `(0,0)`이고 위쪽이 `+y`이며,
SVG 속성으로 변환할 때만 y축이 반전됩니다.

---

## 내부 구조

```
kite.js
 ├── Module 1  Tape & Autodiff Core
 │    Int32Array [opcode, arg1, arg2, aux] × NODE_STRIDE(4)
 │    CONST/VAR/ADD/SUB/MUL/DIV/NEG/POW2/SQRT/SIN/COS/MAX/MIN/ABS
 │    evalTape() + nodeDependencies() + reverse-mode backward()
 ├── Module 2  Pratt Parser & Tagged Template JIT
 │    토크나이저 → AST → WeakMap<TemplateStringsArray, AST> 캐시
 │    비교 연산자를 SUB 잔차로 정규화 (==, <=, >=)
 ├── Module 3  Inline Blob Worker & XPBD Solver
 │    function kiteWorkerMain() { ... } → Blob → Worker
 │    Stage 1: xorshift32 + 쿨롱 반발 + 후크 인력 + 15회 웜스타트
 │    Stage 2: 12 서브스텝 Gauss-Seidel, 람다 초기화, trust-region clamp(25px)
 │    소프트(α>0) → 하드(α=0) 정렬, INEQUALITY는 C>0일 때만 활성
 ├── Module 4  Scene / Domain / Substance / Style / SVG
 │    비트마스크 타입, 주입적 forall, 실행 시그니처 Set, Auto-Slacking
 │    소/대형 dirty check(1e-2px), y축 반전, 포인터 히트테스트/드래그
 └── Module 5  <kite-diagram> & Public Exports
```

### 솔버 노트

- XPBD 제약은 `C <= 0`으로 작성됩니다. 내부적으로 부등식은 `C' = -C >= 0`으로 취급해
  비음수 라그랑주 승수(`λ = max(0, λ + Δλ)`)와 일치시킵니다.
  덕분에 `contains`/`disjoint`가 위반 시 올바른 방향(내부로/외부로)으로 사영됩니다.
- 마우스 타깃은 프레임마다 갱신되는 **프레임 단위 소프트 제약**이므로
  `α̃_drag = α_drag / Δt²`로 정규화합니다(`α_drag = 1e-4`, 유한 컴플라이언스).
  서브스텝 타임스텝으로 정규화하면 K=12에서 유효 컴플라이언스가 52배 커져,
  여러 도형이 하드 제약으로 연결된 경우 포인터 추종이 지연됩니다.
- `disjoint` 쌍이 32개를 넘으면 `2·R_max` 균일 격자로 후보 쌍을 추출하고,
  각 서브스텝에서 활성 쌍만 XPBD 루프에 투입합니다(36개 원 · 630쌍 스트레스 테스트 포함).
- 단일 서브스텝 변위는 25px로 clamp되어 비선형 제약에서도 발산하지 않습니다.
- 수렴(`maxError < 1e-3`, 드래그 중 아님) 시 RAF 루프를 멈춰 CPU 점유율을 0에 가깝게 유지합니다.
  포인터 다운, `setInput`, `step()`이 루프를 즉시 깨웁니다.

### 설계상 한계

- JS 32-bit 비트 연산을 사용하므로 장면당 도메인 타입은 최대 30개입니다.
- `^` 거듭제곱은 정수 지수와 `0.5`만 지원합니다(테이프 opcode에 범용 POW가 없기 때문).
  동적 지수는 명시적 오류를 던집니다.
- SVG 렌더러는 circle / line(+arrow) / rect / text만 패치합니다.
- 레이아웃은 XPBD 위치 기반 솔버이며 속도/관성은 모델링하지 않습니다.

---

## Penrose 레퍼런스

- Trio 구조와 `forall ... where` 스타일 매칭: Penrose의 set-theory 예제
- `ensure` / `encourage`, autodiff 그래프, 제약 최적화: `packages/core/src/engine`
- Kite는 Penrose의 컴파일 파이프라인 대신 **평탄한 테이프 + 역방향 AD + XPBD**를 사용하며,
  브라우저 단일 파일에서 무헤더로 동작하도록 재설계했습니다.

---

## 파일

```
kite.js                  엔진 본체 (단일 ES 모듈)
kite.min.js              esbuild로 minify한 배포용 단일 파일
kite.d.ts                TypeScript 선언
index.html               인터랙티브 데모
tests/unit-node.mjs      DOM 없는 단위 테스트
tests/acceptance.html    RFC 4개 인수 시나리오
tests/run.mjs            Playwright 드라이버
scripts/serve.mjs        의존성 없는 정적 서버
```
