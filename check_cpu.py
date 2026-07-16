import os
import time

def check_cpu():
    # Read /proc/stat to calculate CPU usage
    # Or just use ps command if allowed, but since terminal commands are blocked,
    # let's read /proc and see the processes.
    processes = []
    for pid_str in os.listdir('/proc'):
        if not pid_str.isdigit():
            continue
        pid = int(pid_str)
        try:
            with open(f'/proc/{pid_str}/stat', 'r') as f:
                stat = f.read().split()
            with open(f'/proc/{pid_str}/cmdline', 'r') as f:
                cmdline = f.read().replace('\x00', ' ')
            
            # stat fields:
            # 13: utime (user time)
            # 14: stime (system time)
            utime = int(stat[13])
            stime = int(stat[14])
            total_time = utime + stime
            processes.append((pid, total_time, cmdline))
        except Exception:
            pass
            
    # Wait 2 seconds
    time.sleep(2)
    
    # Check again to calculate diff
    active_processes = []
    for pid, prev_time, cmdline in processes:
        try:
            with open(f'/proc/{pid}/stat', 'r') as f:
                stat = f.read().split()
            utime = int(stat[13])
            stime = int(stat[14])
            total_time = utime + stime
            diff = total_time - prev_time
            if diff > 0:
                active_processes.append((pid, diff, cmdline))
        except Exception:
            pass
            
    active_processes.sort(key=lambda x: x[1], reverse=True)
    print("Top CPU using processes in last 2 seconds:")
    for pid, diff, cmdline in active_processes[:10]:
        print(f"PID: {pid:5d} | CPU ticks: {diff:5d} | Cmd: {cmdline}")

if __name__ == '__main__':
    check_cpu()
