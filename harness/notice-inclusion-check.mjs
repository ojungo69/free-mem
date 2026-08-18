#!/usr/bin/env node
// 公開 tarball に、bundle された第三者コードの notice が載っているかを検査する。
//
// build 済みかどうかで分岐しない。自分で install と build と pack を行い、実際の tarball の
// 中身だけを見る。「build 済みなら検査する」形にすると、build 順序に依存して黙って素通りする。
//
// 期待する依存名は harness/notice-baseline.json に**完全な集合として**固定してある。名指しの
// 数件だけを要求する形は採らない: 生成が部分的に退行して他が落ちても通ってしまうため（実測で
// `marked` 1 件の欠落が素通りすることを確認済み）。依存が正当に増減したときは
// `--write-baseline` で再生成し、その差分を commit に載せてレビューする
// （harness/contract-hashes.json と同じ運用）。
//
// usage:
//   node harness/notice-inclusion-check.mjs                  # 検査
//   node harness/notice-inclusion-check.mjs --write-baseline # baseline を再生成

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const NO_BUNDLED_DEPENDENCIES = "No third-party code is bundled in this artifact.";
const ENTRY_MARKER = "<!-- codemem:dependency -->";
const LICENSE_MARKER = "<!-- codemem:license-text -->";
const LICENSE_END_MARKER = "<!-- codemem:end-license-text -->";
const NOTICE_FILE_PATTERN = /^THIRD_PARTY_NOTICES.*\.md$/;

const PACKAGES = [
  { name: "codemem", directory: "packages/cli" },
  { name: "@codemem/core", directory: "packages/core" },
  { name: "@codemem/mcp", directory: "packages/mcp-server" },
  { name: "@codemem/server", directory: "packages/viewer-server" },
  // rollup build を通らない（成果物が git に commit 済み）ため、module graph 由来の notice を
  // 作れない。実測では第三者コードを含まないので検査対象は無いが、「検討して対象外にした」ことを
  // 残すために一覧には置く。詳細は evidence/adr-004-licensing.md。
  { name: "@codemem/opencode-plugin", directory: "packages/opencode-plugin", exempt: true },
];

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = join(repositoryRoot, "vendor", "codemem");
const baselinePath = join(repositoryRoot, "harness", "notice-baseline.json");

function licenseBodies(text) {
  const bodies = [];
  let cursor = 0;
  while (true) {
    const start = text.indexOf(LICENSE_MARKER, cursor);
    if (start === -1) break;
    const bodyStart = text.indexOf("\n\n", start + LICENSE_MARKER.length);
    const end = text.indexOf(LICENSE_END_MARKER, start + LICENSE_MARKER.length);
    if (bodyStart === -1 || end === -1 || bodyStart >= end) break;
    bodies.push(text.slice(bodyStart + 2, end).trim());
    cursor = end + LICENSE_END_MARKER.length;
  }
  return bodies;
}

