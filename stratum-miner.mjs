import net from 'net';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { Worker, isMainThread, parentPort } from 'worker_threads';
import { fileURLToPath } from 'url';

// ===== פונקציות עזר קריפטוגרפיות (משותפות) =====

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function doubleSha256(buf) {
  return sha256(sha256(buf));
}

function reverseBytes(buf) {
  return Buffer.from(buf).reverse();
}

function swapEndianWords(hex) {
  const buf = Buffer.from(hex, 'hex');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i += 4) {
    out[i] = buf[i + 3];
    out[i + 1] = buf[i + 2];
    out[i + 2] = buf[i + 1];
    out[i + 3] = buf[i];
  }
  return out;
}

function packUInt32LE(hexOrNum) {
  const buf = Buffer.alloc(4);
  const num = typeof hexOrNum === 'string' ? parseInt(hexOrNum, 16) : hexOrNum;
  buf.writeUInt32LE(num >>> 0, 0);
  return buf;
}

function buildMerkleRoot(coinbaseHash, merkleBranch) {
  let root = coinbaseHash;
  for (const branch of merkleBranch) {
    root = doubleSha256(Buffer.concat([root, Buffer.from(branch, 'hex')]));
  }
  return root;
}

function hashToBigInt(hashBuf) {
  return BigInt('0x' + reverseBytes(hashBuf).toString('hex'));
}

function calcShareTarget(diff) {
  const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
  return maxTarget / BigInt(Math.max(1, Math.floor(diff)));
}

