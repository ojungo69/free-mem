import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeJson } from "../schema/jcs.ts";

/**
 * JCS そのものを実装している以上、「JCS になっている」ことを見る test が要る。
 * RFC 8785 の本文と付録から、この harness が扱う部分集合に効く性質を取っている。
 */

test("object のキーは UTF-16 code unit の昇順で並ぶ（RFC 8785 §3.2.3）", () => {
  assert.equal(canonicalizeJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  // 大文字は小文字より前（ASCII の順序であって辞書順ではない）
  assert.equal(canonicalizeJson({ a: 1, B: 2 }), '{"B":2,"a":1}');
  // 非 ASCII も code unit 順。a(0x61) < é(0xE9) < ċ(0x10B) < €(0x20AC)
  assert.equal(
    canonicalizeJson({ "€": 1, "é": 2, a: 3, "ċ": 4 }),
    '{"a":3,"é":2,"ċ":4,"€":1}',
  );
  // ここが JCS の肝。**code point 順ではなく UTF-16 code unit 順**なので、
  // 代理対（U+10384 = 0xD800,0xDF84）は U+FB33 より前に来る。code point 順に
  // 並べる実装とはここで bytes が食い違う（RFC 8785 §3.2.3）
  assert.equal(
    canonicalizeJson({ "\u{10384}": 1, "\uFB33": 2 }),
    '{"\u{10384}":1,"\uFB33":2}',
  );
  // 入れ子も同じ規則
  assert.equal(canonicalizeJson({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
});

test("配列の順序は保持する（並べ替えは値の側の責任）", () => {
  assert.equal(canonicalizeJson([3, 1, 2]), "[3,1,2]");
  assert.equal(canonicalizeJson({ a: [{ b: 1, a: 2 }] }), '{"a":[{"a":2,"b":1}]}');
});

test("空白を入れず、文字列と数値は ECMAScript の表記に従う", () => {
  assert.equal(canonicalizeJson({ a: 1, b: [1, 2] }), '{"a":1,"b":[1,2]}');
  assert.equal(canonicalizeJson("a\nb"), '"a\\nb"');
  assert.equal(canonicalizeJson("é"), '"é"'); // 非 ASCII はエスケープしない
  assert.equal(canonicalizeJson(1e21), "1e+21");
  assert.equal(canonicalizeJson(0.1), "0.1");
  assert.equal(canonicalizeJson(-0), "0"); // JCS は -0 を 0 として出す
  assert.equal(canonicalizeJson(null), "null");
  assert.equal(canonicalizeJson(true), "true");
});

test("JSON に無い値は受け付けない", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -Number.POSITIVE_INFINITY]) {
    assert.throws(() => canonicalizeJson(bad), /非有限/);
  }
  assert.throws(() => canonicalizeJson(() => 1), /JSON に無い型/);
  assert.throws(() => canonicalizeJson(1n), /JSON に無い型/);
  // undefined の property は落とす（`JSON.stringify` と同じ扱い）
  assert.equal(canonicalizeJson({ a: 1, b: undefined }), '{"a":1}');
});

test("対になっていない代理は拒否する（RFC 8785 §3.2.2.2）", () => {
  // `JSON.stringify` は well-formed 化してエスケープを返すだけなので、そのままだと
  // 「TS では hash が出るが、準拠した実装は計算を拒否する」状態になる
  assert.equal(JSON.stringify("\ud800"), '"\\ud800"');
  for (const bad of ["\ud800", "a\udfff", "\ud800a", "\udc00\ud800"]) {
    assert.throws(() => canonicalizeJson(bad), /代理/, JSON.stringify(bad));
    assert.throws(() => canonicalizeJson({ [bad]: 1 }), /代理/, `key ${JSON.stringify(bad)}`);
    assert.throws(() => canonicalizeJson({ a: [bad] }), /代理/, `nested ${JSON.stringify(bad)}`);
  }
  // 正しい代理対は通る
  assert.equal(canonicalizeJson("\u{10384}"), '"\u{10384}"');
  assert.equal(canonicalizeJson({ "\u{10384}": 1 }), '{"\u{10384}":1}');
});

test("キー順が違うだけの object は同じ bytes になる", () => {
  const a = { x: 1, y: { p: 1, q: 2 }, z: [1, 2] };
  const b = { z: [1, 2], y: { q: 2, p: 1 }, x: 1 };
  assert.equal(canonicalizeJson(a), canonicalizeJson(b));
  // 配列の順序が違えば別物
  assert.notEqual(canonicalizeJson({ z: [1, 2] }), canonicalizeJson({ z: [2, 1] }));
});
