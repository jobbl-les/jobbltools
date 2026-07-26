// Pure, dependency-free implementations of hash functions the browser's
// SubtleCrypto API doesn't provide (MD5, CRC-32, the SHA-3 family, and
// Keccak-256). SHA-1/256/384/512 are left to crypto.subtle in the browser —
// no point re-implementing what the platform already does correctly.
//
// UMD-style: usable as a browser <script> global (window.HashLib) and as a
// Node require() target for hash-lib.test.js — no build step either way,
// same pattern as tools/salary-dividend-optimiser/calc.js.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.HashLib = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function toHex(bytes) {
    var hex = "";
    for (var i = 0; i < bytes.length; i++) {
      hex += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    }
    return hex;
  }

  // ---------------------------------------------------------------------
  // CRC-32 (IEEE 802.3 / ISO 3309, polynomial 0xEDB88320 reflected form —
  // the one used by zip, gzip, PNG, and Ethernet frame checksums).
  // ---------------------------------------------------------------------

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    var out = new Uint8Array(4);
    out[0] = (crc >>> 24) & 0xff;
    out[1] = (crc >>> 16) & 0xff;
    out[2] = (crc >>> 8) & 0xff;
    out[3] = crc & 0xff;
    return toHex(out);
  }

  // ---------------------------------------------------------------------
  // MD5 (RFC 1321). Broken for security use, but still one of the most
  // commonly requested checksums for file-identity comparison.
  // ---------------------------------------------------------------------

  var MD5_K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
    0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
    0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
    0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
    0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
    0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
  ];

  var MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

  function md5PadAndSchedule(bytes) {
    var msgLen = bytes.length;
    var bitLen = msgLen * 8;
    var padLen = ((56 - (msgLen + 1) % 64) + 64) % 64;
    var total = msgLen + 1 + padLen + 8;
    var padded = new Uint8Array(total);
    padded.set(bytes);
    padded[msgLen] = 0x80;
    // Original bit length, little-endian 64-bit (bitLen safely fits in the
    // low 32 bits for any input this tool can realistically be given).
    var lo = bitLen >>> 0;
    var hi = Math.floor(bitLen / 0x100000000) >>> 0;
    var off = total - 8;
    padded[off] = lo & 0xff;
    padded[off + 1] = (lo >>> 8) & 0xff;
    padded[off + 2] = (lo >>> 16) & 0xff;
    padded[off + 3] = (lo >>> 24) & 0xff;
    padded[off + 4] = hi & 0xff;
    padded[off + 5] = (hi >>> 8) & 0xff;
    padded[off + 6] = (hi >>> 16) & 0xff;
    padded[off + 7] = (hi >>> 24) & 0xff;
    return padded;
  }

  function rotl32(x, c) {
    return ((x << c) | (x >>> (32 - c))) >>> 0;
  }

  function md5(bytes) {
    var padded = md5PadAndSchedule(bytes);
    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    var M = new Uint32Array(16);

    for (var chunk = 0; chunk < padded.length; chunk += 64) {
      for (var j = 0; j < 16; j++) {
        var o = chunk + j * 4;
        M[j] = padded[o] | (padded[o + 1] << 8) | (padded[o + 2] << 16) | (padded[o + 3] << 24);
      }

      var A = a0, B = b0, C = c0, D = d0;
      for (var i = 0; i < 64; i++) {
        var F, g;
        if (i < 16) {
          F = (B & C) | (~B & D);
          g = i;
        } else if (i < 32) {
          F = (D & B) | (~D & C);
          g = (5 * i + 1) % 16;
        } else if (i < 48) {
          F = B ^ C ^ D;
          g = (3 * i + 5) % 16;
        } else {
          F = C ^ (B | ~D);
          g = (7 * i) % 16;
        }
        F = (F + A + MD5_K[i] + M[g]) >>> 0;
        A = D;
        D = C;
        C = B;
        B = (B + rotl32(F, MD5_S[i])) >>> 0;
      }

      a0 = (a0 + A) >>> 0;
      b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0;
      d0 = (d0 + D) >>> 0;
    }

    var out = new Uint8Array(16);
    [a0, b0, c0, d0].forEach(function (word, idx) {
      out[idx * 4] = word & 0xff;
      out[idx * 4 + 1] = (word >>> 8) & 0xff;
      out[idx * 4 + 2] = (word >>> 16) & 0xff;
      out[idx * 4 + 3] = (word >>> 24) & 0xff;
    });
    return toHex(out);
  }

  // ---------------------------------------------------------------------
  // Keccak-f[1600] core, shared by SHA3-224/256/384/512 (NIST FIPS 202,
  // domain suffix 0x06) and Keccak-256 (the original Keccak padding, domain
  // suffix 0x01 — this is what Ethereum/Solidity actually mean by
  // "keccak256", and it is NOT the same digest as SHA3-256 for the same
  // input, because of that suffix difference).
  //
  // State is 25 lanes of 64 bits, held as BigInt so 64-bit rotation/XOR is
  // exact and simple — no need to hand-simulate 64-bit math with pairs of
  // 32-bit words.
  // ---------------------------------------------------------------------

  var MASK64 = (1n << 64n) - 1n;

  var RHO = [
    0n, 1n, 62n, 28n, 27n,
    36n, 44n, 6n, 55n, 20n,
    3n, 10n, 43n, 25n, 39n,
    41n, 45n, 15n, 21n, 8n,
    18n, 2n, 61n, 56n, 14n
  ];

  var RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
  ];

  function rotl64(x, n) {
    if (n === 0n) return x & MASK64;
    return ((x << n) | (x >> (64n - n))) & MASK64;
  }

  function idx(x, y) { return x + 5 * y; }

  function keccakF1600(A) {
    var C = new Array(5);
    var D = new Array(5);
    var B = new Array(25);

    for (var round = 0; round < 24; round++) {
      // theta
      for (var x = 0; x < 5; x++) {
        C[x] = A[idx(x, 0)] ^ A[idx(x, 1)] ^ A[idx(x, 2)] ^ A[idx(x, 3)] ^ A[idx(x, 4)];
      }
      for (x = 0; x < 5; x++) {
        D[x] = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1n);
      }
      for (x = 0; x < 5; x++) {
        for (var y = 0; y < 5; y++) {
          A[idx(x, y)] = (A[idx(x, y)] ^ D[x]) & MASK64;
        }
      }

      // rho + pi combined
      for (x = 0; x < 5; x++) {
        for (y = 0; y < 5; y++) {
          B[idx(y, (2 * x + 3 * y) % 5)] = rotl64(A[idx(x, y)], RHO[idx(x, y)]);
        }
      }

      // chi
      for (x = 0; x < 5; x++) {
        for (y = 0; y < 5; y++) {
          var b1 = B[idx((x + 1) % 5, y)];
          var b2 = B[idx((x + 2) % 5, y)];
          A[idx(x, y)] = (B[idx(x, y)] ^ ((~b1 & MASK64) & b2)) & MASK64;
        }
      }

      // iota
      A[0] = (A[0] ^ RC[round]) & MASK64;
    }
    return A;
  }

  function keccakPad(bytes, rateBytes, domainSuffix) {
    var msgLen = bytes.length;
    var padLen = rateBytes - (msgLen % rateBytes);
    var padded = new Uint8Array(msgLen + padLen);
    padded.set(bytes);
    if (padLen === 1) {
      padded[msgLen] = domainSuffix | 0x80;
    } else {
      padded[msgLen] = domainSuffix;
      padded[padded.length - 1] |= 0x80;
    }
    return padded;
  }

  function keccak(bytes, rateBytes, outputBytes, domainSuffix) {
    var padded = keccakPad(bytes, rateBytes, domainSuffix);
    var state = new Array(25).fill(0n);
    var lanesPerBlock = rateBytes / 8;

    for (var offset = 0; offset < padded.length; offset += rateBytes) {
      for (var lane = 0; lane < lanesPerBlock; lane++) {
        var laneOffset = offset + lane * 8;
        var laneValue = 0n;
        for (var b = 7; b >= 0; b--) {
          laneValue = (laneValue << 8n) | BigInt(padded[laneOffset + b]);
        }
        state[lane] ^= laneValue;
      }
      keccakF1600(state);
    }

    var out = new Uint8Array(outputBytes);
    var written = 0;
    var laneIdx = 0;
    while (written < outputBytes) {
      var lane = state[laneIdx];
      for (var i = 0; i < 8 && written < outputBytes; i++) {
        out[written] = Number(lane & 0xffn);
        lane >>= 8n;
        written++;
      }
      laneIdx++;
    }
    return toHex(out);
  }

  function sha3(bytes, outputBits) {
    var outputBytes = outputBits / 8;
    var rateBytes = 200 - 2 * outputBytes;
    return keccak(bytes, rateBytes, outputBytes, 0x06);
  }

  function keccak256(bytes) {
    return keccak(bytes, 136, 32, 0x01);
  }

  return {
    crc32: crc32,
    md5: md5,
    sha3_224: function (bytes) { return sha3(bytes, 224); },
    sha3_256: function (bytes) { return sha3(bytes, 256); },
    sha3_384: function (bytes) { return sha3(bytes, 384); },
    sha3_512: function (bytes) { return sha3(bytes, 512); },
    keccak256: keccak256
  };
});