if (isMainThread) {
  // ==========================================
  // MAIN THREAD LOGIC - ניהול הרשת והוורקרים
  // ==========================================

  // מערך לשמירת הלוגים האחרונים (עבור דף האינטרנט)
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args) => {
    const msg = args.join(' ');
    const timestamp = new Date().toLocaleTimeString();
    logs.push(`[${timestamp}] ${msg}`);
    if (logs.length > 50) logs.shift();
    originalLog.apply(console, args);
  };

  console.error = (...args) => {
    const msg = args.join(' ');
    const timestamp = new Date().toLocaleTimeString();
    logs.push(`[${timestamp}] ❌ ${msg}`);
    if (logs.length > 50) logs.shift();
    originalError.apply(console, args);
  };

  function loadEnv() {
    try {
      const envFile = fs.readFileSync('.env', 'utf8');
      envFile.split('\n').forEach(line => {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match) {
          let key = match[1];
          let value = match[2] || '';
          value = value.replace(/^['"]|['"]$/g, '').trim();
          process.env[key] = value;
        }
      });
    } catch (e) {
      // מתעלמים אם אין קובץ .env
    }
  }
  loadEnv();

  const POOL_HOST = process.env.POOL_HOST || 'public-pool.io';
  const POOL_PORT = parseInt(process.env.POOL_PORT || '3333', 10);
  const BTC_ADDRESS = process.env.BTC_ADDRESS || 'bc1qXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const WORKER_NAME = process.env.WORKER_NAME || 'nodejs-worker';
  const HTTP_PORT = process.env.HTTP_PORT || 3224;

  let extranonce1 = null;
  let extranonce2Size = 4;
  let currentJob = null;
  let jobVersion = 0;
  let difficulty = 1;
  let msgId = 1;
  let sharesFound = 0;
  let sharesAccepted = 0;

  let totalHashesGlobal = 0;
  const appStartTime = Date.now();

  const maxCoresConfig = parseInt(process.env.MAX_CORES || '0', 10);
  const numCores = maxCoresConfig > 0 ? Math.min(maxCoresConfig, os.cpus().length) : os.cpus().length;
  console.log(`💻 נמצאו ${os.cpus().length} ליבות (מתוכן יופעלו ${numCores}). מערכת Multi-threading מאותחלת...`);

  const workers = [];
  const workerHashrates = new Array(numCores).fill(0);
  const pendingSubmissions = new Set();

  // יצירת הוורקרים
  for (let i = 0; i < numCores; i++) {
    const worker = new Worker(fileURLToPath(import.meta.url));
    worker.on('message', (msg) => {
      if (msg.type === 'share') {
        sharesFound++;
        console.log(`🎉 [Worker ${i}] Share נמצא! שולח ל-Pool...`);
        const submitId = msgId;
        pendingSubmissions.add(submitId);
        send('mining.submit', [
          `${BTC_ADDRESS}.${WORKER_NAME}`,
          msg.jobId,
          msg.extranonce2,
          msg.ntime,
          msg.nonce
        ]);
      } else if (msg.type === 'hashrate') {
        workerHashrates[i] = msg.hashrateKHs;
        totalHashesGlobal += msg.newHashes;
      }
    });
    workers.push(worker);
  }

  // הדפסת קצב גיבוב כולל למסך כל שתי שניות (בטרמינל)
  setInterval(() => {
    const totalKHs = workerHashrates.reduce((a, b) => a + b, 0);
    process.stdout.write(`\r⛏️  קצב כרייה כולל (${numCores} ליבות): ${totalKHs.toFixed(1)} KH/s `);
  }, 2000);

  // כתיבת סטטיסטיקות לקובץ כל 10 דקות
  setInterval(() => {
    const uptimeSec = Math.floor((Date.now() - appStartTime) / 1000);
    const totalKHs = workerHashrates.reduce((a, b) => a + b, 0);
    const stats = {
      uptime_seconds: uptimeSec,
      shares_found: sharesFound,
      shares_accepted: sharesAccepted,
      hashrate_khs: parseFloat(totalKHs.toFixed(1)),
      total_hashes: totalHashesGlobal,
      difficulty: difficulty
    };
    fs.writeFile('stats.json', JSON.stringify(stats, null, 2), (err) => {
      if (err) console.error('שגיאה בשמירת סטטיסטיקה:', err.message);
    });
  }, 10 * 60 * 1000);

  // ===== שרת Web (לוח בקרה אינטרנטי) =====
  http.createServer((req, res) => {
    if (req.url === '/stats') {
      const uptimeSec = Math.floor((Date.now() - appStartTime) / 1000);
      const totalKHs = workerHashrates.reduce((a, b) => a + b, 0);
      const stats = {
        uptime_seconds: uptimeSec,
        shares_found: sharesFound,
        shares_accepted: sharesAccepted,
        hashrate_khs: parseFloat(totalKHs.toFixed(1)),
        total_hashes: totalHashesGlobal,
        difficulty: difficulty,
        logs: logs // שליחת הלוגים האחרונים
      };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(stats));
      return;
    }

    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html dir="rtl" lang="he">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>לוח בקרה - כורה ביטקוין</title>
          <style>
            body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; text-align: center; padding: 2rem; margin: 0; }
            .card { background: #1e293b; border-radius: 12px; padding: 2rem; max-width: 650px; margin: 0 auto; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
            h1 { color: #f59e0b; margin-top: 0; }
            .stat { margin: 1.2rem 0; font-size: 1.2rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; }
            .value { font-weight: bold; color: #38bdf8; font-size: 1.5rem; }
            .money { color: #10b981; font-size: 2.5rem; font-weight: bold; margin-top: 0.5rem; text-shadow: 0 0 10px rgba(16, 185, 129, 0.3); }
            .pulse { animation: pulse 2s infinite; }
            @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
            
            /* עיצוב טרמינל הלוגים */
            #terminal { 
              background: #020617; 
              border: 1px solid #334155; 
              border-radius: 8px; 
              padding: 1rem; 
              text-align: left; 
              font-family: monospace; 
              font-size: 0.85rem; 
              color: #34d399; 
              max-height: 200px; 
              overflow-y: auto; 
              white-space: pre-wrap; 
              direction: ltr; 
              margin-top: 0.5rem;
              box-shadow: inset 0 2px 8px rgba(0,0,0,0.8);
            }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>⛏️ סטטוס כרייה (Solo)</h1>
            <div class="stat"><span>זמן ריצה:</span> <span id="uptime" class="value">0</span></div>
            <div class="stat"><span>קצב גיבוב:</span> <span id="hashrate" class="value pulse">0 KH/s</span></div>
            <div class="stat"><span>מניות (Shares) שנשלחו:</span> <span id="shares" class="value">0</span></div>
            <div class="stat"><span>מניות שהתקבלו (Accepted):</span> <span id="accepted" class="value" style="color: #4ade80;">0</span></div>
            
            <hr style="border-color: #334155; margin: 1.5rem 0;">
            <h3 style="margin: 0;">ביטקוין שהורווח:</h3>
            <div id="money" class="money">0.00000000 ₿</div>
            
            <hr style="border-color: #334155; margin: 1.5rem 0;">
            <h3 style="margin: 0; text-align: right; font-size: 1.1rem; color: #cbd5e1;">🖥️ פלט הטרמינל (Live Logs):</h3>
            <div id="terminal">טוען לוגים...</div>
          </div>
          
          <script>
            function formatTime(seconds) {
              const h = Math.floor(seconds / 3600);
              const m = Math.floor((seconds % 3600) / 60);
              return \`\${h} שעות, \${m} דקות\`;
            }
            async function fetchStats() {
              try {
                const res = await fetch('/stats');
                const data = await res.json();
                document.getElementById('uptime').innerText = formatTime(data.uptime_seconds);
                document.getElementById('hashrate').innerText = data.hashrate_khs + ' KH/s';
                document.getElementById('shares').innerText = data.shares_found;
                document.getElementById('accepted').innerText = data.shares_accepted;
                
                // עדכון הטרמינל
                const term = document.getElementById('terminal');
                const atBottom = term.scrollHeight - term.clientHeight <= term.scrollTop + 20;
                term.innerText = data.logs.join('\\n');
                
                // גלילה אוטומטית למטה רק אם המשתמש כבר היה למטה
                if (atBottom) {
                  term.scrollTop = term.scrollHeight;
                }
              } catch (e) {
                console.error(e);
              }
            }
            setInterval(fetchStats, 2000);
            fetchStats();
          </script>
        </body>
        </html>
      `);
      return;
    }
    
    res.writeHead(404);
    res.end('Not Found');
  }).listen(HTTP_PORT, () => {
    console.log(`🌐 לוח בקרה אינטרנטי זמין בכתובת: http://localhost:${HTTP_PORT}`);
  });

  // ניהול החיבור (Socket)
  let socket = null;
  let reconnectWait = 1000;
  let isReconnecting = false;

  function connectToPool() {
    if (socket) socket.destroy();
    
    socket = new net.Socket();
    
    socket.connect(POOL_PORT, POOL_HOST, () => {
      console.log(`✅ מחובר ל-${POOL_HOST}:${POOL_PORT}`);
      reconnectWait = 1000;
      isReconnecting = false;
      send('mining.subscribe', ['nodejs-miner/1.0']);
    });

    socket.on('error', (err) => {
      console.error(`שגיאת חיבור: ${err.message}`);
    });

    socket.on('close', () => {
      console.log('🔌 החיבור נסגר');
      scheduleReconnect();
    });

    let rxBuffer = '';
    socket.on('data', (data) => {
      rxBuffer += data.toString();
      const lines = rxBuffer.split('\n');
      rxBuffer = lines.pop(); 
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch (e) {
          console.error(`שגיאת פענוח הודעה: ${e.message}`);
        }
      }
    });
  }

  function scheduleReconnect() {
    if (isReconnecting) return;
    isReconnecting = true;
    console.log(`⏳ מנסה להתחבר מחדש בעוד ${reconnectWait / 1000} שניות...`);
    setTimeout(() => {
      connectToPool();
    }, reconnectWait);
    reconnectWait = Math.min(reconnectWait * 2, 30000);
  }

  function send(method, params) {
    if (!socket || socket.destroyed) return;
    const msg = { id: msgId++, method, params };
    socket.write(JSON.stringify(msg) + '\n');
  }

  function handleMessage(msg) {
    // בדיקה אם מדובר בתגובה לשליחת Share
    if (msg.id && pendingSubmissions.has(msg.id)) {
      pendingSubmissions.delete(msg.id);
      if (msg.result === true) {
        sharesAccepted++;
        console.log(`✅ Share התקבל בשרת! (סה"כ Accepted: ${sharesAccepted})`);
      } else if (msg.error) {
        console.log(`⚠️ Share נדחה על ידי השרת: ${JSON.stringify(msg.error)}`);
      }
      return;
    }

    if (msg.id === 1 && msg.result) {
      extranonce1 = msg.result[1];
      extranonce2Size = msg.result[2];
      console.log(`📡 נרשם בהצלחה | extranonce1=${extranonce1}`);
      send('mining.authorize', [`${BTC_ADDRESS}.${WORKER_NAME}`, 'x']);
      return;
    }

    if (msg.method === 'mining.set_difficulty') {
      difficulty = msg.params[0];
      console.log(`🎯 קושי חדש: ${difficulty}`);
      workers.forEach(w => w.postMessage({ type: 'difficulty', difficulty }));
      return;
    }

    if (msg.method === 'mining.notify') {
      jobVersion++;
      currentJob = {
        version: jobVersion,
        jobId: msg.params[0],
        prevHash: msg.params[1],
        coinb1: msg.params[2],
        coinb2: msg.params[3],
        merkleBranch: msg.params[4],
        blockVersion: msg.params[5],
        nbits: msg.params[6],
        ntime: msg.params[7],
        cleanJobs: msg.params[8],
      };
      
      workers.forEach(w => w.postMessage({ 
        type: 'job', 
        job: currentJob, 
        difficulty, 
        extranonce1, 
        extranonce2Size 
      }));
      return;
    }
  }

  connectToPool();

  process.on('SIGINT', () => {
    console.log(`\n\nסיכום: ${sharesFound} shares נמצאו, ${sharesAccepted} התקבלו.`);
    if (socket) socket.end();
    workers.forEach(w => w.terminate());
    process.exit(0);
  });

} else {
  // ==========================================
  // WORKER THREAD LOGIC - כרייה מאומצת
  // ==========================================

  let currentJob = null;
  let difficulty = 1;
  let extranonce1 = null;
  let extranonce2Size = 4;
  
  let nonce = 0;
  let extranonce2 = null;
  let shareTarget = null;
  
  let prevHashBuf, versionBuf, nbitsBuf, ntimeBuf, merkleBranch;
  let headerPrefixBuf; 
  
  let miningLoopRunning = false;
  let startTime = Date.now();
  let localHashes = 0;

  parentPort.on('message', (msg) => {
    if (msg.type === 'difficulty') {
      difficulty = msg.difficulty;
      shareTarget = calcShareTarget(difficulty);
    } 
    else if (msg.type === 'job') {
      currentJob = msg.job;
      difficulty = msg.difficulty;
      extranonce1 = msg.extranonce1;
      extranonce2Size = msg.extranonce2Size;
      
      shareTarget = calcShareTarget(difficulty);
      prevHashBuf = swapEndianWords(currentJob.prevHash);
      versionBuf = packUInt32LE(currentJob.blockVersion);
      nbitsBuf = packUInt32LE(currentJob.nbits);
      ntimeBuf = packUInt32LE(currentJob.ntime);
      merkleBranch = currentJob.merkleBranch;
      
      setupNewExtranonce2();
      
      if (!miningLoopRunning) {
        miningLoopRunning = true;
        mineChunk();
      }
    }
  });

  function setupNewExtranonce2() {
    extranonce2 = crypto.randomBytes(extranonce2Size).toString('hex');
    nonce = 0;
    
    const coinbaseHex = currentJob.coinb1 + extranonce1 + extranonce2 + currentJob.coinb2;
    const coinbaseHash = doubleSha256(Buffer.from(coinbaseHex, 'hex'));
    const merkleRootBuf = buildMerkleRoot(coinbaseHash, merkleBranch);
    
    headerPrefixBuf = Buffer.concat([versionBuf, prevHashBuf, merkleRootBuf, ntimeBuf, nbitsBuf]);
  }
  
  function mineChunk() {
    if (!currentJob) {
      miningLoopRunning = false;
      return;
    }
    
    const chunkSize = 50000;
    const maxNonce = 0xffffffff;
    
    for (let i = 0; i < chunkSize && nonce <= maxNonce; i++, nonce++) {
      const nonceBuf = packUInt32LE(nonce);
      const header = Buffer.concat([headerPrefixBuf, nonceBuf]);
      const hash = doubleSha256(header);
      const hashValue = hashToBigInt(hash);
      
      if (hashValue <= shareTarget) {
        const nonceHex = packUInt32LE(nonce).toString('hex');
        parentPort.postMessage({
          type: 'share',
          jobId: currentJob.jobId,
          extranonce2: extranonce2,
          ntime: currentJob.ntime,
          nonce: nonceHex
        });
      }
    }
    
    localHashes += chunkSize;
    const elapsedSec = (Date.now() - startTime) / 1000;
    
    if (elapsedSec >= 2) {
      parentPort.postMessage({
        type: 'hashrate',
        hashrateKHs: (localHashes / elapsedSec / 1000),
        newHashes: localHashes
      });
      startTime = Date.now();
      localHashes = 0;
    }
    
    if (nonce > maxNonce) {
      setupNewExtranonce2(); 
    }
    
    setImmediate(mineChunk);
  }
}
