import os
import signal

def cleanup():
    mypid = os.getpid()
    print(f"Cleanup script PID: {mypid}")
    killed_count = 0
    
    # Iterate over all directories in /proc
    for pid_str in os.listdir('/proc'):
        if not pid_str.isdigit():
            continue
        pid = int(pid_str)
        if pid == mypid:
            continue
            
        try:
            with open(f'/proc/{pid_str}/cmdline', 'r') as f:
                cmdline = f.read()
            if 'stratum-miner.mjs' in cmdline or 'mock_pool_server.py' in cmdline:
                print(f"Found process to clean: PID {pid}, cmdline: {cmdline!r}")
                os.kill(pid, signal.SIGTERM)
                print(f"Killed process {pid}")
                killed_count += 1
        except Exception as e:
            pass

    print(f"Cleanup finished. Killed {killed_count} processes.")

if __name__ == '__main__':
    cleanup()
