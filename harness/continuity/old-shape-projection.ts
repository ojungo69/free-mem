/**
 * 旧形入力（新しい任意欄を 1 つも持たない状態と event）に対する**振る舞い**の比較面。
 *
 * SC-003 は「旧形の入力に対する結果は #35 / #39 / #43 / #44 の是正以外変わらない」と言うが、
 * 「変わらない」を行数や issue 番号で語ると検証できない主張になる（測ってから書く）。ここでは
 * 比較面を構造から導く: 還元結果の**全体**から、内容が変われば必ず変わる hash 2 つ
 * （`contentHash` と `stateRevision`）だけを外し、残りを丸ごと突き合わせる。
 *
 * hash を外す理由は、#35 が `startIngestSeq` を、#43 が `droppedEvidence` を状態に書くため、
 * hash は**旧形入力でも全 event で必ず食い違う**から。両者を比較面に残すと差分が全件になり、
 * allowlist が「全部許す」に退化して門にならない。hash 自体の再現性は
 * `harness/contract-hashes.json` と parity fixture が別に見ている。
 *
 * 逆に、新しい任意欄そのものは比較面に**残す**。欄が現れたことを差分として見せ、
 * どの case のどの event でどの path が増えたかを allowlist に列挙させるのが門の目的。
 */
export interface OldShapeOutcomeV1 {
  outcome: string;
  diagnostics: readonly string[];
  historyLength: number;
  ledgerSize: number;
  /** `stateRevision` を除いた状態そのもの。新しい任意欄は差分として見えるよう残す */
  state: Record<string, unknown>;
}

export interface OldShapeStepInput {
  outcome: string;
  diagnostics: readonly { readonly code: string }[];
  state: Record<string, unknown>;
  historyLength: number;
  ledgerSize: number;
}

export function projectOldShape(step: OldShapeStepInput): OldShapeOutcomeV1 {
  const { stateRevision: _dropped, ...state } = step.state;
  return {
    outcome: step.outcome,
    diagnostics: step.diagnostics.map((d) => d.code),
    historyLength: step.historyLength,
    ledgerSize: step.ledgerSize,
    state,
  };
}

/**
 * 2 つの projection が食い違う JSON path を列挙する。allowlist は issue 番号ではなく
 * **この path** で書く（「#43 の分は許す」では、#43 が新しく作る経路を数え落としても気づけない）。
 */
export function diffPaths(before: unknown, after: unknown, path = ""): string[] {
  if (Object.is(before, after)) return [];
  const bothArrays = Array.isArray(before) && Array.isArray(after);
  const bothObjects = isPlainObject(before) && isPlainObject(after);
  if (!bothArrays && !bothObjects) return [path === "" ? "." : path];
  if (bothArrays) {
    const paths: string[] = [];
    for (let i = 0; i < Math.max(before.length, after.length); i += 1) {
      paths.push(...diffPaths(before[i], after[i], `${path}[${i}]`));
    }
    return paths;
  }
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
    paths.push(...diffPaths(b[key], a[key], path === "" ? key : `${path}.${key}`));
  }
  return paths;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `diffPaths` が返す形の path を辿る。allowlist が「差分の中身」まで固定するために使う */
export function valueAtPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const token of path.split(".")) {
    const [key, ...indices] = token.split("[");
    if (key !== "") {
      if (!isPlainObject(current)) return undefined;
      current = current[key];
    }
    for (const index of indices) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number.parseInt(index, 10)];
    }
  }
  return current;
}
