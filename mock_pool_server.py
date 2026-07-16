#!/usr/bin/env python3
import socket
import json
import threading
import sys

def handle_client(client_socket):
    print("New miner client connected!")
    try:
        while True:
            data = client_socket.recv(4096)
            if not data:
                break
            
            lines = data.decode('utf-8').split('\n')
            for line in lines:
                if not line.strip():
                    continue
                print(f"Received from client: {line}")
                try:
                    req = json.loads(line)
                    method = req.get("method")
                    req_id = req.get("id")
                    
                    if method == "mining.subscribe":
                        resp = {
                            "id": req_id,
                            "result": [
                                [
                                    ["mining.set_difficulty", "1"],
                                    ["mining.notify", "1"]
                                ],
                                "dfaa9bda", # extranonce1
                                8 # extranonce2_size
                            ],
                            "error": None
                        }
                        client_socket.sendall((json.dumps(resp) + "\n").encode('utf-8'))
                        print(f"Sent subscribe response: {resp}")
                        
                    elif method == "mining.authorize":
                        resp = {
                            "id": req_id,
                            "result": True,
                            "error": None
                        }
                        client_socket.sendall((json.dumps(resp) + "\n").encode('utf-8'))
                        print(f"Sent authorize response: {resp}")
                        
                        # Immediately send set_difficulty with a very low difficulty (0.00001)
                        # A difficulty of 0.00001 means finding a share requires practically zero hashing effort
                        diff_msg = {
                            "id": None,
                            "method": "mining.set_difficulty",
                            "params": [0.0001]
                        }
                        client_socket.sendall((json.dumps(diff_msg) + "\n").encode('utf-8'))
                        print(f"Sent set_difficulty: {diff_msg}")
                        
                        # Send mock job notification
                        job_msg = {
                            "id": None,
                            "method": "mining.notify",
                            "params": [
                                "mock-job-1", # jobId
                                "4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000", # prevHash
                                "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff25032a1f06072f4254432e434f4d2f", # coinb1
                                "0d2f4d696e656420627920416e74677261766974792f00000000", # coinb2
                                [], # merkleBranch
                                "00000002", # blockVersion
                                "1c2ac4af", # nbits
                                "504e86b9", # ntime
                                True # cleanJobs
                            ]
                        }
                        client_socket.sendall((json.dumps(job_msg) + "\n").encode('utf-8'))
                        print(f"Sent mining.notify: {job_msg}")
                        
                    elif method == "mining.submit":
                        print(f"\n📢 RECEIVED SHARE SUBMISSION: {req}\n")
                        # Acknowledge the share acceptance
                        resp = {
                            "id": req_id,
                            "result": True,
                            "error": None
                        }
                        client_socket.sendall((json.dumps(resp) + "\n").encode('utf-8'))
                        print(f"Sent share acceptance response: {resp}")
                        
                except Exception as e:
                    print(f"Error parsing json: {e}")
    except Exception as e:
        print(f"Connection error: {e}")
    finally:
        client_socket.close()
        print("Miner client disconnected.")

def start_server():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        server.bind(("127.0.0.1", 3334))
        server.listen(5)
        print("Mock Stratum Server listening on 127.0.0.1:3334")
        while True:
            try:
                client, addr = server.accept()
                handle_client(client)
            except Exception as client_err:
                print(f"Client connection error: {client_err}")
    except Exception as e:
        print(f"Server error: {e}")
    finally:
        server.close()

if __name__ == '__main__':
    start_server()
