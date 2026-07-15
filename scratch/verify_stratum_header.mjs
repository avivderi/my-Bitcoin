import crypto from 'crypto';

function doubleSha256(buf) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buf).digest()
  ).digest();
}

function buildMerkleRoot(coinbaseHash, merkleBranch) {
  let root = coinbaseHash;
  for (const branch of merkleBranch) {
    root = doubleSha256(Buffer.concat([root, Buffer.from(branch, 'hex')]));
  }
  return root;
}

// Block 125552 Transactions in Big Endian (BE) as shown in block explorers
const tx1_be = '51d37bdd871c9e1f4d5541be67a6ab625e32028744d7d4609d0c37747b40cd2d'; // Coinbase
const tx2_be = '60c25dda8d41f8d3d7d5c6249e2ea1b05a25bf7ae2ad6d904b512b31f997e1a1';
const tx3_be = '01f314cdd8566d3e5dbdd97de2d9fbfbfd6873e916a00d48758282cbb81a45b9';
const tx4_be = 'b519286a1040da6ad83c783eb2872659eaf57b1bec088e614776ffe7dc8f6d01';

// Convert to Little Endian (LE) internal byte order
const tx1_le_buf = Buffer.from(tx1_be, 'hex').reverse();
const tx2_le_buf = Buffer.from(tx2_be, 'hex').reverse();
const tx3_le_buf = Buffer.from(tx3_be, 'hex').reverse();
const tx4_le_buf = Buffer.from(tx4_be, 'hex').reverse();

// Calculate Level 1 right branch (hash34)
const hash34 = doubleSha256(Buffer.concat([tx3_le_buf, tx4_le_buf]));
const hash34_hex = hash34.toString('hex');

// In a Stratum V1 Job:
// The miner computes the coinbase hash (tx1_le)
const coinbaseHash = tx1_le_buf;

// The pool sends the merkle branch:
const merkleBranch = [
  tx2_le_buf.toString('hex'), // combined with coinbaseHash to get hash12
  hash34_hex                  // combined with hash12 to get final merkle root
];

// Run the Merkle Root calculation exactly as implemented in stratum-miner.mjs
const merkleRootBuf = buildMerkleRoot(coinbaseHash, merkleBranch);
const merkleRootHex = merkleRootBuf.toString('hex');

console.log('--- Merkle Root Verification ---');
console.log('Calculated Merkle Root (LE):', merkleRootHex);
console.log('Expected Merkle Root (LE):  ', 'e320b6c2fffc8d750423db8b1eb942ae710e951ed797f7affc8892b0f1fc122b');
console.log('Match?', merkleRootHex === 'e320b6c2fffc8d750423db8b1eb942ae710e951ed797f7affc8892b0f1fc122b' ? 'YES \u2705' : 'NO \u274C');

// Now construct the full 80-byte header
// Block 125552 header fields
const version = '01000000'; // 1 in LE
const prev_block_hash = '81cd02ab7e569e8bcd9317e2fe99f2de44d49ab2b8851ba4a308000000000000'; // LE
const timestamp = 'c7f5d74d'; // LE
const nbits = 'f2b9441a'; // LE
const nonce = '42a14695'; // LE

const header_hex = version + prev_block_hash + merkleRootHex + timestamp + nbits + nonce;
const header_bytes = Buffer.from(header_hex, 'hex');

const blockHashLE = doubleSha256(header_bytes);
const blockHashBE = Buffer.from(blockHashLE).reverse().toString('hex');

console.log('\n--- Block Hash Verification ---');
console.log('Calculated Block Hash (BE):', blockHashBE);
console.log('Expected Block Hash (BE):  ', '00000000000000001e8d6829a8a21adc5d38d0a473b144b6765798e61f98bd1d');
console.log('Match?', blockHashBE === '00000000000000001e8d6829a8a21adc5d38d0a473b144b6765798e61f98bd1d' ? 'YES \u2705' : 'NO \u274C');
