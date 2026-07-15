import binascii, hashlib, struct

# Values from a known block (Block 125552)
# https://en.bitcoin.it/wiki/Block_hashing_algorithm
version = 1
prev_hash = "81cd02ab7e569e8bcd9317e2fe99f2de44d49ab2b8851ba4a308000000000000"
merkle_root = "e320b6c2fffc8d750423db8b1eb942ae710e951ed797f7affc8892b0f1fc122b"
ntime = 1305998791
nbits = 0x1a0904d0 # 436798672
nonce = 2504433986

header = (
    struct.pack("<I", version) +
    binascii.unhexlify(prev_hash)[::-1] +
    binascii.unhexlify(merkle_root)[::-1] +
    struct.pack("<I", ntime) +
    struct.pack("<I", nbits) +
    struct.pack("<I", nonce)
)

hash = hashlib.sha256(hashlib.sha256(header).digest()).digest()
print(hash[::-1].hex())
