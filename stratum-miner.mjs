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
  const demoLogs = [];
  let phonesMiningEnabled = true;
  let demoModeActive = false;
  let miningPaused = false;
  const remoteWorkers = new Map();
  const originalLog = console.log;
  const originalError = console.error;

  // ניקוי קבצי הלוג עם הפעלת השרת מחדש
  try {
    fs.writeFileSync('workers.log', '');
    fs.writeFileSync('system.log', '');
    fs.writeFileSync('mining.log', '');
  } catch (e) {
    originalError('שגיאה בניקוי קבצי הלוג:', e.message);
  }

  function getLocalTimestamp() {
    const d = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function isStartupMessage(msg) {
    return msg.includes('📊 נתונים קודמים נטענו מ-stats.json') ||
           (msg.includes('💻 נמצאו') && msg.includes('ליבות') && msg.includes('מערכת Multi-threading מאותחלת')) ||
           (msg.includes('📈 מעלה עוצמת מחשוב') && msg.includes('סה"כ פעיל בחווה: 1/')) ||
           msg.includes('🌐 לוח בקרה אינטרנטי זמין בכתובת') ||
           msg.includes('🔑 טוקן אבטחה') ||
           msg.includes('נוצר טוקן אבטחה חדש') ||
           msg.includes('✅ מחובר ל-') ||
           msg.includes('📡 נרשם בהצלחה | extranonce1=') ||
           msg.includes('🔐 החיבור לבריכה אושר בהצלחה');
  }

  function classifyLogMessage(msg) {
    if (isStartupMessage(msg)) {
      return ['workers', 'system', 'mining'];
    }

    // File 1: Workers (וורקרים וקצב כרייה)
    const isWorker =
      msg.includes('[Worker') ||
      msg.includes('Worker Thread') ||
      msg.includes('Remote worker') ||
      msg.includes('ליבת כרייה מקומית') ||
      msg.includes('ליבת כרייה קרסה') ||
      msg.includes('ליבת כרייה נסגרה') ||
      msg.includes('קצב כרייה') ||
      msg.includes('קצב גיבוב') ||
      msg.includes('גיבוב כולל');

    // File 2: Quality control (בקרת איכות - טמפרטורה, עומס, ליבות, השהיה/הפעלה יזומה)
    const isSystem =
      msg.includes('עוצמת מחשוב') ||
      msg.includes('ויסות חום') ||
      msg.includes('הרצה הדרגתית') ||
      msg.includes('בקרת חום') ||
      msg.includes('Thermal limit') ||
      msg.includes('Thermal safety') ||
      msg.includes('טמפרטורת המעבד') ||
      msg.includes('עומס המערכת') ||
      msg.includes('הושהתה באופן יזום') ||
      msg.includes('חודשה. ליבות') ||
      msg.includes('מגבלת הליבות');

    // File 3: Mining success & pool communication (הצלחות כרייה, שליחה לבריכה, stratum)
    const isMining =
      msg.includes('Share') ||
      msg.includes('מנייה') ||
      msg.includes('מניות') ||
      msg.includes('תגובה מקבלת Share') ||
      msg.includes('קושי חדש') ||
      msg.includes('שיא כרייה חדש') ||
      msg.includes('קושי שיא חדש') ||
      msg.includes('שולח ל-Pool') ||
      msg.includes('החיבור נסגר') ||
      msg.includes('מנסה להתחבר מחדש') ||
      msg.includes('שוחזרו') ||
      msg.includes('שיתופים') ||
      msg.includes('Socket') ||
      msg.includes('התקבל בשרת בהצלחה');

    const categories = [];
    if (isWorker) categories.push('workers');
    if (isSystem) categories.push('system');
    if (isMining) categories.push('mining');

    // Default to workers if no category is matched
    if (categories.length === 0) {
      categories.push('workers');
    }
    return categories;
  }

  let hasWrittenStartupPrefix = false;

  function appendToSplitLogs(msg, timestamp, isError = false) {
    try {
      const categories = classifyLogMessage(msg);
      const isStartup = isStartupMessage(msg);
      
      let prefix = '';
      if (isStartup && !hasWrittenStartupPrefix) {
        prefix = '----';
        hasWrittenStartupPrefix = true;
      }
      
      const emojiPrefix = isError ? '❌ ' : '';
      const logLine = `${prefix}[${timestamp}] ${emojiPrefix}${msg}`;

      categories.forEach(cat => {
        fs.appendFileSync(`${cat}.log`, logLine + '\n');
      });

      // If authorized, write the custom appropriate message
      if (msg.includes('🔐 החיבור לבריכה אושר בהצלחה') || msg.includes('Authorized')) {
        try {
          fs.appendFileSync('workers.log', ' ++++ מעקב וורקרים: פירוט ביצועי ליבות וחיבורי סמארטפונים\n');
          fs.appendFileSync('system.log', ' ++++ בקרת איכות: ניהול משאבים, טמפרטורה וויסות ליבות\n');
          fs.appendFileSync('mining.log', ' ++++ הצלחות כרייה: מציאת שיתופים (Shares) וחיבור לבריכה (Stratum)\n');
        } catch (innerErr) {
          originalError('שגיאה בכתיבת הודעות התאמה לעמודים:', innerErr.message);
        }
      }
    } catch (e) {
      originalError('שגיאה בכתיבה לקבצי הלוג המפוצלים:', e.message);
    }
  }

  console.log = (...args) => {
    const msg = args.join(' ');
    const timestamp = getLocalTimestamp();
    const isDemoLog = msg.includes('🎬') || msg.includes('Demo') || msg.includes('demo') || (typeof demoModeActive !== 'undefined' && demoModeActive);
    
    if (isDemoLog) {
      demoLogs.push(`[${timestamp.split(' ')[1]}] ${msg}`);
      if (demoLogs.length > 50) demoLogs.shift();
      originalLog.apply(console, args);
    } else {
      logs.push(`[${timestamp.split(' ')[1]}] ${msg}`);
      if (logs.length > 50) logs.shift();
      originalLog.apply(console, args);
      appendToSplitLogs(msg, timestamp, false);
    }
  };

  console.error = (...args) => {
    const msg = args.join(' ');
    const timestamp = getLocalTimestamp();
    const isDemoLog = msg.includes('🎬') || msg.includes('Demo') || msg.includes('demo') || (typeof demoModeActive !== 'undefined' && demoModeActive);
    
    if (isDemoLog) {
      demoLogs.push(`[${timestamp.split(' ')[1]}] ❌ ${msg}`);
      if (demoLogs.length > 50) demoLogs.shift();
      originalError.apply(console, args);
    } else {
      logs.push(`[${timestamp.split(' ')[1]}] ❌ ${msg}`);
      if (logs.length > 50) logs.shift();
      originalError.apply(console, args);
      appendToSplitLogs(msg, timestamp, true);
    }
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

  // יצירת טוקן אבטחה אם אינו קיים
  let token = process.env.DASHBOARD_TOKEN;
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    process.env.DASHBOARD_TOKEN = token;
    try {
      let envContent = '';
      if (fs.existsSync('.env')) {
        envContent = fs.readFileSync('.env', 'utf8');
      }
      if (!envContent.includes('DASHBOARD_TOKEN=')) {
        const newline = envContent.endsWith('\n') || envContent.endsWith('\r') ? '' : '\n';
        fs.appendFileSync('.env', `${newline}DASHBOARD_TOKEN=${token}\n`, 'utf8');
        console.log(`🔑 נוצר טוקן אבטחה חדש ונשמר ב-.env: ${token}`);
      }
    } catch (err) {
      console.error('שגיאה בכתיבת DASHBOARD_TOKEN ל-.env:', err.message);
    }
  }

  const POOL_HOST = process.env.POOL_HOST || 'public-pool.io';
  const POOL_PORT = parseInt(process.env.POOL_PORT || '3333', 10);
  const BTC_ADDRESS = process.env.BTC_ADDRESS || 'bc1qXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const WORKER_NAME = process.env.WORKER_NAME || 'nodejs-worker';
  const HTTP_PORT = process.env.HTTP_PORT || 3224;
  const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
  const ACK_TIMEOUT_MS = 15000; // 15 seconds acknowledgment timeout
  const COOL_DOWN_TEMP = parseFloat(process.env.COOL_DOWN_TEMP || '85');
  const RESUME_RAMP_TEMP = parseFloat(process.env.RESUME_RAMP_TEMP || '80');

  let extranonce1 = null;
  let extranonce2Size = 4;
  let currentJob = null;
  let jobVersion = 0;
  let difficulty = 100000;
  let msgId = 1;
  const shareQueue = [];
  let sharesFound = 0;
  let sharesAccepted = 0;
  let demoSharesFound = 0;
  let demoSharesAccepted = 0;
  let totalHashesGlobal = 0;
  let bestDifficulty = 0;
  let bestDifficultyHash = '';

  // פונקציה לשמירת סטטיסטיקה לקובץ (כתיבה אטומית למניעת שגיאות/חלקים חסרים)
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
      const tempPath = 'stats.json.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(stats, null, 2));
      fs.renameSync(tempPath, 'stats.json');
      originalLog('💾 הסטטיסטיקה נשמרה בהצלחה ל-stats.json');
    } catch (err) {
      originalError('שגיאה בשמירת סטטיסטיקה:', err.message);
    }
  }

  // שמירת שיתופים תלויים ושאינם מאושרים לדיסק להגנה מפני קריסת המערכת
  function savePendingSharesSync() {
    const list = [...shareQueue];
    for (const [id, submission] of pendingSubmissions.entries()) {
      list.push({ method: submission.method, params: submission.params });
    }
    
    try {
      const tempPath = 'pending-shares.json.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(list, null, 2));
      fs.renameSync(tempPath, 'pending-shares.json');
    } catch (err) {
      originalError('שגיאה בשמירת שיתופים תלויים לדיסק:', err.message);
    }
  }

  // טעינת סטטיסטיקות קודמות מקובץ stats.json על מנת שהנתונים יישמרו בין הפעלות
  try {
    if (fs.existsSync('stats.json')) {
      const data = JSON.parse(fs.readFileSync('stats.json', 'utf8'));
      sharesFound = data.shares_found || 0;
      sharesAccepted = data.shares_accepted || 0;
      totalHashesGlobal = data.total_hashes || 0;
      bestDifficulty = data.best_difficulty || 0;
      bestDifficultyHash = data.best_difficulty_hash || '';
      console.log(`📊 נתונים קודמים נטענו מ-stats.json: נמצאו ${sharesFound}, התקבלו ${sharesAccepted}, קושי שיא: ${bestDifficulty}`);
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
  const pendingSubmissions = new Map();

  let activeCoresTarget = 1;

  function getCombinedCoresText(localActive) {
    let remoteActive = 0;
    let remoteConfigured = 0;
    for (const worker of remoteWorkers.values()) {
      const isDemoWorker = worker.name.includes('-demo');
      if (isDemoWorker === (typeof demoModeActive !== 'undefined' ? demoModeActive : false)) {
        const isOnline = (Date.now() - worker.last_seen) < 15000;
        if (isOnline && worker.is_mining) {
          remoteActive += worker.threads || 0;
          remoteConfigured += worker.max_cores || 8;
        }
      }
    }
    const combinedActive = localActive + remoteActive;
    const combinedConfigured = (typeof configuredCores !== 'undefined' ? configuredCores : 12) + remoteConfigured;
    return `סה"כ פעיל בחווה: ${combinedActive}/${combinedConfigured}, מקומי: ${localActive}/${typeof configuredCores !== 'undefined' ? configuredCores : 12}`;
  }

  // פונקציה לניהול דינמי של כמות הוורקרים הפעילים בהתאם לעומס וטמפרטורה
  function adjustWorkers(targetCores) {
    activeCoresTarget = targetCores;
    if (workers.length === targetCores) return;

    if (workers.length < targetCores) {
      const toAdd = targetCores - workers.length;
      console.log(`📈 מעלה עוצמת מחשוב: מוסיף ${toAdd} ליבות כרייה (${getCombinedCoresText(targetCores)})`);
      for (let i = 0; i < toAdd; i++) {
        const worker = new Worker(fileURLToPath(import.meta.url));
        worker.hashrateKHs = 0;
        worker.intentionalStop = false;

        worker.on('message', (msg) => {
          if (msg.type === 'share') {
            if (typeof demoModeActive !== 'undefined' && demoModeActive) {
              console.log(`🎬 [Demo PC Worker] found a simulated share!`);
              demoSharesFound++;
              demoSharesAccepted++;
            } else {
              sharesFound++;
              saveStatsSync(); // שמירה מיידית של מציאת ה-Share
              console.log(`🎉 [Worker] Share נמצא! שולח ל-Pool...`);
              
              // התראת שולחן עבודה על מציאת Share
              exec(`notify-send -u normal "⛏️ נמצאה מנייה!" "שולח מניית כרייה לבריכת הכרייה..."`);

              send('mining.submit', [
                `${BTC_ADDRESS}.${WORKER_NAME}`,
                msg.jobId,
                msg.extranonce2,
                msg.ntime,
                msg.nonce
              ]);
            }
          } else if (msg.type === 'hashrate') {
            worker.hashrateKHs = msg.hashrateKHs;
            totalHashesGlobal += msg.newHashes;
          } else if (msg.type === 'best_difficulty') {
            if (msg.difficulty > bestDifficulty) {
              bestDifficulty = msg.difficulty;
              bestDifficultyHash = msg.hash;
              console.log(`🚀 קושי שיא חדש שנמצא על ידי המעבד: ${bestDifficulty.toFixed(4)} (האש: ${bestDifficultyHash})`);
              
              // התראת שולחן עבודה על שיא קושי חדש (רק אם הקושי משמעותי)
              if (bestDifficulty > 1.0) {
                exec(`notify-send -u normal "🏆 שיא כרייה חדש!" "נמצא האש בקושי שובר שיא של ${bestDifficulty.toFixed(4)}!"`);
              }

              workers.forEach(w => w.postMessage({ type: 'best_difficulty', globalBestDifficulty: bestDifficulty }));
            }
          } else if (msg.type === 'extranonce2') {
            console.log(`💻 [PC Worker Thread] Started mining new job with extranonce2: ${msg.extranonce2}`);
          }
        });

        worker.on('error', (err) => {
          console.error(`❌ שגיאה בליבת כרייה מקומית: ${err.message}`);
        });

        worker.on('exit', (code) => {
          const idx = workers.indexOf(worker);
          if (idx !== -1) {
            workers.splice(idx, 1);
          }
          if (code !== 0 && !worker.intentionalStop) {
            console.warn(`⚠️ ליבת כרייה קרסה באופן לא צפוי עם קוד יציאה ${code}. מפעיל ליבה חלופית בעוד שנייה...`);
            setTimeout(() => {
              adjustWorkers(activeCoresTarget);
            }, 1000);
          } else {
            console.log(`ℹ️ ליבת כרייה נסגרה בצורה תקינה.`);
          }
        });
        
        // שליחת העבודה והקושי הנוכחיים לוורקר החדש אם קיימים
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
      console.log(`📉 מנמיך עוצמת מחשוב: מסיים ${toRemove} ליבות כרייה (${getCombinedCoresText(targetCores)})`);
      for (let i = 0; i < toRemove; i++) {
        const worker = workers.pop();
        if (worker) {
          worker.intentionalStop = true;
          worker.terminate();
        }
      }
    }
  }

  // אתחול כמות הוורקרים הראשונית - מתחיל מליבה אחת בלבד ועולה בהדרגה
  adjustWorkers(1);

  // הדפסת קצב גיבוב כולל למסך כל שתי שניות (בטרמינל)
  setInterval(() => {
    let combinedKHs = workers.reduce((sum, w) => sum + (w.hashrateKHs || 0), 0);
    let combinedActiveCores = workers.length;

    for (const worker of remoteWorkers.values()) {
      const isDemoWorker = worker.name.includes('-demo');
      if (isDemoWorker === demoModeActive) {
        const isOnline = (Date.now() - worker.last_seen) < 15000;
        if (isOnline && worker.is_mining) {
          combinedKHs += worker.hashrate || 0;
          combinedActiveCores += worker.threads || 0;
        }
      }
    }

    process.stdout.write(`\r⛏️  קצב כרייה כולל (${combinedActiveCores} ליבות): ${combinedKHs.toFixed(1)} KH/s `);
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
  let currentRampLimit = 1;
  let isFirstHealthCheck = true;
  let wasHoldingSteady = false;
  let coolingMode = false;

  function checkSystemHealth() {
    const temp = getCPUTemperature();
    const load = os.loadavg()[0];
    const totalCores = os.cpus().length;
    
    systemHealth.temp = temp;
    systemHealth.load = parseFloat(load.toFixed(1));
    systemHealth.configuredCores = configuredCores;
    
    if (miningPaused) {
      systemHealth.status = 'paused';
      systemHealth.recommendation = 'הכרייה מושהית זמנית על ידי המשתמש (מצב קירור).';
      systemHealth.activeCores = 0;
      adjustWorkers(0);
      return;
    }
    
    let status = 'ok';
    let recommendation = null;
    let targetCores = configuredCores;
    
    // בדיקת מצב קריטי (חירום)
    if (temp && temp >= 90) {
      status = 'critical';
      currentRampLimit = 1;
      targetCores = 1;
      recommendation = `טמפרטורת המעבד קריטית (${temp.toFixed(1)}°C). עוצמת המחשוב הונמכה אוטומטית לליבה אחת כדי למנוע נזק.`;
      
      // אזהרת החום נמדדת ומתועדת בלוג בלבד ללא התראות קופצות שמציקות למשתמש
      hasAlertedTemp = true;
      wasHoldingSteady = false;
      coolingMode = true; // Ensure cooling mode is active
    } else {
      // בדיקת אזהרה (חום או עומס)
      let needsCooling = false;
      if (temp && temp >= COOL_DOWN_TEMP) {
        status = 'warning';
        needsCooling = true;
        coolingMode = true; // Trigger cooling mode
        recommendation = `טמפרטורת המעבד חמה (${temp.toFixed(1)}°C).`;
      }
      if (load > totalCores * 1.3) {
        status = 'warning';
        needsCooling = true;
        recommendation = (recommendation ? recommendation + ' ' : '') + `עומס המערכת גבוה (${load.toFixed(1)}).`;
      }
      
      if (needsCooling) {
        wasHoldingSteady = false;
        // הנמכה הדרגתית של ליבה אחת
        if (currentRampLimit > 1) {
          currentRampLimit--;
          console.log(`📉 ויסות חום/עומס (Cooldown): מנמיך את מגבלת הליבות ל-${currentRampLimit}/${configuredCores} (${getCombinedCoresText(currentRampLimit)}) (חום: ${temp ? temp.toFixed(1) + '°C' : 'N/A'}, עומס: ${load.toFixed(1)})`);
        }
        targetCores = currentRampLimit;
        recommendation += ` עוצמת המחשוב הונמכה בהדרגה ל-${targetCores} ליבות.`;
        hasAlertedTemp = false;
      } else {
        // אין צורך אקטיבי בקירור (טמפרטורה מתחת ל-COOL_DOWN_TEMP ועומס תקין)
        // אם הטמפרטורה ירדה מתחת ל-RESUME_RAMP_TEMP, יוצאים ממצב קירור
        if (temp && temp <= RESUME_RAMP_TEMP) {
          coolingMode = false;
        }
        
        // מותר להעלות ליבה רק אם אנחנו לא במצב קירור (coolingMode === false)
        if (!coolingMode) {
          wasHoldingSteady = false;
          status = 'ok';
          hasAlertedTemp = false;
          if (currentRampLimit < configuredCores) {
            if (isFirstHealthCheck) {
              isFirstHealthCheck = false;
            } else {
              currentRampLimit++;
              console.log(`🐌 הרצה הדרגתית (Ramp-up): מעלה מגבלת ליבות ל-${currentRampLimit}/${configuredCores} (${getCombinedCoresText(currentRampLimit)}) (חום: ${temp ? temp.toFixed(1) + '°C' : 'N/A'}, עומס: ${load.toFixed(1)})`);
            }
          }
          targetCores = currentRampLimit;
        } else {
          // אנחנו במצב קירור, והטמפרטורה היא מעל RESUME_RAMP_TEMP אך מתחת ל-COOL_DOWN_TEMP (אזור ההיסטרזיס)
          status = 'ok';
          hasAlertedTemp = false;
          if (!wasHoldingSteady) {
            wasHoldingSteady = true;
            console.log(`ℹ️ מערכת בקרת חום במצב יציב (Holding steady): טמפרטורה ${temp.toFixed(1)}°C היא בטווח ההיסטרזיס (${RESUME_RAMP_TEMP}°C - ${COOL_DOWN_TEMP}°C). שומר על ${currentRampLimit}/${configuredCores} ליבות (${getCombinedCoresText(currentRampLimit)}).`);
          }
          targetCores = currentRampLimit;
          recommendation = `טמפרטורת המעבד מתייצבת (${temp.toFixed(1)}°C). שומר על ${targetCores} ליבות.`;
        }
      }
    }
    
    adjustWorkers(targetCores);
    
    systemHealth.status = status;
    systemHealth.recommendation = recommendation;
    systemHealth.activeCores = workers.length;
  }
  
  // Start periodic check
  setInterval(checkSystemHealth, 5000);
  checkSystemHealth(); // initial check

  // ===== ניהול עובדים מבוזרים (טלפונים) ומצב דמו =====

  // Cleanup offline remote workers (no heartbeat in 15 seconds)
  setInterval(() => {
    const now = Date.now();
    for (const [name, worker] of remoteWorkers.entries()) {
      if (now - worker.last_seen > 15000) {
        console.log(`🔌 Remote worker [${name}] went offline (timeout).`);
        remoteWorkers.delete(name);
      }
    }
  }, 5000);

  // ===== שרת Web (לוח בקרה אינטרנטי) =====
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      const authToken = req.headers['x-auth-token'];
      if (!authToken || authToken !== process.env.DASHBOARD_TOKEN) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing token' }));
        return;
      }

      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          let payload = {};
          if (body.trim()) {
            payload = JSON.parse(body);
          }
          
          if (req.url === '/api/worker/heartbeat') {
            const now = Date.now();
            const name = payload.name || 'unknown-worker';
            
            // Get or create worker status
            let worker = remoteWorkers.get(name);
            if (!worker) {
              worker = {
                name,
                temp: payload.temp,
                hashrate: payload.hashrate,
                threads: payload.threads || 4,
                max_cores: payload.max_cores || 8,
                shares_accepted: payload.shares_accepted || 0,
                shares_rejected: payload.shares_rejected || 0,
                uptime: payload.uptime || 0,
                is_mining: payload.is_mining || false,
                last_seen: now,
                last_adjust: 0
              };
              remoteWorkers.set(name, worker);
            } else {
              // Update stats
              worker.temp = payload.temp;
              worker.hashrate = payload.hashrate;
              worker.max_cores = payload.max_cores || 8;
              worker.shares_accepted = payload.shares_accepted || 0;
              worker.shares_rejected = payload.shares_rejected || 0;
              worker.uptime = payload.uptime || 0;
              worker.is_mining = payload.is_mining || false;
              worker.last_seen = now;
            }

            if (payload.logs && Array.isArray(payload.logs)) {
              payload.logs.forEach(msg => {
                console.log(`📱 [Worker ${name}] ${msg}`);
              });
            }

            // Dynamic thermal-aware thread scaling
            let targetThreads = worker.threads;
            const maxAllowedThreads = Math.max(1, Math.min(7, worker.max_cores - 1));
            
            // Enforce safety ceiling immediately if current target is too high
            if (targetThreads > maxAllowedThreads) {
              targetThreads = maxAllowedThreads;
            }

            if (phonesMiningEnabled) {
              if (worker.temp >= 65) {
                if (now - worker.last_adjust > 15000) { // 15s cooldown
                  if (targetThreads > 1) {
                    targetThreads--;
                    worker.last_adjust = now;
                    console.log(`⚠️ [Worker ${name}] Thermal limit exceeded (${worker.temp.toFixed(1)}°C). Scaling threads down to ${targetThreads}/${worker.max_cores}`);
                  }
                }
              } else if (worker.temp <= 55) {
                if (now - worker.last_adjust > 15000) {
                  if (targetThreads < maxAllowedThreads) {
                    targetThreads++;
                    worker.last_adjust = now;
                    console.log(`📈 [Worker ${name}] Thermal safety cleared (${worker.temp.toFixed(1)}°C). Scaling threads up to ${targetThreads}/${worker.max_cores}`);
                  }
                }
              }
            }
            worker.threads = targetThreads;

            const clientJobId = payload.job_id || null;
            const isJobChanged = currentJob ? (currentJob.jobId !== clientJobId) : false;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              status: 'ok',
              target_threads: miningPaused ? 0 : targetThreads,
              is_mining_target: phonesMiningEnabled && !miningPaused,
              job: currentJob,
              difficulty: difficulty,
              extranonce1: extranonce1,
              extranonce2Size: extranonce2Size,
              job_changed: isJobChanged
            }));
            return;
          }

          if (req.url === '/api/worker/submit') {
            const name = payload.worker_name || 'unknown-worker';
            const isDemoShare = name.includes('-demo') || demoModeActive;
            
            if (isDemoShare) {
              console.log(`🎬 [Demo Worker ${name}] submitted a simulated share!`);
              demoSharesFound++;
              demoSharesAccepted++;
            } else {
              console.log(`🎉 Remote worker [${name}] submitted a share! Submitting to pool...`);
              
              // Submit to the Stratum pool using main connection
              send('mining.submit', [
                `${BTC_ADDRESS}.${name}`,
                payload.job_id,
                payload.extranonce2,
                payload.ntime,
                payload.nonce
              ]);

              sharesFound++;
              saveStatsSync();
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
          }

          if (req.url === '/api/workers/toggle') {
            phonesMiningEnabled = !phonesMiningEnabled;
            console.log(`⚡ Toggled phone mining status to: ${phonesMiningEnabled ? 'ON' : 'OFF'}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', phones_mining_enabled: phonesMiningEnabled }));
            return;
          }

          if (req.url === '/api/demo/toggle') {
            demoModeActive = !demoModeActive;
            if (!demoModeActive) {
              // Cleanup demo workers from the remoteWorkers map
              for (const key of remoteWorkers.keys()) {
                if (key.includes('-demo')) {
                  remoteWorkers.delete(key);
                }
              }
              // Reset demo stats when leaving demo mode
              demoSharesFound = 0;
              demoSharesAccepted = 0;
              demoLogs.length = 0;
            } else {
              // Initialize demo stats from current real stats
              demoSharesFound = sharesFound;
              demoSharesAccepted = sharesAccepted;
            }
            console.log(`⚡ Toggled server demo mode status to: ${demoModeActive ? 'ON' : 'OFF'}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', demo_active: demoModeActive }));
            return;
          }

          if (req.url === '/api/mining/toggle') {
            miningPaused = !miningPaused;
            if (miningPaused) {
              console.log('⏸️ כריית הביטקוין הושהתה באופן יזום. הליבות נסגרות...');
              adjustWorkers(0);
            } else {
              console.log('▶️ כריית הביטקוין חודשה. ליבות הכרייה מופעלות מחדש...');
              coolingMode = false;
              currentRampLimit = 1; // איפוס לליבה אחת כדי להבטיח עלייה הדרגתית (Ramp-up)
              checkSystemHealth();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', mining_paused: miningPaused }));
            return;
          }

          if (req.url === '/api/stats/reset') {
            sharesFound = 0;
            sharesAccepted = 0;
            totalHashesGlobal = 0;
            bestDifficulty = 0;
            bestDifficultyHash = '';
            
            // איפוס נתוני דמו אם קיימים
            demoSharesFound = 0;
            demoSharesAccepted = 0;
            demoLogs.length = 0;
            
            saveStatsSync();
            console.log('🔄 נתוני הכרייה והסטטיסטיקות אופסו בהצלחה מלוח הבקרה.');
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
          }

          res.writeHead(400);
          res.end('Bad Request');
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (req.url === '/stats') {
      const uptimeSec = Math.floor((Date.now() - appStartTime) / 1000);
      let totalKHs = workers.reduce((sum, w) => sum + (w.hashrateKHs || 0), 0);
      let localSharesFound = demoModeActive ? demoSharesFound : sharesFound;
      let localSharesAccepted = demoModeActive ? demoSharesAccepted : sharesAccepted;
      let localActiveCores = systemHealth.activeCores;

      if (demoModeActive) {
        // Simulating PC mining stats in demo mode
        totalKHs = 145.8 + Math.sin(Date.now() / 10000) * 15; // Simulated 130-160 KH/s
        if (Math.random() < 0.05) {
          demoSharesFound++;
          demoSharesAccepted++;
        }
        localSharesFound = demoSharesFound;
        localSharesAccepted = demoSharesAccepted;
        localActiveCores = configuredCores;

        // Add simulated phone workers if none are present
        const now = Date.now();
        if (!remoteWorkers.has('redmi-demo-1')) {
          remoteWorkers.set('redmi-demo-1', {
            name: 'redmi-demo-1',
            temp: 58.2,
            hashrate: 12.4,
            threads: 4,
            max_cores: 8,
            shares_accepted: 3,
            shares_rejected: 0,
            uptime: 120,
            is_mining: true,
            last_seen: now
          });
        }
        if (!remoteWorkers.has('redmi-demo-2')) {
          remoteWorkers.set('redmi-demo-2', {
            name: 'redmi-demo-2',
            temp: 64.5,
            hashrate: 18.1,
            threads: 6,
            max_cores: 8,
            shares_accepted: 5,
            shares_rejected: 0,
            uptime: 180,
            is_mining: true,
            last_seen: now
          });
        }

        // Simulate thermodynamics and thread adjustments for demo workers
        for (const [key, worker] of remoteWorkers.entries()) {
          if (key.includes('-demo')) {
            worker.last_seen = now;
            worker.uptime += 2;
            if (phonesMiningEnabled) {
              worker.is_mining = true;
              if (worker.temp >= 65) {
                if (!worker.last_adjust || now - worker.last_adjust > 15000) {
                  if (worker.threads > 1) {
                    worker.threads--;
                    worker.last_adjust = now;
                    console.log(`🎬 [Demo Worker ${worker.name}] Thermals too hot (${worker.temp.toFixed(1)}°C). Scaling threads down to ${worker.threads}/${worker.max_cores}`);
                  }
                }
              } else if (worker.temp <= 55) {
                if (!worker.last_adjust || now - worker.last_adjust > 15000) {
                  if (worker.threads < worker.max_cores) {
                    worker.threads++;
                    worker.last_adjust = now;
                    console.log(`🎬 [Demo Worker ${worker.name}] Thermals cooled down (${worker.temp.toFixed(1)}°C). Scaling threads up to ${worker.threads}/${worker.max_cores}`);
                  }
                }
              }
              const heatFactor = (worker.threads / worker.max_cores) * 2.0;
              worker.temp += (heatFactor - 1.2) * 1.5 + (Math.random() - 0.5);
              worker.temp = Math.max(35.0, Math.min(80.0, worker.temp));
              worker.hashrate = worker.threads * 4.2 + (Math.random() - 0.5);
              if (Math.random() < 0.02) {
                worker.shares_accepted++;
                demoSharesFound++;
                demoSharesAccepted++;
              }
            } else {
              worker.is_mining = false;
              worker.hashrate = 0.0;
              worker.temp = Math.max(35.0, worker.temp - 1.5);
            }
          }
        }
      }

      let totalActiveCoresCombined = localActiveCores;
      let totalConfiguredCoresCombined = systemHealth.configuredCores;

      for (const worker of remoteWorkers.values()) {
        const isDemoWorker = worker.name.includes('-demo');
        if (isDemoWorker === demoModeActive) {
          const isOnline = (Date.now() - worker.last_seen) < 15000;
          if (isOnline && worker.is_mining) {
            totalActiveCoresCombined += worker.threads || 0;
            totalConfiguredCoresCombined += worker.max_cores || 8;
          }
        }
      }

      const stats = {
        uptime_seconds: uptimeSec,
        shares_found: localSharesFound,
        shares_accepted: localSharesAccepted,
        hashrate_khs: parseFloat(totalKHs.toFixed(1)),
        total_hashes: totalHashesGlobal,
        difficulty: difficulty,
        logs: demoModeActive ? logs.concat(demoLogs) : logs,
        health: {
          ...systemHealth,
          activeCores: totalActiveCoresCombined,
          configuredCores: totalConfiguredCoresCombined
        },
        best_difficulty: bestDifficulty,
        best_difficulty_hash: bestDifficultyHash,
        wallet_address: BTC_ADDRESS,
        phones_mining_enabled: phonesMiningEnabled,
        demo_mode_active: demoModeActive,
        mining_paused: miningPaused,
        remote_workers: Array.from(remoteWorkers.values()),
        pending_shares_count: shareQueue.length + pendingSubmissions.size
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
      return;
    }

    if (req.url === '/phone-worker.py') {
      try {
        if (fs.existsSync('phone-worker.py')) {
          const content = fs.readFileSync('phone-worker.py', 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(content);
        } else {
          res.writeHead(404);
          res.end('File not found');
        }
      } catch (err) {
        res.writeHead(500);
        res.end(err.message);
      }
      return;
    }

    if (req.url === '/stop') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Miner stopping...' }));
      console.log('🛑 התקבלה פקודת עצירה מרחוק מלוח הבקרה. מכבה את המיינר...');
      setTimeout(() => {
        handleExit();
      }, 500);
      return;
    }

    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <script>
    const DASHBOARD_TOKEN = "${process.env.DASHBOARD_TOKEN || ''}";
  </script>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>לוח בקרה מבוזר - כריית ביטקוין סולו</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Rubik:wght@300;400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-dark: #070a13;
      --card-bg: rgba(17, 24, 39, 0.7);
      --card-border: rgba(255, 255, 255, 0.06);
      --primary: #f59e0b;
      --primary-glow: rgba(245, 158, 11, 0.35);
      --accent: #38bdf8;
      --success: #10b981;
      --error: #ef4444;
      --warning: #f59e0b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: 'Rubik', 'Outfit', sans-serif;
      background: radial-gradient(circle at top, #111827 0%, #030712 100%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      padding: 1.5rem;
      overflow-x: hidden;
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
      width: 100%;
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }
    
    /* Demo Banner */
    .demo-banner {
      background: linear-gradient(90deg, #f59e0b 0%, #d97706 100%);
      color: #070a13;
      font-weight: 800;
      padding: 0.8rem;
      border-radius: 12px;
      text-align: center;
      box-shadow: 0 0 20px rgba(245, 158, 11, 0.4);
      display: none;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-size: 1.1rem;
      animation: pulseBanner 2s infinite;
    }
    
    @keyframes pulseBanner {
      0% { opacity: 0.95; }
      50% { opacity: 1; }
      100% { opacity: 0.95; }
    }
    
    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 1rem;
    }
    
    .logo-container {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .logo-icon {
      font-size: 2.2rem;
      filter: drop-shadow(0 0 8px var(--primary-glow));
    }
    
    h1 {
      font-size: 1.6rem;
      font-weight: 700;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: var(--success);
      padding: 0.4rem 0.8rem;
      border-radius: 20px;
      font-size: 0.85rem;
      font-weight: 500;
    }
    
    .status-badge.demo {
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.3);
      color: var(--primary);
    }
    
    .status-dot {
      width: 8px;
      height: 8px;
      background-color: currentColor;
      border-radius: 50%;
      box-shadow: 0 0 8px currentColor;
    }
    
    /* Grid Layout */
    .dashboard-grid {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 1.5rem;
    }
    
    @media (max-width: 1024px) {
      .dashboard-grid {
        grid-template-columns: 1fr;
      }
    }
    
    .main-panel {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }
    
    .side-panel {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }
    
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(20px);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 1.5rem;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    
    .card:hover {
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    }
    
    .card-title {
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 1.2rem;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1rem;
    }
    
    .stat-box {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 12px;
      padding: 1.2rem;
      text-align: right;
    }
    
    .stat-label {
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-bottom: 0.4rem;
    }
    
    .stat-value {
      font-size: 1.6rem;
      font-weight: 700;
      color: var(--text);
    }
    
    .stat-value.primary { color: var(--primary); text-shadow: 0 0 10px var(--primary-glow); }
    .stat-value.success { color: var(--success); }
    .stat-value.accent { color: var(--accent); }
    .stat-value.warning { color: var(--warning); }
    
    /* Health Panel */
    .health-container {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    
    .health-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.6rem 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }
    
    .health-row:last-child { border-bottom: none; }
    
    .health-val {
      font-weight: 600;
    }
    
    /* Alert Banner */
    .alert-banner {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
      padding: 1rem;
      border-radius: 12px;
      display: none;
      gap: 10px;
      align-items: center;
      margin-bottom: 1rem;
    }
    
    /* Phone Workers Section */
    .workers-section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }
    
    .workers-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
    }
    
    .worker-card {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 14px;
      padding: 1.2rem;
      position: relative;
      overflow: hidden;
      transition: all 0.2s ease;
    }
    
    .worker-card::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      height: 100%;
      width: 4px;
      background: var(--accent);
    }
    
    .worker-card.warning::before { background: var(--warning); }
    .worker-card.critical::before { background: var(--error); }
    .worker-card.offline::before { background: var(--text-muted); }
    
    .worker-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.8rem;
    }
    
    .worker-name {
      font-weight: 600;
      font-size: 1.1rem;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    
    .worker-badge {
      font-size: 0.75rem;
      padding: 0.2rem 0.5rem;
      border-radius: 10px;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.3);
      color: var(--accent);
    }
    
    .worker-stat-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 0.4rem;
      font-size: 0.9rem;
    }
    
    .worker-stat-label { color: var(--text-muted); }
    
    .worker-stat-val { font-weight: 500; }
    
    .temp-bar-container {
      background: rgba(255, 255, 255, 0.05);
      height: 6px;
      border-radius: 3px;
      margin-top: 0.8rem;
      overflow: hidden;
    }
    
    .temp-bar {
      height: 100%;
      width: 50%;
      background: var(--success);
      border-radius: 3px;
      transition: width 0.5s ease, background-color 0.5s ease;
    }
    
    .no-workers {
      grid-column: 1 / -1;
      text-align: center;
      color: var(--text-muted);
      padding: 2rem;
      border: 1px dashed rgba(255, 255, 255, 0.06);
      border-radius: 12px;
      font-size: 0.95rem;
    }
    
    /* Control Buttons */
    .controls-panel {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    
    .btn {
      padding: 0.8rem 1.2rem;
      font-family: inherit;
      font-size: 0.95rem;
      font-weight: 600;
      border-radius: 10px;
      cursor: pointer;
      border: none;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    
    .btn-primary {
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      color: #070a13;
      box-shadow: 0 4px 14px rgba(245, 158, 11, 0.3);
    }
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(245, 158, 11, 0.4);
    }
    
    .btn-secondary {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.15);
    }
    
    .btn-danger {
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      color: white;
      box-shadow: 0 4px 14px rgba(239, 68, 68, 0.3);
    }
    .btn-danger:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(239, 68, 68, 0.4);
    }
    
    /* Terminal Console */
    .terminal-card {
      background: #020617;
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 1.2rem;
      font-family: monospace;
      font-size: 0.85rem;
      color: #34d399;
      box-shadow: inset 0 2px 8px rgba(0,0,0,0.8);
      max-height: 200px;
      overflow-y: auto;
      white-space: pre-wrap;
      direction: ltr;
      text-align: left;
    }
  </style>
