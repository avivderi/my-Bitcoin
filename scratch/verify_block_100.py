import binascii, hashlib, struct

# Block 100 details
version = 1
prev_hash = "00000000cd9b12643e6854cb25939b39cd7a1ad0af31a9bd8b2efe67854b1995"
merkle_root = "2d05f0c9c3e1c226e63b5fac240137687544cf631cd616fd34fd188fc9020866"
ntime = 1231660825
nbits = 486604799
nonce = 1573057331

# Construct the header (80 bytes)
header = (
    struct.pack("<I", version) +
    binascii.unhexlify(prev_hash)[::-1] +
    binascii.unhexlify(merkle_root)[::-1] +
    struct.pack("<I", ntime) +
    struct.pack("<I", nbits) +
    struct.pack("<I", nonce)
)

block_hash = hashlib.sha256(hashlib.sha256(header).digest()).digest()
print("Calculated hash (BE):", block_hash[::-1].hex())
print("Expected hash (BE):  ", "000000007bc154e0fa7ea32218a72fe2c1bb9f86cf8c9ebf9a715ed27fdb229a")
print("Match?", block_hash[::-1].hex() == "000000007bc154e0fa7ea32218a72fe2c1bb9f86cf8c9ebf9a715ed27fdb229a")
