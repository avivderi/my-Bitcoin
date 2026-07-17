#!/usr/bin/env python3
import os
import sys
import time
import json
import urllib.request
import urllib.error
import random
import hashlib
import binascii
import struct
import multiprocessing

# --- CONFIGURATION ---
MASTER_IP = "127.0.0.1"      # Change to PC IP for remote mining
MASTER_PORT = 3224           # Bitcoin Miner Control Server Port
WORKER_NAME = "redmi-1"      # Unique name for this phone
MAX_CORES = 8                # Redmi 13C has 8 cores
DEFAULT_THREADS = 6          # Start with 6 threads for better performance
DASHBOARD_TOKEN = os.environ.get("DASHBOARD_TOKEN", "")  # Secret token to authenticate with Master Server

# Check for demo mode command line argument
IS_DEMO = "--demo" in sys.argv

# Parse command line overrides for Name, IP, and Token
# Can be set via positional args: python phone-worker.py [name] [ip]
# Or via named flags: python phone-worker.py --name=redmi-1 --ip=192.168.1.50 --token=xxx
for arg in sys.argv:
    if arg.startswith("--name="):
        WORKER_NAME = arg.split("=")[1]
    elif arg.startswith("--ip="):
        MASTER_IP = arg.split("=")[1]
    elif arg.startswith("--token="):
        DASHBOARD_TOKEN = arg.split("=")[1]

positional_args = [arg for arg in sys.argv[1:] if not arg.startswith("-")]
if len(positional_args) >= 1:
    WORKER_NAME = positional_args[0]
if len(positional_args) >= 2:
    MASTER_IP = positional_args[1]

# Extract port from MASTER_IP if specified (e.g. 192.168.1.50:3224)
if ":" in MASTER_IP:
    try:
        parts = MASTER_IP.split(":")
        MASTER_IP = parts[0]
        MASTER_PORT = int(parts[1])
    except Exception:
        pass

# State variables
current_threads = DEFAULT_THREADS
is_mining = False
active_processes = []
result_queue = None
total_shares_found = 0
total_shares_accepted = 0
current_hashrate = 0.0
uptime_start = time.time()
current_job_id = None
pending_logs = []

# Simulated state for demo mode
sim_temp = 50.0
sim_shares = 0
sim_uptime = 0

def get_temperature():
    """Read CPU or Battery temperature from Android thermal paths."""
    if IS_DEMO:
        global sim_temp
        # Simulate thermodynamics based on active threads
        heat_factor = (current_threads / MAX_CORES) * 2.0
        sim_temp += (heat_factor - 1.2) * 1.5 + random.uniform(-0.3, 0.3)
        sim_temp = max(35.0, min(80.0, sim_temp))
        return sim_temp

    # Common battery temperature paths
    battery_paths = [
        '/sys/class/power_supply/battery/temp',
        '/sys/class/power_supply/battery/batt_temp'
    ]
    for path in battery_paths:
        try:
            if os.path.exists(path):
                with open(path, 'r') as f:
                    val = float(f.read().strip())
                    if val > 1000:
                        val /= 1000.0
                    elif val > 100:
                        val /= 10.0
                    if 15.0 <= val <= 85.0:
                        return val
        except:
            pass

    # CPU thermal zones
    for i in range(20):
        path = f'/sys/class/thermal/thermal_zone{i}/temp'
        try:
            if os.path.exists(path):
                with open(path, 'r') as f:
                    val = float(f.read().strip())
                    if val > 1000:
                        val /= 1000.0
                    if 25.0 <= val <= 95.0:
                        return val
        except:
            pass
    return 38.0

def swap_endian_words(hex_str):
    buf = binascii.unhexlify(hex_str)
    out = bytearray(len(buf))
    for i in range(0, len(buf), 4):
        out[i] = buf[i+3]
        out[i+1] = buf[i+2]
        out[i+2] = buf[i+1]
        out[i+3] = buf[i]
    return binascii.hexlify(out).decode()

