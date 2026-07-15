import crypto from 'crypto';

function doubleSha256(buf) {
  const hash1 = crypto.createHash('sha256').update(buf).digest();
  return crypto.createHash('sha256').update(hash1).digest();
}

function packUInt32LE(hexOrNum) {
  const buf = Buffer.alloc(4);
  const num = typeof hexOrNum === 'string' ? parseInt(hexOrNum, 16) : hexOrNum;
  buf.writeUInt32LE(num >>> 0, 0);
  return buf;
}

const headerPrefixBuf = crypto.randomBytes(76);
const headerBuf = Buffer.alloc(80);
headerPrefixBuf.copy(headerBuf, 0, 0, 76);

console.log("⏱️ Starting Nonce-Search Hot-Loop Benchmark (10 seconds per run)...");

// 1. Unoptimized Run
console.log("\n1️⃣ Running Unoptimized Hot-Loop (allocates and concats every iteration)...");
let unoptimizedHashes = 0;
let unoptimizedStart = Date.now();
let nonce = 0;

while (Date.now() - unoptimizedStart < 10000) {
  const chunkSize = 50000;
  for (let i = 0; i < chunkSize; i++, nonce++) {
    const nonceBuf = packUInt32LE(nonce);
    const fullHeaderBuf = Buffer.concat([headerPrefixBuf, nonceBuf]);
    const hash = doubleSha256(fullHeaderBuf);
  }
  unoptimizedHashes += chunkSize;
}
let unoptimizedDuration = (Date.now() - unoptimizedStart) / 1000;
let unoptimizedHashrate = (unoptimizedHashes / unoptimizedDuration) / 1000;
console.log(`✅ Unoptimized completed: ${unoptimizedHashes.toLocaleString()} hashes in ${unoptimizedDuration.toFixed(2)}s (${unoptimizedHashrate.toFixed(2)} KH/s)`);

// 2. Optimized Run
console.log("\n2️⃣ Running Optimized Hot-Loop (pre-allocated buffer, writes directly)...");
let optimizedHashes = 0;
let optimizedStart = Date.now();
nonce = 0;

while (Date.now() - optimizedStart < 10000) {
  const chunkSize = 50000;
  for (let i = 0; i < chunkSize; i++, nonce++) {
    headerBuf.writeUInt32LE(nonce, 76);
    const hash = doubleSha256(headerBuf);
  }
  optimizedHashes += chunkSize;
}
let optimizedDuration = (Date.now() - optimizedStart) / 1000;
let optimizedHashrate = (optimizedHashes / optimizedDuration) / 1000;
console.log(`✅ Optimized completed: ${optimizedHashes.toLocaleString()} hashes in ${optimizedDuration.toFixed(2)}s (${optimizedHashrate.toFixed(2)} KH/s)`);

// Comparison summary
let gainPercent = ((optimizedHashrate - unoptimizedHashrate) / unoptimizedHashrate) * 100;
console.log(`\n📊 Benchmark Results Comparison:`);
console.log(`   - Unoptimized: ${unoptimizedHashrate.toFixed(2)} KH/s`);
console.log(`   - Optimized  : ${optimizedHashrate.toFixed(2)} KH/s`);
console.log(`   - Speedup    : +${gainPercent.toFixed(2)}%`);
