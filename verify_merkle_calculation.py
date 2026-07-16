import hashlib
import binascii

def double_sha256(data):
    return hashlib.sha256(hashlib.sha256(data).digest()).digest()

# Values from the rejected share logs:
coinb1 = "02000000010000000000000000000000000000000000000000000000000000000000000000ffffffff1b033b9f0e5075626c69632d506f6f6c"
extranonce1 = "a16eb97f"
extranonce2 = "f3dba83afa39a045"
coinb2 = "ffffffff027dd0a7120000000016001476e87e445d4ea297b4da882d409f5eb060ad12c90000000000000000266a24aa21a9edffb7707c1cc71cf4f005942ad0820daa59a665ca382337dfcc621b5f87f477c300000000"
merkle_branch = [
    "9f97c448436ff3e56b944469686007d4f1662b334eda87ddf61680d05700bd31",
    "9044d0b28504af2b365496f9a78b4e3ea3d1f780db19564a94a17dc0ebcc2ee6",
    "9c1865d8b76028abc08049c8ab9290ee9b72fab2248b4bdd7e11d5657acfec65",
    "4399f48a7f83ede0afccaaff38c207abb12ffb25b472a23e0cdd8a4776d9a5ab",
    "7b2c29746d319ee6d0a43c98648d525af495f0fc342252abb9fc058e097462df",
    "2648257b6801e04245f2e723c366f8ef9f0e6a9bd17f25797b9b9549b266a028",
    "66bf7978279821cb68934731ea10e9c6eaa14bb12e8c89defe6ca7091884b75b",
    "60234104b40a32ab3b616842188dd22856032eec80c62518f4a30b4d51041e81",
    "6ebd6aa25b6181d7a25d608bab203334113ab7bb0a9b2b2485acf1763ab9fff8",
    "b4d003b39362b7ff3a29666f3b99d1ac0e0dd4c13d3443ff4b66bcbaa808437c",
    "5bf452e84e33e9e846449a2c411e429c181ab14d1bdb58903b45b094383e8715",
    "0667ecfa6e3486c8bf30a980eb05ab82f4697c4b35facd06095e545e118ff331",
    "a1f840010f59073466110d5581938c2c94e3c227b43a6de39692602a0ab580b2"
]
expected_merkle_root = "b7deaaa3ce963020a4fcd18150a82eba95ea9a25d9f628867eaa477dfe3944d0"

# Reconstruct coinbase transaction
coinbase_hex = coinb1 + extranonce1 + extranonce2 + coinb2
coinbase_bytes = binascii.unhexlify(coinbase_hex)
coinbase_hash = double_sha256(coinbase_bytes)

# Reconstruct Merkle Root using the Stratum algorithm
root = coinbase_hash
for branch in merkle_branch:
    sibling = binascii.unhexlify(branch)
    root = double_sha256(root + sibling)

calculated_root_hex = root.hex()

print(f"Calculated Root: {calculated_root_hex}")
print(f"Expected Root:   {expected_merkle_root}")
print(f"Matches?         {calculated_root_hex == expected_merkle_root}")
