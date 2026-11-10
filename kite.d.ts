// Type definitions for Kite (RFC-0001)
// The runtime is the single self-contained ES module `kite.js`.

export type SymExpr = {
  readonly __kiteSym: true;
  readonly nodeId: number;
};

export type Vec2 = [SymExpr | number, SymExpr | number];

export interface DomainType<TProps = Record<string, any>> {
  readonly __kiteType: true;
  readonly name: string;
  readonly bitmask: number;
  (initialProps?: Partial<TProps>): SubstanceInstance<TProps>;
}

export type SubstanceInstance<TProps = Record<string, any>> = TProps & {
  readonly __kiteInstance: true;
  readonly id: number;
  readonly typeMask: number;
};

export interface PredicateDef<TArgs extends DomainType<any>[]> {
  readonly __kitePredicate: true;
  readonly name: string;
  readonly argTypes: TArgs;
  (...args: { [K in keyof TArgs]: SubstanceInstance<any> }): void;
  test(...args: SubstanceInstance<any>[]): boolean;
}

export interface InputOptions {
  name?: string;
  init?: number;
  /** false pins the variable (inverse mass w_i = 0). Default true. */
  optimized?: boolean;
}

/** Penrose-style color: channels in 0..1. */
export interface KiteColor {
  readonly __kiteColor: true;
  readonly none: boolean;
  readonly r?: number;
  readonly g?: number;
  readonly b?: number;
  readonly a?: number;
}
export type Color = string | KiteColor;

export function rgba(r: number, g: number, b: number, a?: number): KiteColor;
export function none(): KiteColor;

export interface ShapeCommonProps {
  fill?: Color;
  stroke?: Color;
  /** Penrose alias of fill. */
  fillColor?: Color;
  /** Penrose alias of stroke. */
  strokeColor?: Color;
  /** Inline CSS on the shape's <g>, e.g. "filter:blur(5px);". Lines also accept "dashed". */
  style?: string;
  strokeLinecap?: 'butt' | 'round' | 'square';
  strokeDasharray?: string | number;
  strokeWidth?: number | SymExpr;
  opacity?: number | SymExpr;
  layer?: number;
  drag?: boolean;
}

export interface CircleProps extends ShapeCommonProps {
  center?: Vec2;
  r?: number | SymExpr;
}

export interface LineProps extends ShapeCommonProps {
  start?: Vec2;
  end?: Vec2;
  arrowEnd?: boolean;
}

export interface RectProps extends ShapeCommonProps {
  center?: Vec2;
  width?: number | SymExpr;
  height?: number | SymExpr;
  cornerRadius?: number | SymExpr;
}

export interface EllipseProps extends ShapeCommonProps {
  center?: Vec2;
  rx?: number | SymExpr;
  ry?: number | SymExpr;
}

export interface ImageProps extends ShapeCommonProps {
  href: string;
  center?: Vec2;
  width?: number | SymExpr;
  height?: number | SymExpr;
  preserveAspectRatio?: string;
}

export interface GroupProps extends ShapeCommonProps {
  shapes: ShapeHandle[];
}

export interface TextProps extends ShapeCommonProps {
  center?: Vec2;
  string: string;
  fontSize?: number | string | SymExpr;
  fontFamily?: string;
  fontWeight?: string | number;
}

/** Equation supports a TeX subset: _ ^ {…} \\frac \\mathrm and Greek letters. */
export type EquationProps = TextProps;

export type OverrideProps = Partial<{
  fill: Color; fillColor: Color; stroke: Color; strokeColor: Color;
  strokeWidth: number | SymExpr; opacity: number | SymExpr; layer: number;
  style: string; strokeLinecap: string | null; strokeDasharray: string | null;
  r: number | SymExpr; rx: number | SymExpr; ry: number | SymExpr;
  width: number | SymExpr; height: number | SymExpr; cornerRadius: number | SymExpr;
  fontSize: number | string | SymExpr; fontFamily: string | null; fontWeight: string | null;
  string: string; href: string;
}>;

export interface ShapeHandle extends ShapeCommonProps {
  readonly shapeId: number;
}

export interface KiteScene {
  // Domain API
  type<TProps = Record<string, any>>(name: string, ...supertypes: DomainType<any>[]): DomainType<TProps>;
  predicate<TArgs extends DomainType<any>[]>(name: string, argTypes: [...TArgs]): PredicateDef<TArgs>;

  // Style & selector API
  forall<TSel extends Record<string, DomainType<any>>>(
    selector: TSel,
    body: (matched: { [K in keyof TSel]: SubstanceInstance<any> }) => void,
  ): void;
  forallWhere<TSel extends Record<string, DomainType<any>>>(
    selector: TSel,
    guard: (matched: { [K in keyof TSel]: SubstanceInstance<any> }) => boolean,
    body: (matched: { [K in keyof TSel]: SubstanceInstance<any> }) => void,
  ): void;

