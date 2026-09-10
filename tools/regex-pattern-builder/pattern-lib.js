// Pure logic for deriving a regular expression that matches every line of a
// sample file, tightened as far as the data itself justifies (length bounds,
// character classes, and — when every line is the same length — a
// per-position pattern) rather than falling back to something permissive
// like ".*".
//
// UMD-style: usable as a browser <script> global (window.PatternLib) and as
// a Node require() target for pattern-lib.test.js — no build step either
// way, same pattern as tools/hash-generator/hash-lib.js.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PatternLib = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Splitting input text into lines
  // ---------------------------------------------------------------------

  // opts.trim (default true): trim leading/trailing whitespace off each line.
  // opts.ignoreBlank (default true): drop lines that end up empty (this also
  // absorbs the single trailing empty line a final newline produces).
  function splitLines(text, opts) {
    opts = opts || {};
    var trim = opts.trim !== false;
    var ignoreBlank = opts.ignoreBlank !== false;
    var raw = String(text == null ? "" : text).split(/\r\n|\r|\n/);
    var lines = [];
    var lineNumbers = [];
    raw.forEach(function (l, idx) {
      var val = trim ? l.trim() : l;
      if (ignoreBlank && val === "") return;
      lines.push(val);
      lineNumbers.push(idx + 1);
    });
    return { lines: lines, lineNumbers: lineNumbers };
  }

  // ---------------------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------------------

  function isDigit(ch) { return ch >= "0" && ch <= "9"; }
  function isLower(ch) { return ch >= "a" && ch <= "z"; }
  function isUpper(ch) { return ch >= "A" && ch <= "Z"; }

  function computeCommonPrefix(lines) {
    if (!lines.length) return "";
    var first = lines[0];
    var prefixLen = first.length;
    for (var i = 1; i < lines.length && prefixLen > 0; i++) {
      var l = lines[i];
      var max = Math.min(prefixLen, l.length);
      var j = 0;
      while (j < max && l[j] === first[j]) j++;
      prefixLen = j;
    }
    return first.slice(0, prefixLen);
  }

  // prefixLen is subtracted from the budget so a prefix and suffix derived
  // independently can never claim overlapping characters on a short line
  // (e.g. every line being the single character "a" shouldn't produce a
  // prefix of "a" AND a suffix of "a" against a 1-character budget).
  function computeCommonSuffix(lines, prefixLen) {
    if (!lines.length) return "";
    prefixLen = prefixLen || 0;
    var first = lines[0];
    var suffixLen = first.length;
    for (var i = 1; i < lines.length && suffixLen > 0; i++) {
      var l = lines[i];
      var max = Math.min(suffixLen, l.length);
      var j = 0;
      while (j < max && l[l.length - 1 - j] === first[first.length - 1 - j]) j++;
      suffixLen = j;
    }
    var minLen = lines.reduce(function (m, l) { return Math.min(m, l.length); }, Infinity);
    if (prefixLen + suffixLen > minLen) {
      suffixLen = Math.max(0, minLen - prefixLen);
    }
    return suffixLen > 0 ? first.slice(first.length - suffixLen) : "";
  }

  function analyze(lines) {
    if (!lines || lines.length === 0) {
      return {
        count: 0, minLen: 0, maxLen: 0, fixedLength: false,
        distinctChars: [], otherChars: [],
        classes: { digit: false, lower: false, upper: false, other: false },
        commonPrefix: "", commonSuffix: "", positions: null
      };
    }

    var minLen = Infinity, maxLen = 0;
    var distinctSet = {}, otherSet = {};
    var classes = { digit: false, lower: false, upper: false, other: false };

    lines.forEach(function (l) {
      minLen = Math.min(minLen, l.length);
      maxLen = Math.max(maxLen, l.length);
      for (var i = 0; i < l.length; i++) {
        var ch = l[i];
        distinctSet[ch] = true;
        if (isDigit(ch)) classes.digit = true;
        else if (isLower(ch)) classes.lower = true;
        else if (isUpper(ch)) classes.upper = true;
        else { classes.other = true; otherSet[ch] = true; }
      }
    });

    var fixedLength = minLen === maxLen;
    var commonPrefix = computeCommonPrefix(lines);
    var commonSuffix = computeCommonSuffix(lines, commonPrefix.length);

    var positions = null;
    if (fixedLength) {
      positions = [];
      for (var p = 0; p < minLen; p++) {
        var set = {};
        for (var i2 = 0; i2 < lines.length; i2++) set[lines[i2][p]] = true;
        positions.push({ chars: Object.keys(set).sort() });
      }
    }

    return {
      count: lines.length,
      minLen: minLen,
      maxLen: maxLen,
      fixedLength: fixedLength,
      distinctChars: Object.keys(distinctSet).sort(),
      otherChars: Object.keys(otherSet).sort(),
      classes: classes,
      commonPrefix: commonPrefix,
      commonSuffix: commonSuffix,
      positions: positions
    };
  }

  // ---------------------------------------------------------------------
  // Regex-building
  // ---------------------------------------------------------------------

  // Escaping for a literal character/string used OUTSIDE a character class.
  var LITERAL_SPECIALS = /[.*+?^${}()|[\]\\/]/g;
  function escapeLiteral(str) {
    return str.replace(LITERAL_SPECIALS, "\\$&");
  }

  // Escaping for a character placed INSIDE a [...] class.
  function escapeForClass(ch) {
    if (ch === "\\") return "\\\\";
    if (ch === "]") return "\\]";
    if (ch === "^") return "\\^";
    if (ch === "-") return "\\-";
    return ch;
  }

  // Given the distinct characters observed at one position (or across a
  // whole variable-length span), return the tightest regex token that
  // matches exactly that set: a literal for a single character, a
  // shorthand class (\d, [a-z], [A-Z], [A-Za-z], [A-Za-z0-9]) when the
  // observed set exactly fills one of those, otherwise an explicit
  // character class built only from the characters actually seen.
  function classifyCharSet(chars) {
    if (!chars || chars.length === 0) return "";
    if (chars.length === 1) return escapeLiteral(chars[0]);

    var digits = [], lowers = [], uppers = [], others = [];
    chars.forEach(function (ch) {
      if (isDigit(ch)) digits.push(ch);
      else if (isLower(ch)) lowers.push(ch);
      else if (isUpper(ch)) uppers.push(ch);
      else others.push(ch);
    });

    if (digits.length === 10 && !lowers.length && !uppers.length && !others.length) return "\\d";
    if (lowers.length === 26 && !digits.length && !uppers.length && !others.length) return "[a-z]";
    if (uppers.length === 26 && !digits.length && !lowers.length && !others.length) return "[A-Z]";
    if (lowers.length === 26 && uppers.length === 26 && !digits.length && !others.length) return "[A-Za-z]";
    if (lowers.length === 26 && uppers.length === 26 && digits.length === 10 && !others.length) return "[A-Za-z0-9]";

    var parts = "";
    parts += digits.length === 10 ? "0-9" : digits.map(escapeForClass).join("");
    parts += lowers.length === 26 ? "a-z" : lowers.map(escapeForClass).join("");
    parts += uppers.length === 26 ? "A-Z" : uppers.map(escapeForClass).join("");
    parts += others.map(escapeForClass).join("");
    return "[" + parts + "]";
  }

  // Collapse a run of identical position tokens into token{n}.
  function collapseTokens(tokens) {
    var out = "";
    var i = 0;
    while (i < tokens.length) {
      var tok = tokens[i];
      var run = 1;
      while (i + run < tokens.length && tokens[i + run] === tok) run++;
      out += tok + (run > 1 ? "{" + run + "}" : "");
      i += run;
    }
    return out;
  }

  // opts.mode: "auto" (default) picks "positional" for equal-length lines
  // and "charset" otherwise; either can be forced explicitly.
  // opts.anchor (default true): wrap the body in ^...$.
  function buildRegex(lines, opts) {
    opts = opts || {};
    var anchor = opts.anchor !== false;
    var mode = opts.mode || "auto";

    if (!lines || lines.length === 0) {
      return { error: "No lines to analyze." };
    }

    var stats = analyze(lines);
    var effectiveMode = mode === "auto" ? (stats.fixedLength ? "positional" : "charset") : mode;

    if (effectiveMode === "positional" && !stats.fixedLength) {
      return { error: "Positional mode needs every line to be the same length.", stats: stats };
    }

    var body;
    if (effectiveMode === "positional") {
      var tokens = stats.positions.map(function (p) { return classifyCharSet(p.chars); });
      body = collapseTokens(tokens);
    } else {
      var prefix = stats.commonPrefix;
      var suffix = stats.commonSuffix;
      var middles = lines.map(function (l) { return l.slice(prefix.length, l.length - suffix.length); });
      var minMid = middles.reduce(function (m, s) { return Math.min(m, s.length); }, Infinity);
      var maxMid = middles.reduce(function (m, s) { return Math.max(m, s.length); }, 0);

      var midBody;
      if (maxMid === 0) {
        midBody = "";
      } else {
        var midSet = {};
        middles.forEach(function (m) { for (var i = 0; i < m.length; i++) midSet[m[i]] = true; });
        var token = classifyCharSet(Object.keys(midSet).sort());
        var quant = minMid === maxMid ? (minMid === 1 ? "" : "{" + minMid + "}") : "{" + minMid + "," + maxMid + "}";
        midBody = token + quant;
      }
      body = escapeLiteral(prefix) + midBody + escapeLiteral(suffix);
    }

    var pattern = anchor ? "^" + body + "$" : body;
    return { pattern: pattern, mode: effectiveMode, stats: stats };
  }

  // ---------------------------------------------------------------------
  // Testing a candidate pattern against the sample lines
  // ---------------------------------------------------------------------

  function testPattern(pattern, flags, lines) {
    var re;
    try {
      re = new RegExp(pattern, flags || "");
    } catch (e) {
      return { ok: false, error: e.message };
    }
    var matched = 0;
    var failed = [];
    lines.forEach(function (line, index) {
      // Reset lastIndex on every call: a 'g' or 'y' flag would otherwise
      // make .test() stateful across lines and silently skip matches.
      re.lastIndex = 0;
      if (re.test(line)) matched++;
      else failed.push({ index: index, line: line });
    });
    return { ok: true, matched: matched, total: lines.length, failed: failed };
  }

  // Heuristic looseness warnings — not exhaustive, just the common ways a
  // pattern ends up accepting far more than the sample data justifies.
  function looseness(pattern) {
    var warnings = [];
    if (!pattern) {
      warnings.push("Pattern is empty — it won't constrain anything.");
      return warnings;
    }
    if (pattern.charAt(0) !== "^" || pattern.charAt(pattern.length - 1) !== "$") {
      warnings.push("Pattern isn't anchored with ^ and $ — it may match as part of a longer string instead of requiring a full match.");
    }

    var inClass = false;
    var bareDot = false;
    var dotStar = false;
    for (var i = 0; i < pattern.length; i++) {
      var ch = pattern[i];
      if (ch === "\\") { i++; continue; }
      if (ch === "[") { inClass = true; continue; }
      if (ch === "]") { inClass = false; continue; }
      if (ch === "." && !inClass) {
        var next = pattern[i + 1];
        if (next === "*" || next === "+") dotStar = true;
        else bareDot = true;
      }
    }
    if (dotStar) {
      warnings.push("Pattern uses .* or .+ — this matches almost any characters of that length range.");
    } else if (bareDot) {
      warnings.push("Pattern contains an unescaped . outside a character class — this matches any character, not just the ones seen in your data.");
    }
    if (/\\w[+*]|\\S[+*]/.test(pattern)) {
      warnings.push("Pattern uses an unbounded \\w/\\S repeat — consider a specific length range or character set instead.");
    }
    return warnings;
  }

  return {
    splitLines: splitLines,
    analyze: analyze,
    commonPrefix: computeCommonPrefix,
    commonSuffix: computeCommonSuffix,
    classifyCharSet: classifyCharSet,
    collapseTokens: collapseTokens,
    buildRegex: buildRegex,
    escapeLiteral: escapeLiteral,
    testPattern: testPattern,
    looseness: looseness
  };
});
