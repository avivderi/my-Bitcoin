import hashlib
import binascii

def double_sha256(data):
    return hashlib.sha256(hashlib.sha256(data).digest()).digest()

# Original header prefix (76 bytes)
header_prefix_hex = "00000020e8f8b4ff02b398d8768056d479536fa6257f0441ec1501000000000000000000b7deaaa3ce963020a4fcd18150a82eba95ea9a25d9f628867eaa477dfe3944d08199586a9d360217"
header_prefix = binascii.unhexlify(header_prefix_hex)

# Case A: We submitted "57346a00" (LE).
# If the pool parses it as BE (0x57346a00), it writes it to the header as LE bytes: b'\x00\x6a\x34\x57'.
nonce_bytes_if_pool_expects_be_but_got_le = binascii.unhexlify("006a3457")
header_le_submitted = header_prefix + nonce_bytes_if_pool_expects_be_but_got_le
hash_le_submitted = double_sha256(header_le_submitted)
hash_be_submitted_hex = hash_le_submitted[::-1].hex()
hash_val_submitted = int(hash_be_submitted_hex, 16)

# Case B: We submitted "006a3457" (BE).
# If the pool parses it as BE (0x006a3457), it writes it to the header as LE bytes: b'\x57\x34\x6a\x00'.
nonce_bytes_if_pool_expects_be_and_got_be = binascii.unhexlify("57346a00")
header_be_submitted = header_prefix + nonce_bytes_if_pool_expects_be_and_got_be
hash_be_submitted = double_sha256(header_be_submitted)
hash_be_expected_hex = hash_be_submitted[::-1].hex()
hash_val_expected = int(hash_be_expected_hex, 16)

max_target = 0x00000000FFFF0000000000000000000000000000000000000000000000000000
target = int(max_target / 1.0) # difficulty 1

print(f"Target:               {target:064x}")
print(f"Hash (LE submission): {hash_be_submitted_hex}")
print(f"Meets Target?         {hash_val_submitted <= target}")
print(f"Hash (BE submission): {hash_be_expected_hex}")
print(f"Meets Target?         {hash_val_expected <= target}")