# Hashing worker process
def btc_mining_worker(job, difficulty, extranonce1, extranonce2_size, start_nonce, result_queue):
    try:
        max_target = 0x00000000FFFF0000000000000000000000000000000000000000000000000000
        diff_val = max(0.000001, float(difficulty))
        scale = 1000000
        scaled_diff = int(round(diff_val * scale))
        target = (max_target * scale) // scaled_diff
        
        job_id = job['jobId']
        prev_hash = binascii.unhexlify(swap_endian_words(job['prevHash']))
        version = struct.pack('<I', int(job['blockVersion'], 16))
        nbits = struct.pack('<I', int(job['nbits'], 16))
        ntime = struct.pack('<I', int(job['ntime'], 16))
        merkle_branch = job['merkleBranch']
        
        # Initialise extranonce2
        extranonce2 = binascii.hexlify(os.urandom(extranonce2_size)).decode()
        result_queue.put({
            'type': 'status',
            'message': f"Started thread with extranonce2: {extranonce2}"
        })
        coinbase_hex = job['coinb1'] + extranonce1 + extranonce2 + job['coinb2']
        coinbase_hash = hashlib.sha256(hashlib.sha256(binascii.unhexlify(coinbase_hex)).digest()).digest()
        
        # Start Merkle root calculation in big-endian
        root = coinbase_hash
        for branch in merkle_branch:
            combined = root + binascii.unhexlify(branch)
            root = hashlib.sha256(hashlib.sha256(combined).digest()).digest()
            
        merkle_root_le = root
        header_prefix = version + prev_hash + merkle_root_le + ntime + nbits
        
        nonce = start_nonce
        hashes = 0
        start_time = time.time()
        
        while True:
            header = header_prefix + struct.pack('<I', nonce)
            block_hash = hashlib.sha256(hashlib.sha256(header).digest()).digest()
            hash_val = int.from_bytes(block_hash, byteorder='little')
            
            if hash_val <= target:
                header_bytes = header_prefix + struct.pack('<I', nonce)
                header_hex = binascii.hexlify(header_bytes).decode()
                hash_le_hex = binascii.hexlify(block_hash).decode()
                hash_be_hex = binascii.hexlify(block_hash[::-1]).decode()
                
                result_queue.put({
                    'type': 'share',
                    'job_id': job_id,
                    'extranonce2': extranonce2,
                    'ntime': job['ntime'],
                    # LOCKED - do not change to '>I' (big-endian). See stratum-miner.mjs
                    # for the full explanation of why little-endian is correct here.
                    'nonce': struct.pack('<I', nonce).hex(),
                    'header_hex': header_hex,
                    'hash_le_hex': hash_le_hex,
                    'hash_be_hex': hash_be_hex,
                    'nonce_val': nonce,
                    'difficulty': difficulty,
                    'share_target': hex(target)
                })
                # Re-setup
                extranonce2 = binascii.hexlify(os.urandom(extranonce2_size)).decode()
                result_queue.put({
                    'type': 'status',
                    'message': f"Rotated thread to new extranonce2: {extranonce2}"
                })
                coinbase_hex = job['coinb1'] + extranonce1 + extranonce2 + job['coinb2']
                coinbase_hash = hashlib.sha256(hashlib.sha256(binascii.unhexlify(coinbase_hex)).digest()).digest()
                root = coinbase_hash
                for branch in merkle_branch:
                    combined = root + binascii.unhexlify(branch)
                    root = hashlib.sha256(hashlib.sha256(combined).digest()).digest()
                merkle_root_le = root
                header_prefix = version + prev_hash + merkle_root_le + ntime + nbits
                
            nonce = (nonce + 1) & 0xffffffff
            hashes += 1
            
            if hashes >= 30000:
                elapsed = time.time() - start_time
                result_queue.put({'type': 'hashrate', 'hashes': hashes, 'elapsed': elapsed})
                hashes = 0
                start_time = time.time()
    except KeyboardInterrupt:
        pass

def stop_local_mining():
    global active_processes, is_mining
    if active_processes:
        print("🛑 Stop request received. Stopping phone mining processes...")
        for p in active_processes:
            p.terminate()
            p.join()
        active_processes = []
    is_mining = False

def start_local_mining(job, difficulty, extranonce1, extranonce2_size, threads):
    global active_processes, is_mining, result_queue
    stop_local_mining()
    
    print(f"🚀 Starting {threads} SHA256 mining threads...")
    result_queue = multiprocessing.Queue()
    active_processes = []
    
    for i in range(threads):
        start_nonce = random.randint(0, 0x7fffffff)
        p = multiprocessing.Process(
            target=btc_mining_worker,
            args=(job, difficulty, extranonce1, extranonce2_size, start_nonce, result_queue)
        )
        p.daemon = True
        p.start()
        active_processes.append(p)
        
    is_mining = True

