// rig が取った観測記録を証拠置き場へ byte 同一で持ち込み、run の素性を manifest として書く。
//
// digest は持ち込んだ**後**の byte から取る。持ち込む前に取ると、持ち込みで内容が変わっても
// 気づけない。byte 同一そのものは複製直後の突き合わせで別に見る。
// SHA-256 は harness/evidence/normalize.ts の実装だけを使う（sha256sum を別に呼ばない）。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NORMALIZATION_VERSION, digestCapture, digestRaw } from "../evidence/normalize.ts";
import { MANIFEST_VERSION } from "../evidence/verify.ts";

const KNOWN_CLIS = new Set(["claude", "codex"]);
const SCENARIO_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PRINTABLE = /^[\x20-\x7e]+$/;

const die = (msg) => {
  console.error(`import-evidence: ${msg}`);
  process.exit(2);
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--") || argv[i + 1] === undefined) die(`bad argument: ${key}`);
    out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

/** `.version` は単一行として読む。複数行を返す CLI は黙って 1 行目を採らずに失敗させる */
function readCliVersion(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    die(`cannot read the version file: ${basename(path)}`);
  }
  const line = text.replace(/\r?\n$/, "");
  if (line.includes("\n")) die("the CLI printed more than one line for --version");
  if (!PRINTABLE.test(line)) die("the CLI version is empty or not printable ASCII");
  return line;
}

function readExitStatus(path) {
  let text;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    die("the run did not record an exit status");
  }
  if (!/^\d+$/.test(text)) die("the recorded exit status is not a non-negative integer");
  return Number(text);
}

const args = parseArgs(process.argv.slice(2));
const cli = args.cli;
const label = args.label;
const scenarioId = args["scenario-id"];
if (!KNOWN_CLIS.has(cli)) die("--cli must be claude or codex");
if (!LABEL.test(label ?? "")) die("--label must be a plain file-name token");
if (!SCENARIO_ID.test(scenarioId ?? "")) die("--scenario-id does not match the schema pattern");
if (!args.from) die("--from is required");

const stem = `${cli}-${label}`;
const source = join(args.from, `${stem}.jsonl`);
// 置き場は module からの相対で固定する。差し替え口は作らない（test は harness ごと複製する）
const destDir = join(fileURLToPath(new URL("../fixtures/", import.meta.url)), cli, "raw");
const dest = join(destDir, `${stem}.jsonl`);
const manifestPath = join(destDir, `${stem}.manifest.json`);

if (!existsSync(source)) die(`no capture at ${stem}.jsonl`);
mkdirSync(destDir, { recursive: true });
copyFileSync(source, dest);
if (!readFileSync(source).equals(readFileSync(dest))) die("the copy is not byte-identical to the capture");

const bytes = readFileSync(dest);
const captureRawHash = digestRaw(bytes);
const captureHash = digestCapture(bytes);

const errorsFile = `${source}.errors`;
const recorderErrors = existsSync(errorsFile)
  ? readFileSync(errorsFile, "utf8").split("\n").filter((l) => l.trim() !== "").length
  : 0;

const manifest = {
  manifestVersion: MANIFEST_VERSION,
  cli,
  cliVersion: readCliVersion(join(args.from, `${stem}.version`)),
  scenarioId,
  isolated: true,
  internalRunMarker: true,
  exitStatus: readExitStatus(join(args.from, `${stem}.exit`)),
  recorderErrors,
  capture: basename(dest),
  captureRawHash,
  captureHash,
  normalizationVersion: NORMALIZATION_VERSION,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// fixture の evidence[] へそのまま貼れる形で出す（digest を手で写させない）
process.stdout.write(
  `${JSON.stringify(
    {
      path: basename(dest),
      evidenceHash: captureHash,
      captureRawHash,
      normalizationVersion: NORMALIZATION_VERSION,
      manifest: basename(manifestPath),
      manifestHash: digestRaw(readFileSync(manifestPath)),
    },
    null,
    2,
  )}\n`,
);
