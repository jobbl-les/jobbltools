const test = require("node:test");
const assert = require("node:assert/strict");
const PatternLib = require("./pattern-lib.js");

// ---------------------------------------------------------------------
// splitLines
// ---------------------------------------------------------------------

test("splitLines drops the trailing blank line from a final newline", () => {
  const { lines } = PatternLib.splitLines("abc\ndef\n");
  assert.deepEqual(lines, ["abc", "def"]);
});

test("splitLines handles CRLF and bare CR line endings", () => {
  const { lines } = PatternLib.splitLines("a\r\nb\rc");
  assert.deepEqual(lines, ["a", "b", "c"]);
});

test("splitLines trims whitespace by default and can be told not to", () => {
  assert.deepEqual(PatternLib.splitLines("  a  \n b ").lines, ["a", "b"]);
  assert.deepEqual(PatternLib.splitLines("  a  \n b ", { trim: false }).lines, ["  a  ", " b "]);
});

test("splitLines keeps blank lines when ignoreBlank is false", () => {
  const { lines } = PatternLib.splitLines("a\n\nb", { ignoreBlank: false });
  assert.deepEqual(lines, ["a", "", "b"]);
});

test("splitLines tracks original 1-based line numbers alongside kept lines", () => {
  const { lines, lineNumbers } = PatternLib.splitLines("a\n\nb\n");
  assert.deepEqual(lines, ["a", "b"]);
  assert.deepEqual(lineNumbers, [1, 3]);
});

// ---------------------------------------------------------------------
// commonPrefix / commonSuffix
// ---------------------------------------------------------------------

test("commonPrefix finds the shared leading substring", () => {
  assert.equal(PatternLib.commonPrefix(["INV-0001", "INV-0002", "INV-9999"]), "INV-");
  assert.equal(PatternLib.commonPrefix(["INV-0001", "INV-0002"]), "INV-000");
});

test("commonPrefix is empty when lines share nothing", () => {
  assert.equal(PatternLib.commonPrefix(["abc", "xyz"]), "");
});

test("commonSuffix caps itself so it never overlaps the prefix on a short line", () => {
  // Every line is just "a" — a naive independent prefix/suffix computation
  // would claim "a" for both against a 1-character budget.
  const prefix = PatternLib.commonPrefix(["a", "a", "a"]);
  const suffix = PatternLib.commonSuffix(["a", "a", "a"], prefix.length);
  assert.equal(prefix, "a");
  assert.equal(suffix, "");
});

test("commonSuffix finds the shared trailing substring", () => {
  const lines = ["file-001.csv", "file-042.csv", "file-999.csv"];
  const prefix = PatternLib.commonPrefix(lines);
  const suffix = PatternLib.commonSuffix(lines, prefix.length);
  // "file-999.csv" diverges from the others right at the leading digit, so
  // the shared prefix stops at "file-" (not "file-0").
  assert.equal(prefix, "file-");
  assert.equal(suffix, ".csv");
});

// ---------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------

test("analyze reports fixed length and per-position char sets for equal-length lines", () => {
  const stats = PatternLib.analyze(["AB12", "AB99", "CD34"]);
  assert.equal(stats.fixedLength, true);
  assert.equal(stats.minLen, 4);
  assert.equal(stats.maxLen, 4);
  assert.deepEqual(stats.positions.map(p => p.chars), [
    ["A", "C"], ["B", "D"], ["1", "3", "9"], ["2", "4", "9"]
  ]);
});

test("analyze reports variable length and no positions for unequal-length lines", () => {
  const stats = PatternLib.analyze(["ab", "abc", "a"]);
  assert.equal(stats.fixedLength, false);
  assert.equal(stats.minLen, 1);
  assert.equal(stats.maxLen, 3);
  assert.equal(stats.positions, null);
});

test("analyze classifies digit/lower/upper/other and collects the distinct 'other' chars", () => {
  const stats = PatternLib.analyze(["a1_B-", "c2_D-"]);
  assert.deepEqual(stats.classes, { digit: true, lower: true, upper: true, other: true });
  assert.deepEqual(stats.otherChars, ["-", "_"]);
});

test("analyze on an empty line list returns zeroed-out stats rather than throwing", () => {
  const stats = PatternLib.analyze([]);
  assert.equal(stats.count, 0);
  assert.equal(stats.fixedLength, false);
  assert.equal(stats.positions, null);
});

// ---------------------------------------------------------------------
// classifyCharSet
// ---------------------------------------------------------------------

test("classifyCharSet uses shorthand classes only when the set exactly fills them", () => {
  assert.equal(PatternLib.classifyCharSet("0123456789".split("")), "\\d");
  assert.equal(PatternLib.classifyCharSet("abcdefghijklmnopqrstuvwxyz".split("")), "[a-z]");
  assert.equal(PatternLib.classifyCharSet("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")), "[A-Z]");
});

test("classifyCharSet falls back to an explicit class for a partial digit set", () => {
  // Only these three digits were ever observed — \d would silently accept
  // seven digits nothing in the sample data ever used.
  assert.equal(PatternLib.classifyCharSet(["1", "3", "9"]), "[139]");
});

