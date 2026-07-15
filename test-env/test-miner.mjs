import net from 'net';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { Worker, isMainThread, parentPort } from 'worker_threads';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

// ===== פונקציות עזר קריפטוגרפיות (משותפות) =====

const hasOneShotHash = typeof crypto.hash === 'function';

function sha256(buf) {
  if (hasOneShotHash) {
    return crypto.hash('sha256', buf, 'buffer');
  }
  return crypto.createHash('sha256').update(buf).digest();
}

function doubleSha256(buf) {
  if (hasOneShotHash) {
    return crypto.hash('sha256', crypto.hash('sha256', buf, 'buffer'), 'buffer');
  }
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

function hashToBigInt(buf) {
  const val0 = buf.readBigUInt64LE(0);
  const val1 = buf.readBigUInt64LE(8);
  const val2 = buf.readBigUInt64LE(16);
  const val3 = buf.readBigUInt64LE(24);
  return val0 | (val1 << 64n) | (val2 << 128n) | (val3 << 192n);
}

function calcShareTarget(diff) {
  const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
  return maxTarget / BigInt(Math.max(1, Math.floor(diff)));
}

if (isMainThread) {
  // ==========================================
  // MAIN THREAD LOGIC - ניהול הרשת והוורקרים
  // ==========================================

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;

  // ניקוי קובץ הלוג עם הפעלת השרת מחדש
  try {
    fs.writeFileSync('test-miner.log', '');
  } catch (e) {
    originalError('שגיאה בניקוי קובץ הלוג:', e.message);
  }

  function getLocalTimestamp() {
    const d = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function appendToLogFile(message) {
    try {
      fs.appendFileSync('test-miner.log', message + '\n');
    } catch (e) {
      originalError('שגיאה בכתיבה לקובץ הלוג:', e.message);
    }
  }

  console.log = (...args) => {
    const msg = args.join(' ');
    const timestamp = getLocalTimestamp();
    const logLine = `[${timestamp}] ${msg}`;
    logs.push(`[${timestamp.split(' ')[1]}] ${msg}`);
    if (logs.length > 50) logs.shift();
    originalLog.apply(console, args);
    appendToLogFile(logLine);
  };

  console.error = (...args) => {
    const msg = args.join(' ');
    const timestamp = getLocalTimestamp();
    const logLine = `[${timestamp}] ❌ ${msg}`;
    logs.push(`[${timestamp.split(' ')[1]}] ❌ ${msg}`);
    if (logs.length > 50) logs.shift();
    originalError.apply(console, args);
    appendToLogFile(logLine);
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
      // מתעלמים
    }
  }
  loadEnv();

  const POOL_HOST = 'localhost';
  const POOL_PORT = 3334;
  const BTC_ADDRESS = process.env.BTC_ADDRESS || 'bc1qXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const WORKER_NAME = 'test-worker';
  const HTTP_PORT = 0;

  let extranonce1 = null;
  let extranonce2Size = 4;
  let currentJob = null;
  let jobVersion = 0;
  let difficulty = 100000;
  let msgId = 1;
  const shareQueue = [];
  let sharesFound = 0;
  let sharesAccepted = 0;
  let totalHashesGlobal = 0;
  let bestDifficulty = 0;
  let bestDifficultyHash = '';

  function saveStatsSync() {
    const totalKHs = workers.reduce((sum, w) => sum + (w.hashrateKHs || 0), 0);
    const uptimeSec = Math.floor((Date.now() - appStartTime) / 1000);
    const stats = {
      uptime_seconds: uptimeSec,
      shares_found: sharesFound,
      shares_accepted: sharesAccepted,
      hashrate_khs: parseFloat(totalKHs.toFixed(1)),
      total_hashes: totalHashesGlobal,
      difficulty: difficulty,
      best_difficulty: bestDifficulty,
      best_difficulty_hash: bestDifficultyHash
    };
    try {
      const tempPath = 'test-stats.json.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(stats, null, 2));
      fs.renameSync(tempPath, 'test-stats.json');
      originalLog('💾 הסטטיסטיקה נשמרה בהצלחה ל-test-stats.json');
    } catch (err) {
      originalError('שגיאה בשמירת סטטיסטיקה:', err.message);
    }
  }

  try {
    if (fs.existsSync('test-stats.json')) {
      const data = JSON.parse(fs.readFileSync('test-stats.json', 'utf8'));
      sharesFound = data.shares_found || 0;
      sharesAccepted = data.shares_accepted || 0;
      totalHashesGlobal = data.total_hashes || 0;
      bestDifficulty = data.best_difficulty || 0;
      bestDifficultyHash = data.best_difficulty_hash || '';
      console.log(`📊 נתונים קודמים נטענו מ-test-stats.json: נמצאו ${sharesFound}, התקבלו ${sharesAccepted}, קושי שיא: ${bestDifficulty}`);
    }
  } catch (e) {
    console.error('שגיאה בטעינת test-stats.json:', e.message);
  }

  let totalHashesGlobalOffset = totalHashesGlobal;
  const appStartTime = Date.now();

  const configuredCores = 2; // הפעלה של 2 ליבות לצורך הטסטים
  console.log(`💻 [Test Mode] מערכת Multi-threading מאותחלת עם ${configuredCores} ליבות...`);

  const workers = [];
  const pendingSubmissions = new Set();

  function adjustWorkers(targetCores) {
    if (workers.length === targetCores) return;

    if (workers.length < targetCores) {
      const toAdd = targetCores - workers.length;
      console.log(`📈 מעלה עוצמת מחשוב: מוסיף ${toAdd} ליבות כרייה (סה"כ פעיל: ${targetCores}/${configuredCores})`);
      for (let i = 0; i < toAdd; i++) {
        const worker = new Worker(fileURLToPath(import.meta.url));
        worker.hashrateKHs = 0;
        worker.on('message', (msg) => {
          if (msg.type === 'share') {
            sharesFound++;
            saveStatsSync();
            console.log(`🎉 [Worker] Share נמצא! שולח ל-Pool...`);
            
            exec(`notify-send -u normal "⛏️ נמצאה מנייה (טסט)!" "שולח מניית כרייה לבריכת הדמו..."`);

            send('mining.submit', [
              `${BTC_ADDRESS}.${WORKER_NAME}`,
              msg.jobId,
              msg.extranonce2,
              msg.ntime,
              msg.nonce
            ]);
          } else if (msg.type === 'hashrate') {
            worker.hashrateKHs = msg.hashrateKHs;
            totalHashesGlobal += msg.newHashes;
          } else if (msg.type === 'best_difficulty') {
            if (msg.difficulty > bestDifficulty) {
              bestDifficulty = msg.difficulty;
              bestDifficultyHash = msg.hash;
              saveStatsSync();
              console.log(`🚀 קושי שיא חדש שנמצא על ידי המעבד: ${bestDifficulty.toFixed(4)} (האש: ${bestDifficultyHash})`);
              
              exec(`notify-send -u normal "🏆 שיא כרייה חדש (טסט)!" "נמצא האש בקושי שובר שיא של ${bestDifficulty.toFixed(4)}!"`);

              workers.forEach(w => w.postMessage({ type: 'best_difficulty', globalBestDifficulty: bestDifficulty }));
            }
          }
        });
        
        if (currentJob) {
          worker.postMessage({ 
            type: 'job', 
            job: currentJob, 
            difficulty, 
            extranonce1, 
            extranonce2Size,
            globalBestDifficulty: bestDifficulty
          });
        }
        workers.push(worker);
      }
    } else {
      const toRemove = workers.length - targetCores;
      console.log(`📉 מנמיך עוצמת מחשוב עקב חום/עומס: מסיים ${toRemove} ליבות כרייה (סה"כ פעיל: ${targetCores}/${configuredCores})`);
      for (let i = 0; i < toRemove; i++) {
        const worker = workers.pop();
        if (worker) {
          worker.terminate();
        }
      }
    }
  }

  adjustWorkers(1);

  setInterval(() => {
    const totalKHs = workers.reduce((sum, w) => sum + (w.hashrateKHs || 0), 0);
    process.stdout.write(`\r⛏️  קצב כרייה כולל (${workers.length} ליבות): ${totalKHs.toFixed(1)} KH/s `);
  }, 2000);

  setInterval(saveStatsSync, 10 * 60 * 1000);

  function getCPUTemperature() {
    return 45; // טמפרטורה מדומה לצורך בדיקות יציבות ללא התחממות
  }

  let systemHealth = {
    status: 'ok',
    temp: 45,
    load: 1.0,
    recommendation: null,
    activeCores: 1,
    configuredCores: 2
  };

  let hasAlertedTemp = false;
  let currentRampLimit = 1;
  let isFirstHealthCheck = true;

  function checkSystemHealth() {
    const temp = getCPUTemperature();
    const load = 1.0;
    
    systemHealth.temp = temp;
    systemHealth.load = load;
    systemHealth.configuredCores = configuredCores;
    
    let status = 'ok';
    let recommendation = null;
    let targetCores = configuredCores;
    
    if (currentRampLimit < configuredCores) {
      if (isFirstHealthCheck) {
        isFirstHealthCheck = false;
      } else {
        currentRampLimit++;
        console.log(`🐌 הרצה הדרגתית (Ramp-up): מעלה מגבלת ליבות ל-${currentRampLimit}/${configuredCores}`);
      }
    }
    targetCores = currentRampLimit;
    
    adjustWorkers(targetCores);
    
    systemHealth.status = status;
    systemHealth.recommendation = recommendation;
    systemHealth.activeCores = workers.length;
  }
  
  setInterval(checkSystemHealth, 3000);
  checkSystemHealth();

  // ===== שרת Web =====
  const server = http.createServer((req, res) => {
    if (req.url === '/stats') {
      const uptimeSec = Math.floor((Date.now() - appStartTime) / 1000);
      const totalKHs = workers.reduce((sum, w) => sum + (w.hashrateKHs || 0), 0);
      const stats = {
        uptime_seconds: uptimeSec,
        shares_found: sharesFound,
        shares_accepted: sharesAccepted,
        hashrate_khs: parseFloat(totalKHs.toFixed(1)),
        total_hashes: totalHashesGlobal,
        difficulty: difficulty,
        logs: logs,
        health: systemHealth,
        best_difficulty: bestDifficulty,
        best_difficulty_hash: bestDifficultyHash
      };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(stats));
      return;
    }

    if (req.url === '/stop') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, message: 'Test Miner stopping...' }));
      console.log('🛑 התקבלה פקודת עצירה למיינר הבדיקות.');
      setTimeout(() => {
        handleExit();
      }, 500);
      return;
    }

    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>דף בדיקת מיינר דמו</h1><p>לוח הבקרה של המיינר דמו פעיל.</p>`);
      return;
    }
    
    res.writeHead(404);
    res.end('Not Found');
  }).listen(HTTP_PORT, () => {
    const port = server.address().port;
    console.log(`🌐 לוח בקרה אינטרנטי של הבדיקות זמין בכתובת: http://localhost:${port}`);
  });

  let socket = null;
  let reconnectWait = 1000;
  let isReconnecting = false;

  function connectToPool() {
    if (socket) socket.destroy();
    
    socket = new net.Socket();
    
    socket.connect(POOL_PORT, POOL_HOST, () => {
      console.log(`✅ מחובר לשרת דמו: ${POOL_HOST}:${POOL_PORT}`);
      reconnectWait = 1000;
      isReconnecting = false;
      send('mining.subscribe', ['nodejs-miner/1.0']);
    });

    socket.on('error', (err) => {
      console.error(`שגיאת חיבור לשרת דמו: ${err.message}`);
    });

    socket.on('close', () => {
      console.log('🔌 החיבור לשרת דמו נסגר');
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
    console.log(`⏳ מנסה להתחבר מחדש לשרת דמו בעוד ${reconnectWait / 1000} שניות...`);
    setTimeout(() => {
      connectToPool();
    }, reconnectWait);
    reconnectWait = Math.min(reconnectWait * 2, 10000);
  }

  function send(method, params) {
    if (method === 'mining.submit') {
      if (!socket || socket.destroyed || !socket.writable) {
        console.warn(`⚠️ חיבור מנותק! שומר בתור...`);
        shareQueue.push({ method, params });
        return;
      }
      pendingSubmissions.add(msgId);
    }
    if (!socket || socket.destroyed) return;
    const msg = { id: msgId++, method, params };
    socket.write(JSON.stringify(msg) + '\n');
  }

  function handleMessage(msg) {
    if (msg.id && pendingSubmissions.has(Number(msg.id))) {
      pendingSubmissions.delete(Number(msg.id));
      console.log(`📡 [Mock Pool Response] מזהה ${msg.id}: תוצאה=${JSON.stringify(msg.result)}, שגיאה=${JSON.stringify(msg.error)}`);
      if (msg.result === true || (msg.result && !msg.error)) {
        sharesAccepted++;
        saveStatsSync();
        console.log(`✅ Share אושר על ידי שרת הדמו! (סה"כ Accepted: ${sharesAccepted})`);
        exec(`notify-send -u normal "✅ מנייה אושרה (טסט)!" "שרת הדמו קיבל ואישר את המנייה!"`);
      } else {
        console.log(`⚠️ Share נדחה על ידי שרת הדמו. שגיאה: ${JSON.stringify(msg.error)}`);
        exec(`notify-send -u normal "⚠️ מנייה נדחתה (טסט)" "שרת הדמו דחה את המנייה: ${msg.error[1]}"`);
      }
      return;
    }

    if (msg.id === 1 && msg.result) {
      extranonce1 = msg.result[1];
      extranonce2Size = msg.result[2];
      console.log(`📡 נרשם בהצלחה מול שרת הדמו | extranonce1=${extranonce1}`);
      send('mining.authorize', [`${BTC_ADDRESS}.${WORKER_NAME}`, 'x']);
      return;
    }

    if (msg.id === 2) {
      if (msg.result === true) {
        console.log(`🔐 חיבור אושר מול שרת הדמו (Authorized)!`);
      } else {
        console.error(`❌ אישור חיבור נכשל מול שרת הדמו: ${JSON.stringify(msg.error)}`);
      }
      return;
    }

    if (msg.method === 'mining.set_difficulty') {
      difficulty = msg.params[0];
      console.log(`🎯 שרת הדמו קבע קושי חדש: ${difficulty}`);
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
        extranonce2Size,
        globalBestDifficulty: bestDifficulty
      }));
      return;
    }
  }

  connectToPool();

  function handleExit() {
    originalLog(`\n\nסיכום בדיקה: ${sharesFound} מניות נמצאו, ${sharesAccepted} מניות אושרו.`);
    saveStatsSync();
    if (socket) socket.end();
    workers.forEach(w => w.terminate());
    try {
      server.close(() => {
        process.exit(0);
      });
    } catch (e) {
      process.exit(0);
    }
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  }

  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);

} else {
  // WORKER THREAD LOGIC
  let currentJob = null;
  let difficulty = 100000;
  let extranonce1 = null;
  let extranonce2Size = 4;
  
  let nonce = 0;
  let extranonce2 = null;
  let shareTarget = null;
  
  let prevHashBuf, versionBuf, nbitsBuf, ntimeBuf, merkleBranch;
  let headerPrefixBuf;
  const headerBuf = Buffer.alloc(80);
  
  let miningLoopRunning = false;
  let startTime = Date.now();
  let localHashes = 0;
  let bestHashValue = null;

  parentPort.on('message', (msg) => {
    if (msg.type === 'difficulty') {
      difficulty = msg.difficulty;
      shareTarget = calcShareTarget(difficulty);
    } 
    else if (msg.type === 'best_difficulty') {
      if (msg.globalBestDifficulty && msg.globalBestDifficulty > 0) {
        const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
        const targetForGlobalBest = BigInt(Math.floor(Number(maxTarget) / msg.globalBestDifficulty));
        if (bestHashValue === null || targetForGlobalBest < bestHashValue) {
          bestHashValue = targetForGlobalBest;
        }
      }
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
      
      if (msg.globalBestDifficulty && msg.globalBestDifficulty > 0) {
        const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
        const targetForGlobalBest = BigInt(Math.floor(Number(maxTarget) / msg.globalBestDifficulty));
        if (bestHashValue === null || targetForGlobalBest < bestHashValue) {
          bestHashValue = targetForGlobalBest;
        }
      }
      
      setupNewExtranonce2();
      
      if (!miningLoopRunning) {
        miningLoopRunning = true;
        mineChunk();
      }
      
      if (!global.testShareInterval) {
        global.testShareInterval = setInterval(() => {
          if (currentJob) {
            parentPort.postMessage({
              type: 'share',
              jobId: currentJob.jobId,
              extranonce2: extranonce2 || '00000000',
              ntime: currentJob.ntime,
              nonce: '00001234'
            });
          }
        }, 4000);
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
    headerPrefixBuf.copy(headerBuf, 0, 0, 76);
  }
  
  function mineChunk() {
    if (!currentJob) {
      miningLoopRunning = false;
      return;
    }
    
    const chunkSize = 50000;
    const maxNonce = 0xffffffff;
    
    for (let i = 0; i < chunkSize && nonce <= maxNonce; i++, nonce++) {
      headerBuf.writeUInt32LE(nonce, 76);
      const hash = doubleSha256(headerBuf);
      const hashValue = hashToBigInt(hash);
      
      if (bestHashValue === null || hashValue < bestHashValue) {
        bestHashValue = hashValue;
        const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
        const diff = Number(maxTarget) / Number(hashValue);
        parentPort.postMessage({
          type: 'best_difficulty',
          difficulty: diff,
          hash: reverseBytes(hash).toString('hex')
        });
      }
      
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
