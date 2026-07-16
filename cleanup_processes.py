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
            if 'stratum-miner.mjs' in cmdline:
                # Check if it's the current running one we just started
                # Wait, our current running one has its own PID. We can find it by checking if it matches the parent process or if it's in the log.
                # Actually, let's print it first.
                print(f"Found miner process: PID {pid}, cmdline: {cmdline!r}")
                # We want to kill other instances, but how do we know which one is the one we just started?
                # We can check its start time or just kill all of them, and then we will restart it cleanly!
                # Yes, killing all stratum-miner.mjs processes (including the one we just started) is the cleanest way.
                # Then we start a fresh one, knowing no other instances exist!
                os.kill(pid, signal.SIGTERM)
                print(f"Killed process {pid}")
                killed_count += 1
        except Exception as e:
            pass

    print(f"Cleanup finished. Killed {killed_count} processes.")

if __name__ == '__main__':
    cleanup()