test("classifyCharSet returns a bare literal for a single-character set", () => {
  assert.equal(PatternLib.classifyCharSet(["x"]), "x");
});

test("classifyCharSet escapes regex-special and class-special characters", () => {
  assert.equal(PatternLib.classifyCharSet(["."]), "\\.");
  assert.equal(PatternLib.classifyCharSet(["-", "]", "^", "\\"]), "[\\-\\]\\^\\\\]");
});

// ---------------------------------------------------------------------
// collapseTokens
// ---------------------------------------------------------------------

test("collapseTokens merges consecutive identical tokens into a quantifier", () => {
  assert.equal(PatternLib.collapseTokens(["\\d", "\\d", "\\d", "\\d"]), "\\d{4}");
  assert.equal(PatternLib.collapseTokens(["A", "\\d", "\\d"]), "A\\d{2}");
});

// ---------------------------------------------------------------------
// buildRegex
// ---------------------------------------------------------------------

test("buildRegex in positional mode builds a per-position pattern for equal-length lines", () => {
  const { pattern, mode } = PatternLib.buildRegex(["AB12", "AB99", "CD34"]);
  assert.equal(mode, "positional");
  // Position 0 only ever saw A/C (never B) and position 1 only ever saw
  // B/D (never C) — a contiguous "A-C"/"B-D" range would be looser than
  // the data justifies, so the tight explicit sets are expected here.
  assert.equal(pattern, "^[AC][BD][139][249]$");
  for (const line of ["AB12", "AB99", "CD34"]) {
    assert.match(line, new RegExp(pattern));
  }
  assert.doesNotMatch("BB12", new RegExp(pattern));
});

test("buildRegex refuses positional mode for unequal-length lines", () => {
  const result = PatternLib.buildRegex(["ab", "abc"], { mode: "positional" });
  assert.ok(result.error);
});

test("buildRegex in charset mode builds a prefix/suffix + bounded middle for variable-length lines", () => {
  const lines = ["file-001.csv", "file-042.csv", "file-9999.csv"];
  const { pattern, mode } = PatternLib.buildRegex(lines, { mode: "charset" });
  assert.equal(mode, "charset");
  for (const line of lines) assert.match(line, new RegExp(pattern));
  // Tight enough to reject a non-numeric or over-long middle section.
  assert.doesNotMatch("file-abc.csv", new RegExp(pattern));
  assert.doesNotMatch("file-00000001.csv", new RegExp(pattern));
});

test("buildRegex returns an error for an empty line list", () => {
  const result = PatternLib.buildRegex([]);
  assert.ok(result.error);
});

test("buildRegex respects anchor:false", () => {
  const { pattern } = PatternLib.buildRegex(["ab", "ab"], { anchor: false });
  assert.equal(pattern.startsWith("^"), false);
  assert.equal(pattern.endsWith("$"), false);
});

test("buildRegex handles a single distinct repeated character with varying length in charset mode", () => {
  // The common-prefix step consumes one leading "a" first, then the
  // variable middle covers the rest (0-2 more) — functionally equivalent
  // to "a{1,3}" (matches 1-3 a's) even though it isn't written minimally.
  const { pattern } = PatternLib.buildRegex(["aa", "aaa", "a"], { mode: "charset" });
  assert.equal(pattern, "^aa{0,2}$");
  for (const line of ["a", "aa", "aaa"]) assert.match(line, new RegExp(pattern));
  assert.doesNotMatch("aaaa", new RegExp(pattern));
});

// ---------------------------------------------------------------------
// testPattern
// ---------------------------------------------------------------------

test("testPattern reports match counts and the failing lines", () => {
  const result = PatternLib.testPattern("^\\d{3}$", "", ["123", "45", "999"]);
  assert.equal(result.ok, true);
  assert.equal(result.matched, 2);
  assert.deepEqual(result.failed.map(f => f.line), ["45"]);
});

test("testPattern returns ok:false with a message for an invalid pattern", () => {
  const result = PatternLib.testPattern("(unclosed", "", ["abc"]);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("testPattern isn't fooled by a stateful 'g' flag across repeated lines", () => {
  // Without resetting lastIndex before each .test() call, a global flag
  // would make alternating lines fail to match even though each one does.
  const result = PatternLib.testPattern("\\d+", "g", ["1", "2", "3", "4"]);
  assert.equal(result.matched, 4);
});

// ---------------------------------------------------------------------
// looseness
// ---------------------------------------------------------------------

test("looseness flags an unanchored pattern", () => {
  assert.ok(PatternLib.looseness("\\d{3}").some(w => /anchored/.test(w)));
});

test("looseness flags .* / .+ but not an escaped dot", () => {
  assert.ok(PatternLib.looseness("^.*$").length > 0);
  assert.deepEqual(PatternLib.looseness("^\\d{3}\\.\\d{2}$"), []);
});

test("looseness does not flag a dot that appears inside a character class", () => {
  assert.deepEqual(PatternLib.looseness("^[.]{3}$"), []);
});

test("looseness returns no warnings for a tight, anchored pattern", () => {
  assert.deepEqual(PatternLib.looseness("^[A-C][B-D]\\d{2}$"), []);
});
