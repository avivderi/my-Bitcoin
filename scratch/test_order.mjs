import crypto from 'crypto';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function doubleSha256(buf) {
  return sha256(sha256(buf));
}

function hashToBigInt(buf) {
  const val0 = buf.readBigUInt64LE(0);
  const val1 = buf.readBigUInt64LE(8);
  const val2 = buf.readBigUInt64LE(16);
  const val3 = buf.readBigUInt64LE(24);
  return val0 | (val1 << 64n) | (val2 << 128n) | (val3 << 192n);
}

// Target for diff 1:
// 0x00000000FFFF0000000000000000000000000000000000000000000000000000
const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');

// Let's take block 125552 hash:
// BE: 00000000000000001e8d6829a8a21adc5d38d0a473b144b6765798e61f98bd1d
// LE representation (raw bytes of hash):
const hashLE = Buffer.from('1dbd981fe6985776b644b173a4d0385dad1ca2a829688d1e0000000000000000', 'hex');

const hashVal = hashToBigInt(hashLE);
console.log('hashVal:  ', hashVal.toString(16).padStart(64, '0'));
console.log('maxTarget:', maxTarget.toString(16).padStart(64, '0'));
console.log('hashVal <= maxTarget?', hashVal <= maxTarget);
