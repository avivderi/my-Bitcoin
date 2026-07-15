import binascii, hashlib

coinbase_hex = "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0804ffff001d026e04ffffffff0100f2052a0100000043410446ef0102d1ec5240f2d050f52db43b593ebc839f9dd57b56f8e7b1a13bc20c5d6af7c4cf040bf5e15da3b44b62db433f000300a7b4695e80674eab8b5dd17d2eac00000000"
coinbase_hash = hashlib.sha256(hashlib.sha256(binascii.unhexlify(coinbase_hex)).digest()).digest()

branches = [
    "c3e98cc342db639b56f3458b68aa49b6b907f9c2d15fb38e53db7b075e7a9baf",
    "2a433bd178a8775494d6e9dc17a780447387cc8e7d23d8c1c49bcf279b9ba4b3"
]

def try_combo(reverse_coinbase, reverse_branch, reverse_root_each_step, reverse_final):
    root = coinbase_hash[::-1] if reverse_coinbase else coinbase_hash
    for branch in branches:
        b = binascii.unhexlify(branch)
        b = b[::-1] if reverse_branch else b
        combined = root + b
        root = hashlib.sha256(hashlib.sha256(combined).digest()).digest()
        if reverse_root_each_step:
            root = root[::-1]
    
    if reverse_final:
        root = root[::-1]
    return root.hex()

expected = "e320b6c2fffc8d750423db8b1eb942ae710e951ed797f7affc8892b0f1fc122b"
expected2 = "2b12fcf1b09288fcaff797d71e950e71ae42b91e8bdb2304758dfcffc2b620e3"
for rc in [False, True]:
    for rb in [False, True]:
        for rr in [False, True]:
            for rf in [False, True]:
                res = try_combo(rc, rb, rr, rf)
                if res == expected or res == expected2:
                    print(f"FOUND MATCH! rc={rc}, rb={rb}, rr={rr}, rf={rf}")
