// notice ゲート自身のテスト。通す側だけでなく落とす側も測る——締めすぎた検査は自分のテストからは
// 漏れるし、緩すぎる検査は「通った」ことしか報告しないので、両方向を固定しないと意味が無い。
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  dependencyNames,
  inspectPackageDirectory,
  isDirectInvocation,
} from "./notice-inclusion-check.mjs";

// 実物の static notice は 47 件。件数そのものではなく「baseline と完全に一致すること」を
// 見る設計なので、fixture は代表的な数件で足りる。
const SERVER_STATIC = ["preact", "@radix-ui/react-dialog", "dompurify", "tslib", "marked"];

const BASELINE = {
  codemem: {
    "dist/THIRD_PARTY_NOTICES.md": [],
    "dist/THIRD_PARTY_NOTICES.hook-runtime.md": ["@codemem/core", "commander"],
  },
  "@codemem/core": { "dist/THIRD_PARTY_NOTICES.md": ["hono"] },
  "@codemem/mcp": { "dist/THIRD_PARTY_NOTICES.md": [] },
  "@codemem/server": {
    "dist/THIRD_PARTY_NOTICES.md": [],
    "static/THIRD_PARTY_NOTICES.md": [...SERVER_STATIC].sort(),
  },
};

function notice(dependencies) {
  if (dependencies.length === 0) {
    return "# Third-party notices\n\nNo third-party code is bundled in this artifact.\n";
  }
  const entries = dependencies.map(
    (dependency) => `<!-- codemem:dependency -->
## ${dependency}@1.0.0

- Name: \`${dependency}\`
- Version: \`1.0.0\`
- License: \`MIT\`

<!-- codemem:license-text -->
### License text

License for ${dependency}
<!-- codemem:end-license-text -->`,
  );
  return `# Third-party notices\n\n${entries.join("\n\n---\n\n")}\n`;
}

function writeNotice(packageDirectory, path, dependencies) {
  const file = join(packageDirectory, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, notice(dependencies));
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "notice-inclusion-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packages = {
    codemem: join(root, "codemem"),
    "@codemem/core": join(root, "core"),
    "@codemem/mcp": join(root, "mcp"),
    "@codemem/server": join(root, "server"),
  };
  for (const [name, directory] of Object.entries(packages)) {
    for (const [path, dependencies] of Object.entries(BASELINE[name])) {
      writeNotice(directory, path, dependencies);
    }
  }
  return packages;
}

function inspectAll(packages) {
  return Object.entries(packages).flatMap(
    ([name, directory]) => inspectPackageDirectory(name, directory, BASELINE).failures,
  );
}

test("正常な notice 一式を受理する", (t) => {
  assert.deepEqual(inspectAll(fixture(t)), []);
});

test("notice ファイルが無ければ拒否する", (t) => {
  const packages = fixture(t);
  unlinkSync(join(packages["@codemem/core"], "dist/THIRD_PARTY_NOTICES.md"));
  assert.ok(inspectAll(packages).some((failure) => failure.includes("missing dist/THIRD_PARTY_NOTICES.md")));
});

test("空の notice を拒否する", (t) => {
  const packages = fixture(t);
  writeFileSync(join(packages["@codemem/core"], "dist/THIRD_PARTY_NOTICES.md"), "");
  assert.ok(inspectAll(packages).some((failure) => failure.includes("is empty")));
});

// baseline と完全一致を見る理由がこの 2 件。名指しの数件だけを要求する形だと、名指ししていない
// 依存（`marked` など）が生成から落ちても通ってしまう。実測でその素通りを確認して切り替えた。
test("名指ししていない依存 1 件が欠けても拒否する", (t) => {
  const packages = fixture(t);
  writeNotice(
    packages["@codemem/server"],
    "static/THIRD_PARTY_NOTICES.md",
    SERVER_STATIC.filter((dependency) => dependency !== "marked"),
  );
  assert.ok(
    inspectAll(packages).some((failure) => failure.includes("missing bundled dependencies: marked")),
  );
});

