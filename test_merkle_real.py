import binascii
import hashlib
import json
import struct
import sys
import urllib.request

def double_sha256(data):
    return hashlib.sha256(hashlib.sha256(data).digest()).digest()

def fetch_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req) as response:
        return json.loads(response.read().decode())

def build_merkle_tree(txids_be):
    # Convert BE txids to LE byte buffers
    level = [binascii.unhexlify(txid)[::-1] for txid in txids_be]
    levels = [level]
    
    while len(level) > 1:
        next_level = []
        for i in range(0, len(level), 2):
            left = level[i]
            right = level[i+1] if i + 1 < len(level) else left
            parent = double_sha256(left + right)
            next_level.append(parent)
        level = next_level
        levels.append(level)
    return levels

def extract_stratum_branch(levels):
    branch = []
    # Sibling of coinbase ancestor (always at index 0) at each level is index 1
    for level in levels[:-1]:
        if len(level) > 1:
            branch.append(level[1])
    return branch

def build_merkle_root_stratum(coinbase_hash_le, branch_le_list):
    root = coinbase_hash_le
    for sibling in branch_le_list:
        root = double_sha256(root + sibling)
    return root

def verify_block_hash(version, prev_hash_be, merkle_root_be, ntime, nbits, nonce, expected_hash_be):
    header = (
        struct.pack("<I", version) +
        binascii.unhexlify(prev_hash_be)[::-1] +
        binascii.unhexlify(merkle_root_be)[::-1] +
        struct.pack("<I", ntime) +
        struct.pack("<I", nbits) +
        struct.pack("<I", nonce)
    )
    block_hash_le = double_sha256(header)
    block_hash_be = block_hash_le[::-1].hex()
    return block_hash_be, block_hash_be == expected_hash_be

def run_block_100_test():
    print("\n==================================================")
    print("🔹 TEST 1: Early Historical Block (Block 100)")
    print("   MerkleRoot = CoinbaseHash directly (No branches)")
    print("==================================================")
    
    # Block 100 details (Coinbase only)
    height = 100
    expected_block_hash_be = "000000007bc154e0fa7ea32218a72fe2c1bb9f86cf8c9ebf9a715ed27fdb229a"
    expected_merkle_root_be = "2d05f0c9c3e1c226e63b5fac240137687544cf631cd616fd34fd188fc9020866"
    version = 1
    prev_hash_be = "00000000cd9b12643e6854cb25939b39cd7a1ad0af31a9bd8b2efe67854b1995"
    ntime = 1231660825
    nbits = 486604799
    nonce = 1573057331

    # In a coinbase-only block, the only txid is the coinbase hash.
    # Therefore, its BE txid is the Merkle root itself.
    coinbase_txid_be = expected_merkle_root_be
    coinbase_hash_le = binascii.unhexlify(coinbase_txid_be)[::-1]
    
    # Stratum merkle branch is empty
    stratum_branch = []
    
    # Compute Merkle Root using Stratum logic:
    calculated_root_le = build_merkle_root_stratum(coinbase_hash_le, stratum_branch)
    calculated_root_be = calculated_root_le[::-1].hex()
    
    print(f"Coinbase TXID (BE):  {coinbase_txid_be}")
    print(f"Calculated Root (BE): {calculated_root_be}")
    print(f"Expected Root (BE):   {expected_merkle_root_be}")
    
    root_match = (calculated_root_be == expected_merkle_root_be)
    print(f"Merkle Root Match?   {'✅ YES' if root_match else '❌ NO'}")
    
    # Verify block header hash
    calc_hash_be, hash_match = verify_block_hash(
        version, prev_hash_be, calculated_root_be, ntime, nbits, nonce, expected_block_hash_be
    )
    print(f"Calculated Hash (BE): {calc_hash_be}")
    print(f"Expected Hash (BE):   {expected_block_hash_be}")
    print(f"Block Hash Match?    {'✅ YES' if hash_match else '❌ NO'}")
    return root_match and hash_match