def poll_results():
    global current_hashrate, total_shares_found, result_queue, pending_logs, current_job_id
    if not is_mining or result_queue is None:
        current_hashrate = 0.0
        return
        
    # Read from queue
    hashes_sum = 0
    elapsed_sum = 0.0
    
    try:
        while not result_queue.empty():
            item = result_queue.get_nowait()
            if item['type'] == 'hashrate':
                hashes_sum += item['hashes']
                elapsed_sum += item['elapsed']
            elif item['type'] == 'share':
                if item['job_id'] != current_job_id:
                    print(f"🧹 Stale share discarded in worker queue (Job ID mismatch: {item['job_id']} vs current {current_job_id})")
                    continue
                total_shares_found += 1
                submit_share(
                    item['job_id'],
                    item['extranonce2'],
                    item['ntime'],
                    item['nonce'],
                    header_hex=item.get('header_hex'),
                    hash_le_hex=item.get('hash_le_hex'),
                    hash_be_hex=item.get('hash_be_hex'),
                    nonce_val=item.get('nonce_val'),
                    difficulty=item.get('difficulty'),
                    share_target=item.get('share_target')
                )
            elif item['type'] == 'status':
                print(f"💬 {item['message']}")
                pending_logs.append(item['message'])
    except Exception:
        pass
        
    if elapsed_sum > 0:
        # Calculate hashrate in KH/s
        current_hashrate = (hashes_sum / elapsed_sum) / 1000.0

def submit_share(job_id, extranonce2, ntime, nonce, header_hex=None, hash_le_hex=None, hash_be_hex=None, nonce_val=None, difficulty=None, share_target=None):
    """Report a found share to the PC Master Server."""
    global current_job_id

    if job_id != current_job_id:
        print(f"🧹 Stale share discarded locally (Job ID mismatch: {job_id} vs current {current_job_id})")
        return

    url = f"http://{MASTER_IP}:{MASTER_PORT}/api/worker/submit"
    payload = {
        "worker_name": WORKER_NAME + ("-demo" if IS_DEMO else ""),
        "job_id": job_id,
        "extranonce2": extranonce2,
        "ntime": ntime,
        "nonce": nonce
    }
    if header_hex:
        payload["header_hex"] = header_hex
    if hash_le_hex:
        payload["hash_le_hex"] = hash_le_hex
    if hash_be_hex:
        payload["hash_be_hex"] = hash_be_hex
    if nonce_val is not None:
        payload["nonce_val"] = nonce_val
    if difficulty is not None:
        payload["difficulty"] = difficulty
    if share_target is not None:
        payload["share_target"] = share_target
        
    try:
        req = urllib.request.Request(url)
        req.add_header('Content-Type', 'application/json')
        if DASHBOARD_TOKEN:
            req.add_header('X-Auth-Token', DASHBOARD_TOKEN)
        data = json.dumps(payload).encode('utf-8')
        with urllib.request.urlopen(req, data=data, timeout=3) as response:
            print(f"🎉 Share submitted successfully to master server! nonce={nonce}")
    except Exception as e:
        print(f"❌ Failed to submit share: {e}")

def send_heartbeat(temp, hashrate, shares_accepted, shares_rejected, uptime):
    """Send telemetry payload to the Bitcoin Master Server and receive mining directives."""
    global current_job_id, pending_logs
    url = f"http://{MASTER_IP}:{MASTER_PORT}/api/worker/heartbeat"
    payload = {
        "name": WORKER_NAME + ("-demo" if IS_DEMO else ""),
        "temp": temp,
        "hashrate": hashrate,
        "threads": current_threads,
        "max_cores": MAX_CORES,
        "shares_accepted": shares_accepted,
        "shares_rejected": shares_rejected,
        "uptime": uptime,
        "is_mining": is_mining,
        "is_demo": IS_DEMO,
        "job_id": current_job_id,
        "logs": list(pending_logs)
    }
    pending_logs.clear()
    
    try:
        req = urllib.request.Request(url)
        req.add_header('Content-Type', 'application/json')
        if DASHBOARD_TOKEN:
            req.add_header('X-Auth-Token', DASHBOARD_TOKEN)
        data = json.dumps(payload).encode('utf-8')
        
        with urllib.request.urlopen(req, data=data, timeout=2) as response:
            res_data = json.loads(response.read().decode())
            return res_data
    except Exception as e:
        print(f"⚠️ Master Server connection offline: {e}")
        return None

