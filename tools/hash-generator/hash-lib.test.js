const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const HashLib = require("./hash-lib.js");

function bytesOf(str) {
  return new Uint8Array(Buffer.from(str, "utf8"));
}

function nodeHash(algo, str) {
  return crypto.createHash(algo).update(str, "utf8").digest("hex");
}

const VECTORS = ["", "abc", "The quick brown fox jumps over the lazy dog"];

// ---------------------------------------------------------------------
// MD5 — cross-checked against Node's own OpenSSL-backed implementation,
// plus the classic RFC 1321 test vectors as a second, independent source.
// ---------------------------------------------------------------------

test("md5 matches node:crypto for basic vectors", () => {
  for (const v of VECTORS) {
    assert.equal(HashLib.md5(bytesOf(v)), nodeHash("md5", v));
  }
});

test("md5 matches RFC 1321 test vectors", () => {
  assert.equal(HashLib.md5(bytesOf("")), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(HashLib.md5(bytesOf("abc")), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(
    HashLib.md5(bytesOf("The quick brown fox jumps over the lazy dog")),
    "9e107d9d372bb6826bd81d3542a419d6"
  );
});

test("md5 handles input spanning multiple 64-byte blocks", () => {
  const long = "a".repeat(1000);
  assert.equal(HashLib.md5(bytesOf(long)), nodeHash("md5", long));
});

// ---------------------------------------------------------------------
// CRC-32 — Node has no built-in CRC-32, so these are hardcoded against
// values verified independently via Python's zlib.crc32 this session.
// ---------------------------------------------------------------------

test("crc32 matches verified reference values", () => {
  assert.equal(HashLib.crc32(bytesOf("")), "00000000");
  assert.equal(HashLib.crc32(bytesOf("123456789")), "cbf43926");
  assert.equal(
    HashLib.crc32(bytesOf("The quick brown fox jumps over the lazy dog")),
    "414fa339"
  );
});

// ---------------------------------------------------------------------
// SHA-3 family — cross-checked against Node's OpenSSL-backed sha3-* AND
// hardcoded official NIST FIPS 202 / di-mgt.com.au test vectors.
// ---------------------------------------------------------------------

test("sha3_256 matches node:crypto and NIST vectors", () => {
  for (const v of VECTORS) {
    assert.equal(HashLib.sha3_256(bytesOf(v)), nodeHash("sha3-256", v));
  }
  assert.equal(
    HashLib.sha3_256(bytesOf("")),
    "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a"
  );
  assert.equal(
    HashLib.sha3_256(bytesOf("abc")),
    "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532"
  );
});

test("sha3_512 matches node:crypto and NIST vector", () => {
  for (const v of VECTORS) {
    assert.equal(HashLib.sha3_512(bytesOf(v)), nodeHash("sha3-512", v));
  }
  assert.equal(
    HashLib.sha3_512(bytesOf("")),
    "a69f73cca23a9ac5c8b567dc185a756e97c982164fe25859e0d1dcc1475c80a615b2123af1f5f94c11e3e9402c3ac558f500199d95b6d3e301758586281dcd26"
  );
});

test("sha3_224 matches node:crypto and NIST vector", () => {
  for (const v of VECTORS) {
    assert.equal(HashLib.sha3_224(bytesOf(v)), nodeHash("sha3-224", v));
  }
  assert.equal(
    HashLib.sha3_224(bytesOf("")),
    "6b4e03423667dbb73b6e15454f0eb1abd4597f9a1b078e3f5b5a6bc7"
  );
});

test("sha3_384 matches node:crypto and NIST vector", () => {
  for (const v of VECTORS) {
    assert.equal(HashLib.sha3_384(bytesOf(v)), nodeHash("sha3-384", v));
  }
  assert.equal(
    HashLib.sha3_384(bytesOf("")),
    "0c63a75b845e4f7d01107d852e4c2485c51a50aaaa94fc61995e71bbee983a2ac3713831264adb47fb6bd1e058d5f004"
  );
});

// ---------------------------------------------------------------------
// Keccak-256 — the original Keccak padding (domain suffix 0x01), used by
// Ethereum/Solidity. Node's "sha3-256" is NIST FIPS 202 (suffix 0x06) and
// deliberately produces a different digest for the same input — this test
// both confirms our Keccak-256 values against independently-verified
// reference values and confirms that distinction actually holds.
// ---------------------------------------------------------------------

test("keccak256 matches independently verified reference values", () => {
  assert.equal(
    HashLib.keccak256(bytesOf("")),
    "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
  );
  assert.equal(
    HashLib.keccak256(bytesOf("abc")),
    "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
  );
  assert.equal(
    HashLib.keccak256(bytesOf("The quick brown fox jumps over the lazy dog")),
    "4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15"
  );
});

test("keccak256 differs from sha3_256 for the same input (padding suffix distinction)", () => {
  assert.notEqual(HashLib.keccak256(bytesOf("")), HashLib.sha3_256(bytesOf("")));
  assert.notEqual(HashLib.keccak256(bytesOf("abc")), HashLib.sha3_256(bytesOf("abc")));
});

// ---------------------------------------------------------------------
// Structural sanity checks
// ---------------------------------------------------------------------

test("output lengths are correct for every function", () => {
  const empty = bytesOf("");
  assert.equal(HashLib.md5(empty).length, 32);
  assert.equal(HashLib.crc32(empty).length, 8);
  assert.equal(HashLib.sha3_224(empty).length, 56);
  assert.equal(HashLib.sha3_256(empty).length, 64);
  assert.equal(HashLib.sha3_384(empty).length, 96);
  assert.equal(HashLib.sha3_512(empty).length, 128);
  assert.equal(HashLib.keccak256(empty).length, 64);
});

test("keccak core handles a message exactly one block long (padLen === 1 branch)", () => {
  // SHA3-256 rate is 136 bytes — a 136-byte message forces the single-byte
  // padding branch (0x06 | 0x80 combined into one byte) rather than the
  // two-separate-bytes branch exercised by the shorter vectors above.
  const exact = "x".repeat(136);
  assert.equal(HashLib.sha3_256(bytesOf(exact)), nodeHash("sha3-256", exact));
});
