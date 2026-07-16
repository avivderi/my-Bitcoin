#!/usr/bin/env python3
import sys
import hashlib

def double_sha256(data_bytes):
    return hashlib.sha256(hashlib.sha256(data_bytes).digest()).digest()

def verify(header_hex, difficulty):
    # Parse header
    header_bytes = bytes.fromhex(header_hex)
    if len(header_bytes) != 80:
        print(f"Error: Header must be exactly 80 bytes (160 hex characters). Got {len(header_bytes)} bytes.")
        return False
        
    # Calculate hash
    hash_bytes = double_sha256(header_bytes)
    # The hash returned by double-sha256 is in Little Endian format for Bitcoin
    hash_le_hex = hash_bytes.hex()
    hash_be_hex = hash_bytes[::-1].hex()
    
    # Calculate target
    # Max target = 0x00000000FFFF0000000000000000000000000000000000000000000000000000
    max_target = 0x00000000FFFF0000000000000000000000000000000000000000000000000000
    target = int(max_target / difficulty)
    
    hash_value = int(hash_be_hex, 16)
    
    print("=================== INDEPENDENT MATHEMATICAL VERIFICATION ===================")
    print(f"Header Hex:     {header_hex}")
    print(f"Hash LE Hex:    {hash_le_hex}")
    print(f"Hash BE Hex:    {hash_be_hex}")
    print(f"Hash Value:     {hash_value}")
    print(f"Target Value:   {target}")
    print(f"Target Hex:     {target:064x}")
    print(f"Target Diff:    {difficulty}")
    
    # Check if hash <= target
    is_valid = hash_value <= target
    if is_valid:
        print("\nVerification Result: ✅ VALID SHARE!")
        print("The calculated block hash meets or exceeds the required target difficulty.")
    else:
        print("\nVerification Result: ❌ INVALID SHARE!")
        print("The calculated block hash does NOT meet the required target difficulty.")
        
    # Calculate actual difficulty of the hash
    actual_diff = max_target / hash_value if hash_value > 0 else float('inf')
    print(f"Actual Hash Diff: {actual_diff}")
    print("=============================================================================")
    return is_valid

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python3 verify_share.py <header_hex> <difficulty>")
        sys.exit(1)
        
    h_hex = sys.argv[1]
    diff = float(sys.argv[2])
    verify(h_hex, diff)
