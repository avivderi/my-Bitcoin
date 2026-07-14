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

  // פונקציה לשמירת סטטיסטיקה לקובץ
  function saveStatsSync() {
    const totalKHs = workers.reduce((sum, w) => sum + (w.hashrateKHs || 0), 0);
    const uptimeSec = Math.floor((Date.now() - appStartTime) / 1000);
    const stats = {
      uptime_seconds: uptimeSec,
      shares_found: sharesFound,
      shares_accepted: sharesAccepted,
      hashrate_khs: parseFloat(totalKHs.toFixed(1)),
      total_hashes: totalHashesGlobal,
      difficulty: difficulty
    };
    try {
      fs.writeFileSync('stats.json', JSON.stringify(stats, null, 2));
      originalLog('💾 הסטטיסטיקה נשמרה בהצלחה ל-stats.json');
    } catch (err) {
      originalError('שגיאה בשמירת סטטיסטיקה:', err.message);
    }
  }

  // טעינת סטטיסטיקות קודמות מקובץ stats.json על מנת שהנתונים יישמרו בין הפעלות
  try {
    if (fs.existsSync('stats.json')) {
      const data = JSON.parse(fs.readFileSync('stats.json', 'utf8'));
      sharesFound = data.shares_found || 0;
      sharesAccepted = data.shares_accepted || 0;
      totalHashesGlobal = data.total_hashes || 0;
      console.log(`📊 נתונים קודמים נטענו מ-stats.json: נמצאו ${sharesFound}, התקבלו ${sharesAccepted}`);
    }
  } catch (e) {
    console.error('שגיאה בטעינת stats.json:', e.message);
  }

  let totalHashesGlobalOffset = totalHashesGlobal; // שמירה על היסט של ההאשים הקודמים
  const appStartTime = Date.now();

  const maxCoresConfig = parseInt(process.env.MAX_CORES || '0', 10);
  const configuredCores = maxCoresConfig > 0 ? Math.min(maxCoresConfig, os.cpus().length) : os.cpus().length;
  console.log(`💻 נמצאו ${os.cpus().length} ליבות (מתוכן יופעלו ${configuredCores}). מערכת Multi-threading מאותחלת...`);

  const workers = [];
  const pendingSubmissions = new Set();

  // פונקציה לניהול דינמי של כמות הוורקרים הפעילים בהתאם לעומס וטמפרטורה
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
            console.log(`🎉 [Worker] Share נמצא! שולח ל-Pool...`);
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
            worker.hashrateKHs = msg.hashrateKHs;
            totalHashesGlobal += msg.newHashes;
          }
        });
        
        // שליחת העבודה והקושי הנוכחיים לוורקר החדש אם קיימים
        if (currentJob) {
          worker.postMessage({ 
            type: 'job', 
            job: currentJob, 
            difficulty, 
            extranonce1, 
            extranonce2Size 
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

  // אתחול כמות הוורקרים הראשונית
  adjustWorkers(configuredCores);

  // הדפסת קצב גיבוב כולל למסך כל שתי שניות (בטרמינל)
  setInterval(() => {
    const totalKHs = workers.reduce((sum, w) => sum + (w.hashrateKHs || 0), 0);
    process.stdout.write(`\r⛏️  קצב כרייה כולל (${workers.length} ליבות): ${totalKHs.toFixed(1)} KH/s `);
  }, 2000);

  // כתיבת סטטיסטיקות לקובץ כל 10 דקות
  setInterval(saveStatsSync, 10 * 60 * 1000);

  function getCPUTemperature() {
    try {
      if (fs.existsSync('/sys/class/thermal')) {
        const zones = fs.readdirSync('/sys/class/thermal');
        let maxTemp = 0;
        for (const zone of zones) {
          if (zone.startsWith('thermal_zone')) {
            const typePath = `/sys/class/thermal/${zone}/type`;
            const tempPath = `/sys/class/thermal/${zone}/temp`;
            if (fs.existsSync(typePath) && fs.existsSync(tempPath)) {
              const type = fs.readFileSync(typePath, 'utf8').trim().toLowerCase();
              if (type.includes('cpu') || type.includes('pkg') || type.includes('core') || type.includes('acpi') || type.includes('soc')) {
                const tempStr = fs.readFileSync(tempPath, 'utf8').trim();
                const temp = parseFloat(tempStr) / 1000;
                if (temp > 0 && temp < 150) {
                  if (temp > maxTemp) {
                    maxTemp = temp;
                  }
                }
              }
            }
          }
        }
        if (maxTemp > 0) return maxTemp;
      }
    } catch (e) {
      // ignore
    }
    
    try {
      if (fs.existsSync('/sys/class/hwmon')) {
        const hwmonDirs = fs.readdirSync('/sys/class/hwmon');
        let maxTemp = 0;
        for (const dir of hwmonDirs) {
          const dirPath = `/sys/class/hwmon/${dir}`;
          const files = fs.readdirSync(dirPath);
          for (const file of files) {
            if (file.startsWith('temp') && file.endsWith('_input')) {
              const tempPath = `${dirPath}/${file}`;
              const tempStr = fs.readFileSync(tempPath, 'utf8').trim();
              const temp = parseFloat(tempStr) / 1000;
              if (temp > 0 && temp < 150) {
                if (temp > maxTemp) {
                  maxTemp = temp;
                }
              }
            }
          }
        }
        if (maxTemp > 0) return maxTemp;
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  let systemHealth = {
    status: 'ok',
    temp: null,
    load: 0,
    recommendation: null,
    activeCores: 0,
    configuredCores: 0
  };

  let hasAlertedTemp = false;

  function checkSystemHealth() {
    const temp = getCPUTemperature();
    const load = os.loadavg()[0];
    const totalCores = os.cpus().length;
    
    systemHealth.temp = temp;
    systemHealth.load = parseFloat(load.toFixed(1));
    systemHealth.configuredCores = configuredCores;
    
    let status = 'ok';
    let recommendation = null;
    let targetCores = configuredCores;
    
    // בדיקת טמפרטורה
    if (temp) {
      if (temp >= 85) {
        status = 'critical';
        targetCores = 1; // ירידה לליבה אחת במצב קריטי כדי לשמור על המחשב
        recommendation = `טמפרטורת המעבד קריטית (${temp.toFixed(1)}°C). עוצמת המחשוב הונמכה אוטומטית לליבה אחת כדי למנוע נזק.`;
        
        if (!hasAlertedTemp) {
          hasAlertedTemp = true;
          exec(`notify-send -u critical "⚠️ אזהרת חום מיינר" "טמפרטורת המעבד הגיעה ל-${temp.toFixed(1)}°C! עוצמת המחשוב הונמכה למינימום."`);
        }
      } else if (temp >= 80) {
        status = 'warning';
        targetCores = Math.max(1, Math.floor(configuredCores * 0.4)); // 40% מהליבות המוגדרות
        recommendation = `טמפרטורת המעבד גבוהה (${temp.toFixed(1)}°C). עוצמת המחשוב הונמכה אוטומטית ל-${targetCores} ליבות.`;
        hasAlertedTemp = false;
      } else if (temp >= 75) {
        status = 'warning';
        targetCores = Math.max(1, Math.floor(configuredCores * 0.7)); // 70% מהליבות המוגדרות
        recommendation = `טמפרטורת המעבד מתחממת (${temp.toFixed(1)}°C). עוצמת המחשוב הונמכה אוטומטית ל-${targetCores} ליבות.`;
        hasAlertedTemp = false;
      } else {
        hasAlertedTemp = false;
      }
    }
    
    // בדיקת עומס מערכת (אם ממוצע העומס עולה על מספר הליבות הכללי פי 1.3)
    if (status === 'ok' && load > totalCores * 1.3) {
      status = 'warning';
      targetCores = Math.max(1, Math.floor(configuredCores * 0.5)); // 50% מהליבות המוגדרות
      recommendation = `עומס המערכת גבוה מאוד (${load.toFixed(1)}). עוצמת המחשוב הונמכה אוטומטית ל-${targetCores} ליבות כדי להשאיר את המחשב מגיב.`;
    }
    
    // התאמת כמות הוורקרים הפעילים בהתאם ליעד שחושב
    adjustWorkers(targetCores);
    
    systemHealth.status = status;
    systemHealth.recommendation = recommendation;
    systemHealth.activeCores = workers.length;
  }
  
  // Start periodic check
  setInterval(checkSystemHealth, 5000);
  checkSystemHealth(); // initial check

  // ===== שרת Web (לוח בקרה אינטרנטי) =====
  http.createServer((req, res) => {
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
        logs: logs, // שליחת הלוגים האחרונים
        health: systemHealth
      };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(stats));
      return;
    }

    if (req.url === '/stop') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, message: 'Miner stopping...' }));
      console.log('🛑 התקבלה פקודת עצירה מרחוק מלוח הבקרה. מכבה את המיינר...');
      setTimeout(() => {
        handleExit();
      }, 500);
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
            body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f8fafc; text-align: center; padding: 2rem; margin: 0; min-height: 100vh; display: flex; flex-direction: column; justify-content: center; }
            .card { background: rgba(30, 41, 59, 0.6); backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; padding: 2.5rem; max-width: 650px; margin: 0 auto; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
            h1 { color: #f59e0b; margin-top: 0; font-size: 2rem; text-shadow: 0 0 15px rgba(245, 158, 11, 0.2); }
            .stat { margin: 1.2rem 0; font-size: 1.2rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255, 255, 255, 0.05); padding-bottom: 0.5rem; }
            .value { font-weight: bold; color: #38bdf8; font-size: 1.5rem; }
            .money { color: #10b981; font-size: 2.5rem; font-weight: bold; margin-top: 0.5rem; text-shadow: 0 0 10px rgba(16, 185, 129, 0.3); }
            .pulse { animation: pulse 2s infinite; }
            @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.6; } 100% { opacity: 1; } }
            
            /* עיצוב התראת בריאות */
            .alert-box {
              background: rgba(239, 68, 68, 0.15);
              border: 1px solid rgba(239, 68, 68, 0.35);
              color: #fca5a5;
              border-radius: 8px;
              padding: 1rem;
              margin-bottom: 1.5rem;
              text-align: right;
              display: none;
              align-items: center;
              gap: 10px;
              animation: slideIn 0.3s ease-out;
            }
            .alert-box.warning {
              background: rgba(245, 158, 11, 0.15);
              border: 1px solid rgba(245, 158, 11, 0.35);
              color: #fde047;
            }
            @keyframes slideIn {
              from { transform: translateY(-10px); opacity: 0; }
              to { transform: translateY(0); opacity: 1; }
            }
            .alert-title { font-weight: bold; margin-bottom: 0.25rem; font-size: 1.1rem; }
            .alert-desc { font-size: 0.95rem; line-height: 1.4; }
            
            /* כפתור עצירה */
            .stop-btn {
              background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
              color: white;
              border: none;
              padding: 0.75rem 1.5rem;
              font-size: 1.1rem;
              font-weight: bold;
              border-radius: 8px;
              cursor: pointer;
              transition: all 0.2s ease;
              box-shadow: 0 4px 15px rgba(239, 68, 68, 0.4);
              margin-top: 1rem;
              width: 100%;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              gap: 8px;
            }
            .stop-btn:hover {
              transform: translateY(-2px);
              box-shadow: 0 6px 20px rgba(239, 68, 68, 0.5);
              background: linear-gradient(135deg, #f87171 0%, #ef4444 100%);
            }
            .stop-btn:active {
              transform: translateY(0);
            }
            
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
              max-height: 180px; 
              overflow-y: auto; 
              white-space: pre-wrap; 
              direction: ltr; 
              margin-top: 0.5rem;
              box-shadow: inset 0 2px 8px rgba(0,0,0,0.8);
            }
            .health-grid {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 15px;
              margin: 1.5rem 0;
            }
            .health-item {
              background: rgba(255,255,255,0.03);
              border: 1px solid rgba(255,255,255,0.05);
              border-radius: 8px;
              padding: 0.75rem;
            }
            .health-label { font-size: 0.9rem; color: #94a3b8; }
            .health-value { font-size: 1.25rem; font-weight: bold; margin-top: 0.25rem; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>⛏️ סטטוס כרייה (Solo)</h1>
            
            <div id="alertBox" class="alert-box">
              <div style="font-size: 2rem;">⚠️</div>
              <div>
                <div class="alert-title" id="alertTitle">התרעת מערכת</div>
                <div class="alert-desc" id="alertDesc">טמפרטורת המעבד גבוהה מדי! מומלץ לכבות את הכרייה.</div>
              </div>
            </div>

            <div class="stat"><span>זמן ריצה:</span> <span id="uptime" class="value">0</span></div>
            <div class="stat"><span>קצב גיבוב:</span> <span id="hashrate" class="value pulse">0 KH/s</span></div>
            <div class="stat"><span>ליבות מחשוב פעילות:</span> <span id="activeCores" class="value">0 מתוך 0</span></div>
            <div class="stat"><span>מניות (Shares) שנשלחו:</span> <span id="shares" class="value">0</span></div>
            <div class="stat"><span>מניות שהתקבלו (Accepted):</span> <span id="accepted" class="value" style="color: #4ade80;">0</span></div>
            
            <div class="health-grid">
              <div class="health-item">
                <div class="health-label">🌡️ טמפרטורת מעבד</div>
                <div class="health-value" id="healthTemp">טוען...</div>
              </div>
              <div class="health-item">
                <div class="health-label">📊 עומס מערכת (Load)</div>
                <div class="health-value" id="healthLoad">טוען...</div>
              </div>
            </div>

            <button class="stop-btn" onclick="stopMiner()">🛑 עצור כרייה ושחרר מעבד</button>

            <hr style="border-color: rgba(255, 255, 255, 0.05); margin: 1.5rem 0;">
            <h3 style="margin: 0; font-size: 1.2rem;">ביטקוין שהורווח:</h3>
            <div id="money" class="money">0.00000000 ₿</div>
            
            <hr style="border-color: rgba(255, 255, 255, 0.05); margin: 1.5rem 0;">
            <h3 style="margin: 0 0 0.5rem 0; text-align: right; font-size: 1.1rem; color: #cbd5e1;">🖥️ פלט הטרמינל (Live Logs):</h3>
            <div id="terminal">טוען לוגים...</div>
          </div>
          
          <script>
            function formatTime(seconds) {
              const h = Math.floor(seconds / 3600);
              const m = Math.floor((seconds % 3600) / 60);
              return \`\${h} שעות, \${m} דקות\`;
            }
            
            async function stopMiner() {
              if (confirm('האם אתה בטוח שברצונך לעצור את הכרייה כעת?')) {
                try {
                  const res = await fetch('/stop');
                  const data = await res.json();
                  if (data.success) {
                    alert('הכרייה נעצרה בהצלחה! החלון ייסגר.');
                    window.close();
                    document.body.innerHTML = '<div class="card"><h1>🛑 הכרייה כובתה בהצלחה</h1><p>ניתן לסגור דף זה. כל ליבות המעבד שוחררו לחלוטין.</p></div>';
                  }
                } catch(e) {
                  alert('שגיאה בעצירת המיינר: ' + e.message);
                }
              }
            }

            async function fetchStats() {
              try {
                const res = await fetch('/stats');
                const data = await res.json();
                document.getElementById('uptime').innerText = formatTime(data.uptime_seconds);
                document.getElementById('hashrate').innerText = data.hashrate_khs + ' KH/s';
                document.getElementById('shares').innerText = data.shares_found;
                document.getElementById('accepted').innerText = data.shares_accepted;
                
                // עדכון ליבות פעילות
                const coresEl = document.getElementById('activeCores');
                coresEl.innerText = data.health.activeCores + ' מתוך ' + data.health.configuredCores;
                if (data.health.activeCores < data.health.configuredCores) {
                  coresEl.style.color = '#fbbf24'; // orange/yellow
                } else {
                  coresEl.style.color = '#38bdf8'; // blue
                }
                
                // עדכון מדדי בריאות
                const tempEl = document.getElementById('healthTemp');
                if (data.health.temp !== null) {
                  tempEl.innerText = data.health.temp.toFixed(1) + '°C';
                  if (data.health.temp >= 85) {
                    tempEl.style.color = '#f87171'; // red
                  } else if (data.health.temp >= 80) {
                    tempEl.style.color = '#fbbf24'; // orange
                  } else {
                    tempEl.style.color = '#4ade80'; // green
                  }
                } else {
                  tempEl.innerText = 'N/A';
                  tempEl.style.color = '#94a3b8';
                }

                const loadEl = document.getElementById('healthLoad');
                loadEl.innerText = data.health.load;
                if (data.health.status === 'warning' && data.health.temp === null) {
                  loadEl.style.color = '#fbbf24';
                } else {
                  loadEl.style.color = '#4ade80';
                }
                
                // התראות ובאנרים
                const alertBox = document.getElementById('alertBox');
                if (data.health.status !== 'ok') {
                  document.getElementById('alertDesc').innerText = data.health.recommendation;
                  alertBox.className = 'alert-box ' + data.health.status;
                  alertBox.style.display = 'flex';
                } else {
                  alertBox.style.display = 'none';
                }

                // עדכון הטרמינל
                const term = document.getElementById('terminal');
                const atBottom = term.scrollHeight - term.clientHeight <= term.scrollTop + 20;
                term.innerText = data.logs.join('\\n');
                
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

  function handleExit() {
    originalLog(`\n\nסיכום: ${sharesFound} shares נמצאו, ${sharesAccepted} התקבלו.`);
    saveStatsSync();
    if (socket) socket.end();
    workers.forEach(w => w.terminate());
    process.exit(0);
  }

  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);

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
  const headerBuf = Buffer.alloc(80);
  
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
