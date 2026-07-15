import crypto from 'crypto';

function doubleSha256(buf) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buf).digest()
  ).digest();
}

// Block 125552 header fields (little endian)
const version = '01000000';
const prev_block_hash = '81cd02ab7e569e8bcd9317e2fe99f2de44d49ab2b8851ba4a308000000000000';
const merkle_root = 'e320b6c2fffc8d750423db8b1eb942ae710e951ed797f7affc8892b0f1fc122b';
const timestamp = 'c7f5d74d';
const nbits = 'f2b9441a';
const nonce = '42a14695';

const header_hex = version + prev_block_hash + merkle_root + timestamp + nbits + nonce;
const header_bytes = Buffer.from(header_hex, 'hex');

console.log('Header length:', header_bytes.length);

const hash = doubleSha256(header_bytes);
console.log('Result hash (LE):', hash.toString('hex'));
console.log('Result hash (BE):', Buffer.from(hash).reverse().toString('hex'));
