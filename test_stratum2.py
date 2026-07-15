import binascii, hashlib, struct

# Known values from stratum
# prevhash: "4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000"
def swap_endian_words(hex_str):
    buf = binascii.unhexlify(hex_str)
    out = bytearray(len(buf))
    for i in range(0, len(buf), 4):
        out[i] = buf[i+3]
        out[i+1] = buf[i+2]
        out[i+2] = buf[i+1]
        out[i+3] = buf[i]
    return binascii.hexlify(out).decode()

# The stratum documentation says:
# "prevhash is the hash of the previous block. It is provided in little-endian." Wait no, "in big-endian" or "reversed"?
# Wait, actually:
version = "00000002"
prev_hash_stratum = "4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000"
merkle_root_le = binascii.unhexlify("c3e98cc342db639b56f3458b68aa49b6b907f9c2d15fb38e53db7b075e7a9baf")[::-1]
ntime = "504e86b9"
nbits = "1c2ac4af"
nonce = "12345678" # just a test

header = (
    struct.pack("<I", int(version, 16)) +
    binascii.unhexlify(swap_endian_words(prev_hash_stratum)) +
    merkle_root_le +
    struct.pack("<I", int(ntime, 16)) +
    struct.pack("<I", int(nbits, 16)) +
    binascii.unhexlify(nonce)
)
print(header.hex())