export function dependencyNames(text) {
  return [...text.matchAll(/^- Name: `([^`]+)`$/gm)].map((match) => match[1]).sort();
}

// tarball を展開したディレクトリから notice ファイルを見つける。baseline との突き合わせで
// 「増えた」も「消えた」も落とすため、検査側で列挙する対象は baseline ではなく実物にする。
export function findNoticeFiles(packageDirectory) {
  const found = [];
  const walk = (directory, prefix) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else if (NOTICE_FILE_PATTERN.test(entry.name)) found.push(relative);
    }
  };
  walk(packageDirectory, "");
  return found.sort();
}

export function inspectPackageDirectory(packageName, packageDirectory, baseline) {
  const expected = baseline[packageName];
  if (!expected) return { failures: [`${packageName}: no baseline entry`], counts: [] };

  const failures = [];
  const counts = [];
  const found = findNoticeFiles(packageDirectory);
  const expectedPaths = Object.keys(expected).sort();

  for (const path of expectedPaths) {
    if (!found.includes(path)) failures.push(`${packageName}: missing ${path}`);
  }
  for (const path of found) {
    if (!expectedPaths.includes(path)) {
      failures.push(`${packageName}: unexpected notice file ${path} (regenerate the baseline)`);
    }
  }

  for (const path of expectedPaths) {
    if (!found.includes(path)) continue;
    const text = readFileSync(join(packageDirectory, ...path.split("/")), "utf8");
    if (text.trim() === "") {
      failures.push(`${packageName}: ${path} is empty`);
      continue;
    }

    const entryCount = text.split(ENTRY_MARKER).length - 1;
    const licenseCount = text.split(LICENSE_MARKER).length - 1;
    const bodies = licenseBodies(text);
    counts.push({ packageName, path, entries: entryCount });

    if (entryCount !== licenseCount) {
      failures.push(
        `${packageName}: ${path} has ${entryCount} entries but ${licenseCount} license text fields`,
      );
    }
    if (bodies.length !== licenseCount || bodies.some((body) => body === "")) {
      failures.push(`${packageName}: ${path} has a missing or empty license text body`);
    }

    // 0 件の成果物にもファイルを出し、「bundle されていない」と明記させる。ファイルが無いことを
    // 0 件と読む形にすると、生成が壊れた場合と区別できない。
    if (expected[path].length === 0 && !text.includes(NO_BUNDLED_DEPENDENCIES)) {
      failures.push(`${packageName}: ${path} does not state that no third-party code is bundled`);
    }

    const actual = dependencyNames(text);
    const missing = expected[path].filter((name) => !actual.includes(name));
    const added = actual.filter((name) => !expected[path].includes(name));
    if (missing.length > 0) {
      failures.push(`${packageName}: ${path} is missing bundled dependencies: ${missing.join(", ")}`);
    }
    if (added.length > 0) {
      failures.push(
        `${packageName}: ${path} has dependencies not in the baseline: ${added.join(", ")} (regenerate the baseline)`,
      );
    }
    if (actual.length !== entryCount) {
      failures.push(`${packageName}: ${path} has ${entryCount} entries but ${actual.length} name fields`);
    }
  }

  return { failures, counts };
}

function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

function pack(packageSpec, temporaryRoot) {
  const packageTemp = join(temporaryRoot, packageSpec.name.replaceAll(/[@/]/g, "_"));
  const tarballDirectory = join(packageTemp, "tarball");
  const extractDirectory = join(packageTemp, "extract");
  mkdirSync(tarballDirectory, { recursive: true });
  mkdirSync(extractDirectory, { recursive: true });

  run(
    "corepack",
    ["pnpm", "pack", "--pack-destination", tarballDirectory],
    join(vendorRoot, packageSpec.directory),
  );
  const tarballs = readdirSync(tarballDirectory).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`${packageSpec.name}: expected one tarball, found ${tarballs.length}`);
  }
  run("tar", ["-xzf", join(tarballDirectory, tarballs[0]), "-C", extractDirectory], repositoryRoot);

  const packageDirectory = join(extractDirectory, "package");
  if (!existsSync(packageDirectory)) throw new Error(`${packageSpec.name}: tarball has no package/ directory`);
  return packageDirectory;
}

function buildAndPack(temporaryRoot, baseline) {
  run("corepack", ["pnpm", "install", "--frozen-lockfile"], vendorRoot);

  // build 前に検査対象の notice を消す。viewer-server/static は emptyOutDir: false なので、
  // 生成が止まっても前回のファイルが残り、古い内容をこの検査が受理してしまう——塞ごうとしている
  // fail-open そのものが検査側に生える。消してから build すれば、生成が止まった回は missing で落ちる。
  // clean checkout の CI では起きないが、同じ作業ツリーで繰り返す release preflight では起きる。
  for (const packageSpec of PACKAGES) {
    for (const path of Object.keys(baseline[packageSpec.name] ?? {})) {
      rmSync(join(vendorRoot, packageSpec.directory, ...path.split("/")), { force: true });
    }
  }

  run("corepack", ["pnpm", "-r", "run", "build"], vendorRoot);

  const packed = [];
  for (const packageSpec of PACKAGES) {
    if (packageSpec.exempt) continue;
    packed.push({ spec: packageSpec, directory: pack(packageSpec, temporaryRoot) });
  }
  return packed;
}

function writeBaseline() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "codemem-notices-"));
  try {
    // 存在確認してから読む形にしない（check-then-use になり、CodeQL の js/file-system-race に当たる）。
    // 初回生成時は baseline がまだ無いので、読めなければ空で進める——build 前に消す対象が無いだけ。
    let current = {};
    try {
      current = JSON.parse(readFileSync(baselinePath, "utf8"));
    } catch {
      current = {};
    }
    const packed = buildAndPack(temporaryRoot, current);
    const baseline = {};
    for (const { spec, directory } of packed) {
      baseline[spec.name] = {};
      for (const path of findNoticeFiles(directory)) {
        baseline[spec.name][path] = dependencyNames(
          readFileSync(join(directory, ...path.split("/")), "utf8"),
        );
      }
    }
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`baseline written: ${baselinePath}`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function main() {
  if (process.argv.includes("--write-baseline")) {
    writeBaseline();
    return;
  }

  const failures = [];
  const counts = [];
  const temporaryRoot = mkdtempSync(join(tmpdir(), "codemem-notices-"));

  try {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    for (const packageSpec of PACKAGES) {
      if (packageSpec.exempt) continue;
      if (!baseline[packageSpec.name]) failures.push(`${packageSpec.name}: no baseline entry`);
    }

    for (const { spec, directory } of buildAndPack(temporaryRoot, baseline)) {
      const result = inspectPackageDirectory(spec.name, directory, baseline);
      failures.push(...result.failures);
      counts.push(...result.counts);
    }
  } catch (error) {
    failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  for (const notice of counts) {
    console.log(`${notice.packageName} ${notice.path}: ${notice.entries} entries`);
  }

  if (failures.length > 0) {
    console.error("third-party notice inclusion check FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error("依存が正当に増減したなら --write-baseline で再生成し、差分を commit に載せること。");
    process.exitCode = 1;
    return;
  }
  console.log("third-party notice inclusion check OK");
}

// 直接起動されたかどうかの判定。両側を realpath に落としてから比べる: `import.meta.url` は Node が
// 実体パスへ正規化するのに対し `process.argv[1]` は起動時の綴りのままなので、symlink を挟んだ経路で
// 起動すると一致せず、main() を呼ばないまま exit 0 で終わる。
//
// `import.meta.main` にも置き換えないこと。あれは Node 24.2 で入ったので、engines の `>=24` を
// 満たす 24.0 / 24.1 では undefined になり、同じく main() を呼ばない。
//
// どちらの取り違えも「検査した」と「検査しなかった」の区別を消す = ゲートとしては fail-open。
export function isDirectInvocation(argv1, moduleUrl) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url)) main();