def run_block_125552_test():
    print("\n==================================================")
    print("🔹 TEST 2: Dynamic Merkle Tree Reconstruction (Block 125552)")
    print("   Fetching real txids from Blockstream API and rebuilding tree")
    print("==================================================")
    
    # Block 125552 details
    height = 125552
    expected_block_hash_be = "00000000000000001e8d6829a8a21adc5d38d0a473b144b6765798e61f98bd1d"
    expected_merkle_root_be = "2b12fcf1b09288fcaff797d71e950e71ae42b91e8bdb2304758dfcffc2b620e3"
    version = 1
    prev_hash_be = "00000000000008a3a41b85b8b29ad444def299fee21793cd8b9e567eab02cd81"
    ntime = 1305998791
    nbits = 440711666
    nonce = 2504433986

    print("Fetching txids from Blockstream API...")
    txids_url = f"https://blockstream.info/api/block/{expected_block_hash_be}/txids"
    try:
        txids = fetch_json(txids_url)
    except Exception as e:
        print(f"❌ Failed to fetch txids: {e}")
        print("Falling back to local hardcoded txids for Block 125552...")
        txids = [
            "51d37bdd871c9e1f4d5541be67a6ab625e32028744d7d4609d0c37747b40cd2d",
            "60c25dda8d41f8d3d7d5c6249e2ea1b05a25bf7ae2ad6d904b512b31f997e1a1",
            "01f314cdd8566d3e5dbdd97de2d9fbfbfd6873e916a00d48758282cbb81a45b9",
            "b519286a1040da6ad83c783eb2872659eaf57b1bec088e614776ffe7dc8f6d01"
        ]
        
    print(f"Transactions in Block ({len(txids)} total):")
    for idx, txid in enumerate(txids):
        print(f"  TX {idx}: {txid}")
        
    # Rebuild Merkle Tree
    levels = build_merkle_tree(txids)
    calculated_merkle_root_le = levels[-1][0]
    calculated_merkle_root_be = calculated_merkle_root_le[::-1].hex()
    
    print(f"\nCalculated Root (BE): {calculated_merkle_root_be}")
    print(f"Expected Root (BE):   {expected_merkle_root_be}")
    tree_root_match = (calculated_merkle_root_be == expected_merkle_root_be)
    print(f"Merkle Tree Root Match? {'✅ YES' if tree_root_match else '❌ NO'}")

    # Extract Stratum Merkle Branch
    stratum_branch_le = extract_stratum_branch(levels)
    print(f"\nExtracted Stratum Merkle Branch (LE hex):")
    for idx, branch_node in enumerate(stratum_branch_le):
        print(f"  Level {idx} Sibling: {branch_node.hex()}")

    # Verify Stratum Root building from Coinbase (TX 0) and Branch
    coinbase_hash_le = binascii.unhexlify(txids[0])[::-1]
    stratum_merkle_root_le = build_merkle_root_stratum(coinbase_hash_le, stratum_branch_le)
    stratum_merkle_root_be = stratum_merkle_root_le[::-1].hex()
    
    print(f"\nStratum Calculated Root (BE): {stratum_merkle_root_be}")
    stratum_root_match = (stratum_merkle_root_be == expected_merkle_root_be)
    print(f"Stratum Merkle Root Match?   {'✅ YES' if stratum_root_match else '❌ NO'}")

    # Verify Block Hash
    calc_hash_be, hash_match = verify_block_hash(
        version, prev_hash_be, stratum_merkle_root_be, ntime, nbits, nonce, expected_block_hash_be
    )
    print(f"Calculated Hash (BE): {calc_hash_be}")
    print(f"Expected Hash (BE):   {expected_block_hash_be}")
    print(f"Block Hash Match?    {'✅ YES' if hash_match else '❌ NO'}")
    
    return tree_root_match and stratum_root_match and hash_match

if __name__ == "__main__":
    t1_ok = run_block_100_test()
    t2_ok = run_block_125552_test()
    
    print("\n==================================================")
    if t1_ok and t2_ok:
        print("🎉 ALL TESTS PASSED SUCCESSFULLY! ✅")
        sys.exit(0)
    else:
        print("❌ SOME TESTS FAILED.")
        sys.exit(1)