def main():
    global current_threads, total_shares_accepted, sim_shares, sim_uptime, current_hashrate, is_mining, current_job_id
    print(f"====================================================")
    print(f"📱 Redmi 13C Solo Bitcoin Worker Daemon started" + (" [DEMO MODE ACTIVE]" if IS_DEMO else ""))
    print(f"🔧 Worker Name: {WORKER_NAME}" + ("-demo" if IS_DEMO else ""))
    print(f"💻 Master Server IP: {MASTER_IP}:{MASTER_PORT}")
    print(f"====================================================")
    current_difficulty = None
    current_extranonce1 = None
    
    try:
        while True:
            # 1. Read temperature and poll hashrate
            temp = get_temperature()
            
            if IS_DEMO:
                sim_uptime += 5
                if is_mining:
                    current_hashrate = current_threads * 12.8 + random.uniform(-1.0, 1.0)
                    if random.random() < 0.12:
                        sim_shares += 1
                        submit_share("demo_job", "00000001", "5f5e1000", "00001234")
                else:
                    current_hashrate = 0.0
                
                hashrate = current_hashrate
                shares_accepted = sim_shares
                uptime = sim_uptime
            else:
                poll_results()
                hashrate = current_hashrate
                shares_accepted = total_shares_found
                uptime = int(time.time() - uptime_start)
                
            mode_prefix = "🎬 [Demo]" if IS_DEMO else "📊"
            print(f"{mode_prefix} Stats: {temp:.1f}°C | {hashrate:.1f} KH/s | Threads: {current_threads} | Mining: {is_mining} | Uptime: {uptime}s")
            
            # 2. Report heartbeat and receive config
            config = send_heartbeat(temp, hashrate, shares_accepted, 0, uptime)
            
            if config:
                target_threads = config.get("target_threads", current_threads)
                # Enforce hard ceiling of leaving at least 1 core free and max 7 threads active
                max_allowed_threads = max(1, min(7, MAX_CORES - 1))
                if target_threads > max_allowed_threads:
                    target_threads = max_allowed_threads
                is_mining_target = config.get("is_mining_target", False)
                job = config.get("job")
                difficulty = config.get("difficulty")
                extranonce1 = config.get("extranonce1")
                extranonce2_size = config.get("extranonce2Size", 4)
                
                # Check control directives
                if not is_mining_target:
                    if is_mining:
                        print("🛑 Server requested mining STOP.")
                        stop_local_mining()
                        current_job_id = None
                        current_difficulty = None
                        current_extranonce1 = None
                else:
                    # Server wants us to mine
                    job_id = job.get("jobId") if job else None
                    
                    difficulty_changed = (difficulty != current_difficulty)
                    extranonce1_changed = (extranonce1 != current_extranonce1)
                    job_changed = config.get("job_changed", False) or (job_id != current_job_id) or difficulty_changed or extranonce1_changed
                    
                    if not is_mining or target_threads != current_threads or (job and job_changed):
                        if not IS_DEMO:
                            if job and difficulty and extranonce1:
                                print(f"⚡ Server requested mining START/UPDATE with {target_threads} threads. (Job changed: {job_changed}, Diff changed: {difficulty_changed}, Extranonce1 changed: {extranonce1_changed})")
                                start_local_mining(job, difficulty, extranonce1, extranonce2_size, target_threads)
                                current_threads = target_threads
                                current_job_id = job_id
                                current_difficulty = difficulty
                                current_extranonce1 = extranonce1
                            else:
                                print("⏳ Waiting for valid job from server...")
                        else:
                            if not is_mining:
                                print(f"🎬 [Demo] Starting simulated mining with {target_threads} threads. (Job changed: {job_changed})")
                            elif target_threads != current_threads or job_changed:
                                print(f"🎬 [Demo] Updating simulated threads/job: {current_threads} -> {target_threads}")
                            is_mining = True
                            current_threads = target_threads
                            current_job_id = job_id
                            current_difficulty = difficulty
                            current_extranonce1 = extranonce1
            
            time.sleep(2)
            
    except KeyboardInterrupt:
        print("\n⏹️ Stopping worker daemon...")
    finally:
        stop_local_mining()

if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()