  // Variables & shapes
  input(options?: InputOptions): SymExpr;
  circle(props?: CircleProps): Required<CircleProps> & ShapeHandle;
  line(props?: LineProps): Required<LineProps> & ShapeHandle;
  rect(props?: RectProps): Required<RectProps> & ShapeHandle;
  text(props: TextProps): Required<TextProps> & ShapeHandle;
  ellipse(props?: EllipseProps): Required<EllipseProps> & ShapeHandle;
  image(props: ImageProps): Required<ImageProps> & ShapeHandle;
  equation(props: EquationProps): Required<EquationProps> & ShapeHandle;
  group(props: GroupProps): ShapeHandle & { shapes: ShapeHandle[] };

  /** Replace style or geometry of an existing shape (Penrose `override`). */
  override<T extends ShapeHandle>(shape: T, props: OverrideProps): T;
  /**
   * Penrose `collect T x into xs { … }`: run `body` once with every match
   * projected through `project`; re-runs on step() when the match set grows.
   */
  collect<T>(
    type: DomainType<any>,
    project: (inst: SubstanceInstance<any>) => T | null | undefined,
    body: (items: T[]) => void,
  ): void;

  // Lifecycle & external state
  mount(container?: HTMLElement | string): Promise<void>;
  /** Re-run pattern matching and append newly generated bytecode incrementally. */
  step(): void;
  getInput(name: string): number;
  setInput(name: string, value: number): void;
  subscribe(name: string, callback: (val: number) => void): () => void;
  destroy(): void;

  // Diagnostics (RFC acceptance tests use these)
  readonly maxError: number;
  readonly converged: boolean;
  readonly frameCount: number;
}

export interface SceneOptions {
  width?: number;
  height?: number;
  seed?: number;
}

export function scene(container?: HTMLElement | string, options?: SceneOptions): KiteScene;

export function $(strings: TemplateStringsArray, ...values: (SymExpr | number)[]): SymExpr;

export function ensure(strings: TemplateStringsArray | SymExpr, ...values: (SymExpr | number)[]): void;
export function encourage(strings: TemplateStringsArray | SymExpr, ...values: (SymExpr | number)[]): void;

export interface CircleRef {
  center: Vec2;
  r: SymExpr | number;
}

export const ops: {
  dist(p: Vec2, q: Vec2): SymExpr;
  norm(v: Vec2): SymExpr;
  dot(u: Vec2, v: Vec2): SymExpr;
  vadd(u: Vec2, v: Vec2): Vec2;
  vsub(u: Vec2, v: Vec2): Vec2;
  vmul(s: SymExpr | number, v: Vec2): Vec2;
  vnormalize(v: Vec2): Vec2;
  normsq(v: Vec2): SymExpr;
  distsq(p: Vec2, q: Vec2): SymExpr;
  cross(u: Vec2, v: Vec2): SymExpr;
  rot90(v: Vec2): Vec2;
  /** Unsigned angle in [0, π] via atan2(|u×v|, u·v). */
  angleBetween(u: Vec2, v: Vec2): SymExpr;
  /** Signed angle from u to v in (-π, π]. */
  angleFrom(u: Vec2, v: Vec2): SymExpr;
  atan2(y: SymExpr | number, x: SymExpr | number): SymExpr;
  toRadians<T extends SymExpr | number>(deg: T): T;
  toDegrees<T extends SymExpr | number>(rad: T): T;
  /** Penrose equal(a, b) → residual a − b for ensure()/encourage(). */
  equal(a: SymExpr | number, b: SymExpr | number): SymExpr;
  contains(outerCircle: CircleRef, innerCircle: CircleRef, padding?: number | SymExpr): SymExpr;
  disjoint(c1: CircleRef, c2: CircleRef, padding?: number | SymExpr): SymExpr;
  overlapping(c1: CircleRef, c2: CircleRef, overlap?: number | SymExpr): SymExpr;
};

export const Op: Readonly<{
  CONST: 0;
  VAR: 1;
  ADD: 2;
  SUB: 3;
  MUL: 4;
  DIV: 5;
  NEG: 6;
  POW2: 7;
  SQRT: 8;
  SIN: 9;
  COS: 10;
  MAX: 11;
  MIN: 12;
  ABS: 13;
  ATAN2: 14;
}>;

export const ConstraintKind: Readonly<{
  EQUALITY: 0;
  INEQUALITY: 1;
}>;

export class KiteDiagramElement extends HTMLElement {}

declare const Kite: {
  scene: typeof scene;
  $: typeof $;
  ensure: typeof ensure;
  encourage: typeof encourage;
  ops: typeof ops;
  rgba: typeof rgba;
  none: typeof none;
  Op: typeof Op;
  ConstraintKind: typeof ConstraintKind;
  KiteDiagramElement: typeof KiteDiagramElement;
};

export default Kite;