</head>
<body>
  <div class="container">
    <div id="demoBanner" class="demo-banner">
      <span>⚡ שרת הדמו של כריית ביטקוין (BTC) פעיל ומסמלץ פעילות כרייה מבוזרת ⚡</span>
    </div>
    
    <header>
      <div class="logo-container">
        <span class="logo-icon">⛏️</span>
        <div>
          <h1>שרת ניהול כריית ביטקוין סולו</h1>
          <span style="font-size: 0.8rem; color: var(--text-muted);">מערכת בקרה מבוזרת PC & Mobile</span>
        </div>
      </div>
      
      <div id="statusBadge" class="status-badge">
        <span class="status-dot"></span>
        <span id="statusText">מחובר לבריכת כרייה</span>
      </div>
    </header>
    
    <div id="alertBox" class="alert-banner">
      <span style="font-size: 1.5rem;">⚠️</span>
      <span id="alertDesc">התרעת טמפרטורה! המערכת הפחיתה ליבות פעילות במחשב.</span>
    </div>
    
    <div class="dashboard-grid">
      <!-- Main panel -->
      <div class="main-panel">
        <!-- Stats summary -->
        <div class="card">
          <div class="card-title">⚙️ נתוני כרייה בזמן אמת</div>
          <div class="stats-grid">
            <div class="stat-box">
              <div class="stat-label">זמן פעילות שרת</div>
              <div id="uptime" class="stat-value">0 שעות, 0 דק'</div>
            </div>
            <div id="combinedHashrateBox" class="stat-box" style="border: 1px solid rgba(245, 158, 11, 0.3); background: rgba(245, 158, 11, 0.03);">
              <div class="stat-label" style="color: var(--primary); font-weight: bold;">🔥 קצב גיבוב משולב</div>
              <div id="combinedHashrate" class="stat-value primary" style="font-size: 2.2rem; text-shadow: 0 0 10px rgba(245, 158, 11, 0.4);">0 KH/s</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">קצב גיבוב PC</div>
              <div id="pcHashrate" class="stat-value accent">0 KH/s</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">ליבות כרייה (PC)</div>
              <div id="activeCores" class="stat-value" style="direction: ltr;">0 / 0</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">פתרונות (Shares)</div>
              <div id="shares" class="stat-value success">0</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">שיתופים ממתינים לאישור</div>
              <div id="pendingShares" class="stat-value warning">0</div>
            </div>
          </div>
        </div>
        
        <!-- Distributed Workers -->
        <div class="card">
          <div class="workers-section-header">
            <div class="card-title" style="margin-bottom: 0;">📱 סמארטפונים מבוזרים (Redmi 13C)</div>
            <button id="togglePhoneMiningBtn" class="btn btn-secondary" style="padding: 0.4rem 0.8rem; font-size: 0.85rem;" onclick="togglePhoneMining()">
              טוען...
            </button>
          </div>
          <div id="workersGrid" class="workers-grid">
            <div class="no-workers">לא מחוברים סמארטפונים כרגע. הפעל את סקריפט ה-Daemon בטלפון כדי לחבר אותו.</div>
          </div>
        </div>
      </div>
      
      <!-- Side panel -->
      <div class="side-panel">
        <!-- Health status -->
        <div class="card">
          <div class="card-title">🌡️ בריאות המחשב המרכזי</div>
          <div class="health-container">
            <div class="health-row">
              <span class="worker-stat-label">טמפרטורת מעבד PC</span>
              <span id="pcTemp" class="health-val">טוען...</span>
            </div>
            <div class="health-row">
              <span class="worker-stat-label">עומס מעבד (Load)</span>
              <span id="pcLoad" class="health-val">טוען...</span>
            </div>
            <div class="health-row">
              <span class="worker-stat-label">כתובת ארנק לקבלת תשלום</span>
              <span id="walletAddress" class="health-val" style="font-size: 0.75rem; word-break: break-all; color: var(--accent);"></span>
            </div>
            <div class="health-row">
              <span class="worker-stat-label">קושי שיא שנמצא (CPU)</span>
              <span id="bestDiff" class="health-val" style="color: var(--primary);">0</span>
            </div>
          </div>
        </div>
        
        <!-- Controls -->
        <div class="card">
          <div class="card-title">🛠️ בקרת מערכת</div>
          <div class="controls-panel">
            <button id="toggleDemoBtn" class="btn btn-secondary" onclick="toggleDemoMode()">
              🔌 כניסה למצב דמו
            </button>
            <button id="togglePauseBtn" class="btn btn-secondary" onclick="togglePauseMining()">
              ⏸️ השהה כרייה
            </button>
            <button class="btn btn-secondary" onclick="resetStats()">
              🔄 איפוס סטטיסטיקות
            </button>
            <button class="btn btn-danger" onclick="stopMiner()">
              🛑 עצור כרייה (סגירת שרת)
            </button>
          </div>
        </div>
      </div>
    </div>
    
    <!-- Live logs -->
    <div class="card" style="flex-grow: 1;">
      <div class="card-title">📝 פלט הטרמינל (Live Logs)</div>
      <div id="terminal" class="terminal-card">טוען לוגים...</div>
    </div>
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
            document.body.innerHTML = '<div class="card" style="max-width: 650px; margin: 10% auto; text-align: center;"><h1>🛑 הכרייה כובתה בהצלחה</h1><p>ניתן לסגור דף זה. כל ליבות המעבד שוחררו לחלוטין.</p></div>';
          }
        } catch(e) {
          alert('שגיאה בעצירת המיינר: ' + e.message);
        }
      }
    }

    async function resetStats() {
      if (confirm('האם אתה בטוח שברצונך לאפס את כל הסטטיסטיקות והמונים של הכרייה? (פעולה זו תמחק גם את הנתונים שנשמרו ב-stats.json)')) {
        try {
          const res = await fetch('/api/stats/reset', {
            method: 'POST',
            headers: {
              'X-Auth-Token': DASHBOARD_TOKEN,
              'Content-Type': 'application/json'
            }
          });
          const data = await res.json();
          if (data.status === 'ok') {
            alert('הסטטיסטיקות אופסו בהצלחה!');
            fetchStats();
          } else {
            alert('שגיאה באיפוס הסטטיסטיקות.');
          }
        } catch(e) {
          alert('שגיאה בתקשורת עם השרת: ' + e.message);
        }
      }
    }
    
    async function togglePhoneMining() {
      try {
        const res = await fetch('/api/workers/toggle', {
          method: 'POST',
          headers: {
            'X-Auth-Token': DASHBOARD_TOKEN,
            'Content-Type': 'application/json'
          }
        });
        const data = await res.json();
        updatePhoneMiningBtn(data.phones_mining_enabled);
      } catch (e) {
        console.error(e);
      }
    }
    
    async function toggleDemoMode() {
      try {
        const res = await fetch('/api/demo/toggle', {
          method: 'POST',
          headers: {
            'X-Auth-Token': DASHBOARD_TOKEN,
            'Content-Type': 'application/json'
          }
        });
        const data = await res.json();
        updateDemoUI(data.demo_active);
      } catch (e) {
        console.error(e);
      }
    }

    async function togglePauseMining() {
      try {
        const res = await fetch('/api/mining/toggle', {
          method: 'POST',
          headers: {
            'X-Auth-Token': DASHBOARD_TOKEN,
            'Content-Type': 'application/json'
          }
        });
        const data = await res.json();
        updatePauseBtn(data.mining_paused);
      } catch (e) {
        console.error(e);
      }
    }

    function updatePauseBtn(paused) {
      const btn = document.getElementById('togglePauseBtn');
      if (paused) {
        btn.innerText = '▶️ המשך כרייה';
        btn.className = 'btn btn-primary';
        btn.style.color = '#070a13';
        btn.style.borderColor = 'transparent';
      } else {
        btn.innerText = '⏸️ השהה כרייה';
        btn.className = 'btn btn-secondary';
        btn.style.color = '';
        btn.style.borderColor = '';
      }
    }
    
    function updatePhoneMiningBtn(enabled) {
      const btn = document.getElementById('togglePhoneMiningBtn');
      if (enabled) {
        btn.innerText = '🛑 עצור כריית פלאפונים';
        btn.className = 'btn btn-secondary';
        btn.style.color = '#ef4444';
        btn.style.borderColor = 'rgba(239, 68, 68, 0.4)';
      } else {
        btn.innerText = '⚡ הפעל כריית פלאפונים';
        btn.className = 'btn btn-primary';
        btn.style.color = '#070a13';
        btn.style.borderColor = 'transparent';
      }
    }
    
    function updateDemoUI(active) {
      const banner = document.getElementById('demoBanner');
      const badge = document.getElementById('statusBadge');
      const text = document.getElementById('statusText');
      const btn = document.getElementById('toggleDemoBtn');
      
      if (active) {
        banner.style.display = 'flex';
        badge.className = 'status-badge demo';
        text.innerText = 'מחובר (מצב דמו)';
        btn.innerText = '🔌 כבה מצב דמו';
        btn.style.color = '#f59e0b';
        btn.style.borderColor = 'rgba(245, 158, 11, 0.4)';
      } else {
        banner.style.display = 'none';
        badge.className = 'status-badge';
        text.innerText = 'מחובר לבריכת כרייה';
        btn.innerText = '🔌 הפעל מצב דמו';
        btn.style.color = '';
        btn.style.borderColor = '';
      }
    }

    async function fetchStats() {
      try {
        const res = await fetch('/stats');
        const data = await res.json();
        
        // Update basic info
        document.getElementById('uptime').innerText = formatTime(data.uptime_seconds);
        document.getElementById('pcHashrate').innerText = data.hashrate_khs + ' KH/s';
        
        let combinedHashrate = data.hashrate_khs;
        if (data.remote_workers) {
          data.remote_workers.forEach(w => {
            const isDemoWorker = w.name.includes('-demo');
            if (isDemoWorker === data.demo_mode_active) {
              const isOnline = (Date.now() - w.last_seen) < 15000;
              if (isOnline && w.is_mining) {
                combinedHashrate += w.hashrate;
              }
            }
          });
        }
        
        const combinedHashrateEl = document.getElementById('combinedHashrate');
        if (data.demo_mode_active) {
          combinedHashrateEl.innerText = '[Demo] ' + combinedHashrate.toFixed(1) + ' KH/s';
          combinedHashrateEl.style.color = 'var(--warning)';
        } else {
          combinedHashrateEl.innerText = combinedHashrate.toFixed(1) + ' KH/s';
          combinedHashrateEl.style.color = '';
        }
        
        document.getElementById('shares').innerText = data.shares_found + ' (' + data.shares_accepted + ' Accepted)';
        document.getElementById('pendingShares').innerText = data.pending_shares_count || 0;
        
        // Update PC Cores
        const activeCoresEl = document.getElementById('activeCores');
        activeCoresEl.innerText = data.health.activeCores + ' / ' + data.health.configuredCores;
        
        // Update PC Health
        const pcTempEl = document.getElementById('pcTemp');
        if (data.health.temp !== null) {
          pcTempEl.innerText = data.health.temp.toFixed(1) + '°C';
          if (data.health.temp >= 85) pcTempEl.style.color = 'var(--error)';
          else if (data.health.temp >= 80) pcTempEl.style.color = 'var(--warning)';
          else pcTempEl.style.color = 'var(--success)';
        } else {
          pcTempEl.innerText = 'N/A';
          pcTempEl.style.color = '';
        }
        
        document.getElementById('pcLoad').innerText = data.health.load;
        
        // Update best share difficulty
        const bestDiffVal = data.best_difficulty || 0;
        let formattedDiff = bestDiffVal;
        if (bestDiffVal === 0) formattedDiff = '0';
        else if (bestDiffVal < 0.0001) formattedDiff = bestDiffVal.toExponential(4);
        else if (bestDiffVal < 1) formattedDiff = bestDiffVal.toFixed(6);
        else formattedDiff = bestDiffVal.toFixed(2);
        
        document.getElementById('bestDiff').innerText = formattedDiff;
        
        // Toggles
        updatePhoneMiningBtn(data.phones_mining_enabled);
        updateDemoUI(data.demo_mode_active);
        updatePauseBtn(data.mining_paused);
        
        // Update wallet address
        const wallet = data.wallet_address || 'bc1qwm58u3zaf63f0dx63qk5p867kps26ykf3uylcs';
        document.getElementById('walletAddress').innerText = wallet;
        
        // Alert banner
        const alertBox = document.getElementById('alertBox');
        if (data.health.status !== 'ok') {
          document.getElementById('alertDesc').innerText = data.health.recommendation;
          alertBox.style.display = 'flex';
        } else {
          alertBox.style.display = 'none';
        }
        
        // Update remote workers list
        const grid = document.getElementById('workersGrid');
        if (data.remote_workers && data.remote_workers.length > 0) {
          let html = '';
          data.remote_workers.forEach(w => {
            const tempVal = w.temp || 38.0;
            let tempColor = 'var(--success)';
            let cardClass = '';
            if (tempVal >= 65) {
              tempColor = 'var(--error)';
              cardClass = 'critical';
            } else if (tempVal >= 55) {
              tempColor = 'var(--warning)';
              cardClass = 'warning';
            }
            
            const isOnline = (Date.now() - w.last_seen) < 15000;
            if (!isOnline) {
              cardClass = 'offline';
            }
            
            const threadsCount = w.is_mining ? w.threads : 0;
            
            html += \`
              <div class="worker-card \${cardClass}">
                <div class="worker-header">
                  <div class="worker-name">
                    <span>📱</span>
                    <span>\${w.name}</span>
                  </div>
                  <span class="worker-badge" style="background: \${w.is_mining ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)'}; border-color: \${w.is_mining ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}; color: \${w.is_mining ? 'var(--success)' : 'var(--error)'};">
                    \${w.is_mining ? 'כורה' : 'מושהה'}
                  </span>
                </div>
                <div class="worker-stat-row">
                  <span class="worker-stat-label">טמפרטורה</span>
                  <span class="worker-stat-val" style="color: \${tempColor}; font-weight: bold;">\${tempVal.toFixed(1)}°C</span>
                </div>
                <div class="worker-stat-row">
                  <span class="worker-stat-label">קצב גיבוב</span>
                  <span class="worker-stat-val" style="color: var(--accent);">\${w.hashrate.toFixed(1)} KH/s</span>
                </div>
                <div class="worker-stat-row">
                  <span class="worker-stat-label">ליבות (Threads)</span>
                  <span class="worker-stat-val" style="direction: ltr; display: inline-block;">\${threadsCount} / \${w.max_cores}</span>
                </div>
                <div class="worker-stat-row">
                  <span class="worker-stat-label">פתרונות (Shares)</span>
                  <span class="worker-stat-val" style="color: var(--success);">\${w.shares_accepted}</span>
                </div>
                <div class="worker-stat-row">
                  <span class="worker-stat-label">זמן ריצה</span>
                  <span class="worker-stat-val">\${formatTime(w.uptime)}</span>
                </div>
                <div class="temp-bar-container">
                  <div class="temp-bar" style="width: \${Math.min(100, (tempVal / 80) * 100)}%; background-color: \${tempColor};"></div>
                </div>
              </div>
            \`;
          });
          grid.innerHTML = html;
        } else {
          grid.innerHTML = \`<div class="no-workers">לא מחוברים סמארטפונים כרגע. הפעל את סקריפט ה-Daemon בטלפון כדי לחבר אותו.</div>\`;
        }
        
        // Terminal logs update
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
</html>`);
      return;
    }
    
    res.writeHead(404);
    res.end('Not Found');
  }).listen(HTTP_PORT, BIND_HOST, () => {
    console.log(`🌐 לוח בקרה אינטרנטי זמין בכתובת: http://${BIND_HOST}:${HTTP_PORT}`);
    console.log(`🔑 טוקן אבטחה (DASHBOARD_TOKEN): ${process.env.DASHBOARD_TOKEN}`);
  });


  // ניהול החיבור (Socket)
  let socket = null;
  let reconnectWait = 1000;
  let isReconnecting = false;

  function flushPendingSubmissions() {
    if (pendingSubmissions.size > 0) {
      console.log(`🔌 [Recovery] מחזיר ${pendingSubmissions.size} שיתופים תלויים (Pending) לתור לשליחה מחדש.`);
      for (const [id, submission] of pendingSubmissions.entries()) {
        shareQueue.push({ method: submission.method, params: submission.params });
      }
      pendingSubmissions.clear();
      if (typeof savePendingSharesSync === 'function') {
        savePendingSharesSync();
      }
    }
  }

  function connectToPool() {
    if (socket) {
      flushPendingSubmissions();
      socket.destroy();
    }
    
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
      flushPendingSubmissions();
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
      isReconnecting = false;
      connectToPool();
    }, reconnectWait);
    reconnectWait = Math.min(reconnectWait * 2, 30000);
  }

  function send(method, params) {
    const currentMsgId = msgId++;
    if (method === 'mining.submit') {
      if (!socket || socket.destroyed || !socket.writable) {
        console.warn(`⚠️ החיבור לשרת מנותק! שומר את ה-Share זמנית בתור לשליחה מחדש...`);
        shareQueue.push({ method, params });
        if (typeof savePendingSharesSync === 'function') {
          savePendingSharesSync();
        }
        return;
      }
      pendingSubmissions.set(currentMsgId, { method, params, timestamp: Date.now() });
      if (typeof savePendingSharesSync === 'function') {
        savePendingSharesSync();
      }
    }
    if (!socket || socket.destroyed) return;
    const msg = { id: currentMsgId, method, params };
    try {
      socket.write(JSON.stringify(msg) + '\n');
    } catch (err) {
      console.error(`❌ שגיאה בכתיבה ל-Socket: ${err.message}`);
      if (method === 'mining.submit') {
        pendingSubmissions.delete(currentMsgId);
        console.warn(`📥 שומר את ה-Share שנכשל בכתיבה זמנית בתור לשליחה מחדש...`);
        shareQueue.push({ method, params });
        if (typeof savePendingSharesSync === 'function') {
          savePendingSharesSync();
        }
      }
    }
  }

  function handleMessage(msg) {
    // בדיקה אם מדובר בתגובה לשליחת Share
    const parsedId = Number(msg.id);
    if (msg.id && pendingSubmissions.has(parsedId)) {
      pendingSubmissions.delete(parsedId);
      if (typeof savePendingSharesSync === 'function') {
        savePendingSharesSync();
      }
      console.log(`📡 תגובה מקבלת Share מהבריכה (מזהה ${msg.id}): תוצאה=${JSON.stringify(msg.result)}, שגיאה=${JSON.stringify(msg.error)}`);
      if (msg.result === true || (msg.result && !msg.error)) {
        sharesAccepted++;
        saveStatsSync(); // שמירה מיידית של ה-Share שהתקבל בהצלחה
        console.log(`✅ Share התקבל בשרת בהצלחה! (סה"כ Accepted: ${sharesAccepted})`);
        
        // התראת שולחן עבודה על מנייה שאושרה
        exec(`notify-send -u normal "✅ מנייה אושרה!" "הבריכה קיבלה ואישרה את מניית הכרייה שלך!"`);
      } else {
        console.log(`⚠️ Share נדחה על ידי השרת. שגיאה: ${JSON.stringify(msg.error)}`);
        
        // התראת שולחן עבודה על מנייה שנדחתה
        exec(`notify-send -u normal "⚠️ מנייה נדחתה" "שרת הכרייה דחה את המנייה ששלחת."`);
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

    if (msg.id === 2) {
      if (msg.result === true) {
        console.log(`🔐 החיבור לבריכה אושר בהצלחה (Authorized)!`);
        if (shareQueue.length > 0) {
          console.log(`📤 שולח ${shareQueue.length} מניות (Shares) שנשמרו בתור בזמן הניתוק...`);
          while (shareQueue.length > 0) {
            const item = shareQueue.shift();
            send(item.method, item.params);
          }
        }
      } else {
        console.error(`❌ אישור החיבור לבריכה נכשל: ${JSON.stringify(msg.error)}`);
      }
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
        extranonce2Size,
        globalBestDifficulty: bestDifficulty
      }));
      return;
    }
  }

  // טעינת שיתופים תלויים שלא אושרו מהפעלות קודמות
  try {
    if (fs.existsSync('pending-shares.json')) {
      const data = fs.readFileSync('pending-shares.json', 'utf8');
      const list = JSON.parse(data);
      if (Array.isArray(list) && list.length > 0) {
        shareQueue.push(...list);
        console.log(`📂 [Recovery] שוחזרו ${list.length} שיתופים (Shares) תלויים מהפעלה קודמת שנשמרו ב-pending-shares.json.`);
      }
    }
  } catch (e) {
    console.error('שגיאה בטעינת pending-shares.json:', e.message);
  }

  connectToPool();

  function handleExit() {
    originalLog(`\n\nסיכום: ${sharesFound} shares נמצאו, ${sharesAccepted} התקבלו.`);
    saveStatsSync();
    if (socket) socket.end();
    workers.forEach(w => {
      w.intentionalStop = true;
      w.terminate();
    });
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

  // סורק תקופתי לזיהוי שיתופים (Shares) שפג תוקפם ללא אישור מהשרת
  setInterval(() => {
    const now = Date.now();
    const timedOut = [];
    
    for (const [id, submission] of pendingSubmissions.entries()) {
      if (now - submission.timestamp > ACK_TIMEOUT_MS) {
        timedOut.push({ id, submission });
      }
    }
    
    for (const { id, submission } of timedOut) {
      console.warn(`⚠️ [Timeout] השליחה מזהה ${id} פגה לאחר ${ACK_TIMEOUT_MS / 1000} שניות ללא תגובה מהבריכה.`);
      pendingSubmissions.delete(id);
      
      const { method, params } = submission;
      if (socket && !socket.destroyed && socket.writable) {
        console.log(`🔄 [Retry] ה-Socket כתיב, שולח מחדש את השיתוף מיד...`);
        send(method, params);
      } else {
        console.warn(`📥 [Queue] ה-Socket לא כתיב, שומר את השיתוף בתור לשליחה מחדש לאחר חיבור מחדש.`);
        shareQueue.push({ method, params });
      }
    }
  }, 5000);

} else {
  // ==========================================
  // WORKER THREAD LOGIC - כרייה מאומצת
  // ==========================================

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
  let hasNewBestLocal = false;
  let bestHashHex = '';

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
    }
  });

  function setupNewExtranonce2() {
    extranonce2 = crypto.randomBytes(extranonce2Size).toString('hex');
    nonce = 0;
    parentPort.postMessage({ type: 'extranonce2', extranonce2 });
    
    const coinbaseHex = currentJob.coinb1 + extranonce1 + extranonce2 + currentJob.coinb2;
    const coinbaseHash = doubleSha256(Buffer.from(coinbaseHex, 'hex'));
    const merkleRoot = buildMerkleRoot(coinbaseHash, merkleBranch);
    
    headerPrefixBuf = Buffer.concat([versionBuf, prevHashBuf, merkleRoot, ntimeBuf, nbitsBuf]);
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
        bestHashHex = reverseBytes(hash).toString('hex');
        hasNewBestLocal = true;
      }
      
      if (hashValue <= shareTarget) {
        // Fix for "Difficulty too low" error:
        // The stratum protocol expects the nonce in the submit payload as a hex string of the big-endian representation,
        // because the pool's validation reverses it back to little-endian when reconstructing the header.
        // Therefore, we write it as big-endian (BE) here so the hex string is '00000000' up to 'ffffffff' in normal readable order.
        const nonceBuf = Buffer.alloc(4);
        nonceBuf.writeUInt32BE(nonce, 0);
        const nonceHex = nonceBuf.toString('hex');
        
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
      
      if (hasNewBestLocal) {
        const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
        const diff = Number(maxTarget) / Number(bestHashValue);
        parentPort.postMessage({
          type: 'best_difficulty',
          difficulty: diff,
          hash: bestHashHex
        });
        hasNewBestLocal = false;
      }
      
      startTime = Date.now();
      localHashes = 0;
    }
    
    if (nonce > maxNonce) {
      setupNewExtranonce2(); 
    }
    
    setImmediate(mineChunk);
  }
}