test("hook-runtime notice から @codemem/core が欠ければ拒否する", (t) => {
  const packages = fixture(t);
  writeNotice(packages.codemem, "dist/THIRD_PARTY_NOTICES.hook-runtime.md", ["commander"]);
  assert.ok(
    inspectAll(packages).some((failure) =>
      failure.includes("missing bundled dependencies: @codemem/core"),
    ),
  );
});

test("baseline に無い依存が増えたら拒否する", (t) => {
  const packages = fixture(t);
  writeNotice(packages["@codemem/core"], "dist/THIRD_PARTY_NOTICES.md", ["hono", "surprise-dep"]);
  assert.ok(
    inspectAll(packages).some((failure) => failure.includes("not in the baseline: surprise-dep")),
  );
});

test("baseline に無い notice ファイルが増えたら拒否する", (t) => {
  const packages = fixture(t);
  writeNotice(packages["@codemem/core"], "dist/THIRD_PARTY_NOTICES.extra.md", ["hono"]);
  assert.ok(
    inspectAll(packages).some((failure) =>
      failure.includes("unexpected notice file dist/THIRD_PARTY_NOTICES.extra.md"),
    ),
  );
});

test("entry に license 本文欄が無ければ拒否する", (t) => {
  const packages = fixture(t);
  const file = join(packages["@codemem/core"], "dist/THIRD_PARTY_NOTICES.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("<!-- codemem:license-text -->", ""));
  assert.ok(inspectAll(packages).some((failure) => failure.includes("entries but 0 license text fields")));
});

test("license 本文欄はあるが中身が空なら拒否する", (t) => {
  const packages = fixture(t);
  const file = join(packages["@codemem/core"], "dist/THIRD_PARTY_NOTICES.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("License for hono\n", ""));
  assert.ok(
    inspectAll(packages).some((failure) => failure.includes("missing or empty license text body")),
  );
});

// 以下 2 件は「0 件だと宣言している側」の分岐。ここが効いていないと、生成が壊れて中身が
// 別物になった notice を 0 件として通してしまう（ファイルが空でさえなければ素通りする）。

test("0 件 package の notice が 0 件である旨を述べていなければ拒否する", (t) => {
  const packages = fixture(t);
  const file = join(packages["@codemem/mcp"], "dist/THIRD_PARTY_NOTICES.md");
  writeFileSync(file, "# Third-party notices\n\n以前の内容が消えた\n");
  assert.ok(
    inspectAll(packages).some((failure) =>
      failure.includes("does not state that no third-party code is bundled"),
    ),
  );
});

test("0 件のはずの package に entry が現れたら拒否する", (t) => {
  const packages = fixture(t);
  writeNotice(packages["@codemem/mcp"], "dist/THIRD_PARTY_NOTICES.md", ["hono"]);
  assert.ok(inspectAll(packages).some((failure) => failure.includes("not in the baseline: hono")));
});

test("baseline に項目が無い package を拒否する", (t) => {
  const packages = fixture(t);
  assert.ok(
    inspectPackageDirectory("@codemem/unknown", packages.codemem, BASELINE).failures.some((failure) =>
      failure.includes("no baseline entry"),
    ),
  );
});

test("依存名の抽出は Name 行だけを見る", () => {
  assert.deepEqual(dependencyNames(notice(["preact", "@radix-ui/react-dialog"])), [
    "@radix-ui/react-dialog",
    "preact",
  ]);
  assert.deepEqual(dependencyNames("見出しも本文も Name 行ではない\n## preact@1.0.0\n"), []);
});

// 起動経路の綴りが違うだけで main() が呼ばれないと、ゲートは「何も検査しなかった」ことを
// 成功として返す。symlink 経由でも直接起動と判定できることを固定する。
test("symlink 経由の起動でも直接起動と判定する", (t) => {
  const root = mkdtempSync(join(tmpdir(), "notice-entrypoint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, "real.mjs");
  const link = join(root, "link.mjs");
  writeFileSync(real, "export default 0;\n");
  symlinkSync(real, link);

  assert.equal(isDirectInvocation(link, pathToFileURL(real).href), true);
  assert.equal(isDirectInvocation(real, pathToFileURL(real).href), true);
  assert.equal(isDirectInvocation(join(root, "other.mjs"), pathToFileURL(real).href), false);
  assert.equal(isDirectInvocation(undefined, pathToFileURL(real).href), false);
});
