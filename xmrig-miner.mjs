import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3225;
const XMRIG_API_PORT = 3226;
const XMRIG_PATH = path.join(__dirname, 'xmrig-miner', 'xmrig');
const XMRIG_DIR = path.join(__dirname, 'xmrig-miner');

let xmrigProcess = null;
let isMining = false;
let startError = null;

// פונקציה להפעלת תהליך ה-XMRig
function startXMRig() {
  if (xmrigProcess) return;
  
  console.log(`🚀 מפעיל את תוכנת XMRig מנתיב: ${XMRIG_PATH}`);
  
  // הרצה של ה-binary מתוך התיקייה שלו כדי שייקח את ה-config.json הנכון
  xmrigProcess = spawn(XMRIG_PATH, [], {
    cwd: XMRIG_DIR,
    stdio: 'ignore' // נתעלם מהפלט של הטרמינל כי אנו קוראים נתונים דרך ה-API
  });

  isMining = true;
  startError = null;

  xmrigProcess.on('error', (err) => {
    console.error('❌ שגיאה בהפעלת XMRig:', err.message);
    startError = err.message;
    xmrigProcess = null;
    isMining = false;
  });

  xmrigProcess.on('exit', (code, signal) => {
    console.log(`⏹️ תהליך XMRig הסתיים (קוד: ${code}, סיגנל: ${signal})`);
    xmrigProcess = null;
    isMining = false;
  });
}

// פונקציה לעצירת תהליך ה-XMRig
function stopXMRig() {
  if (!xmrigProcess) return;
  console.log('🛑 עוצר את תהליך XMRig...');
  xmrigProcess.kill('SIGTERM');
  xmrigProcess = null;
  isMining = false;
}

// הפעלה ראשונית של המיינר
startXMRig();

// יצירת השרת להצגת ממשק המשתמש וה-API
const server = http.createServer(async (req, res) => {
  const url = req.url;
  const method = req.method;

  // 1. נתיב ה-API לקבלת נתונים
  if (url === '/api/stats' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    
    if (!isMining) {
      res.end(JSON.stringify({
        status: 'stopped',
        hashrate: 0,
        shares_accepted: 0,
        shares_rejected: 0,
        ping: 0,
        pool: 'rx.unmineable.com:3333',
        uptime: 0,
        error: startError
      }));
      return;
    }

    // פנייה ל-HTTP API הפנימי של XMRig
    const apiOptions = {
      hostname: '127.0.0.1',
      port: XMRIG_API_PORT,
      path: '/1/summary',
      method: 'GET',
      timeout: 1000
    };

    const apiReq = http.request(apiOptions, (apiRes) => {
      let rawData = '';
      apiRes.on('data', (chunk) => { rawData += chunk; });
      apiRes.on('end', () => {
        try {
          const stats = JSON.parse(rawData);
          res.end(JSON.stringify({
            status: 'running',
            hashrate: stats.hashrate ? stats.hashrate.total[0] : 0, // 10s hashrate
            hashrate_60s: stats.hashrate ? stats.hashrate.total[1] : 0,
            shares_accepted: stats.results ? stats.results.shares_good : 0,
            shares_rejected: stats.results ? stats.results.shares_failed : 0,
            ping: stats.connection ? stats.connection.ping : 0,
            pool: stats.connection ? stats.connection.pool : 'rx.unmineable.com:3333',
            uptime: stats.connection ? stats.connection.uptime : 0,
            hugepages: stats.cpu ? stats.cpu.hugepages : false,
            cpu_brand: stats.cpu ? stats.cpu.brand : '12th Gen Intel Core i5-1235U',
            cpu_temp: stats.cpu ? stats.cpu.temp : 0
          }));
        } catch (e) {
          res.end(JSON.stringify({ status: 'error', message: 'שגיאה בפענוח נתוני ה-API' }));
        }
      });
    });

    apiReq.on('error', (err) => {
      res.end(JSON.stringify({ 
        status: 'starting', 
        message: 'מיינר מאותחל, ממתין לתשובת השרת הפנימי...',
        hashrate: 0,
        shares_accepted: 0,
        shares_rejected: 0,
        ping: 0,
        pool: 'rx.unmineable.com:3333',
        uptime: 0
      }));
    });
    apiReq.end();
  }

  // 2. נתיבי שליטה (Start / Stop)
  else if (url === '/api/start' && method === 'POST') {
    startXMRig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  } 
  
  else if (url === '/api/stop' && method === 'POST') {
    stopXMRig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  }

  else if (url === '/api/exit' && method === 'POST') {
    stopXMRig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'exiting' }));
    setTimeout(() => {
      process.exit(0);
    }, 500);
  }

  // 3. הצגת דף הבית (HTML Dashboard)
  else if (url === '/' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>לוח בקרת כריית מעבד (BTC)</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0d0e12;
            --card-bg: rgba(255, 255, 255, 0.03);
            --card-border: rgba(255, 255, 255, 0.08);
            --primary-orange: #f7931a; /* Bitcoin Orange */
            --monero-orange: #ff6600;  /* Monero Orange */
            --glow-color: rgba(247, 147, 26, 0.15);
            --text-color: #ffffff;
            --text-muted: #8e9297;
            --success-color: #4caf50;
            --danger-color: #f44336;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            font-family: 'Outfit', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }

        body {
            background-color: var(--bg-color);
            color: var(--text-color);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 40px 20px;
            overflow-x: hidden;
        }

        .container {
            width: 100%;
            max-width: 900px;
        }

        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 40px;
            padding-bottom: 20px;
            border-bottom: 1px solid var(--card-border);
        }

        .logo-section h1 {
            font-size: 1.8rem;
            font-weight: 800;
            letter-spacing: -0.5px;
            background: linear-gradient(135deg, var(--primary-orange), var(--monero-orange));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .logo-section p {
            font-size: 0.9rem;
            color: var(--text-muted);
            margin-top: 4px;
        }

        .server-status {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            border-radius: 20px;
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            font-size: 0.85rem;
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--danger-color);
            box-shadow: 0 0 10px var(--danger-color);
            transition: all 0.3s ease;
        }

        .status-dot.active {
            background: var(--success-color);
            box-shadow: 0 0 10px var(--success-color);
        }

        /* הגריד המרכזי של הכרטיסים */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }

        .card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 16px;
            padding: 24px;
            position: relative;
            backdrop-filter: blur(10px);
            transition: transform 0.2s ease, border-color 0.2s ease;
            overflow: hidden;
        }

        .card:hover {
            transform: translateY(-2px);
            border-color: rgba(247, 147, 26, 0.3);
        }

        .card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 4px;
            height: 100%;
            background: transparent;
        }

        .card.accent-orange::before {
            background: var(--primary-orange);
        }

        .card.accent-success::before {
            background: var(--success-color);
        }

        .card.accent-info::before {
            background: #2196f3;
        }

        .card-title {
            font-size: 0.85rem;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 12px;
        }

        .card-value {
            font-size: 2.2rem;
            font-weight: 800;
            display: flex;
            align-items: baseline;
            gap: 6px;
        }

        .card-unit {
            font-size: 1rem;
            color: var(--text-muted);
            font-weight: 400;
        }

        .card-footer {
            font-size: 0.8rem;
            color: var(--text-muted);
            margin-top: 8px;
            display: flex;
            justify-content: space-between;
        }

        /* כרטיס המהירות הגדול */
        .hashrate-large {
            grid-column: span 2;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            min-height: 180px;
        }

        @media (max-width: 768px) {
            .hashrate-large {
                grid-column: span 1;
            }
        }

        /* לוח הבקרה למטה */
        .controls-section {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 16px;
            padding: 24px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 20px;
            flex-wrap: wrap;
            margin-bottom: 30px;
        }

        .controls-info h3 {
            font-size: 1.1rem;
            font-weight: 600;
            margin-bottom: 4px;
        }

        .controls-info p {
            font-size: 0.85rem;
            color: var(--text-muted);
        }

        .btn-group {
            display: flex;
            gap: 12px;
        }

        .btn {
            padding: 12px 24px;
            font-size: 0.95rem;
            font-weight: 600;
            border-radius: 12px;
            border: none;
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .btn-primary {
            background: linear-gradient(135deg, var(--primary-orange), var(--monero-orange));
            color: #ffffff;
            box-shadow: 0 4px 15px rgba(247, 147, 26, 0.2);
        }

        .btn-primary:hover {
            opacity: 0.9;
            transform: scale(1.02);
        }

        .btn-danger {
            background: rgba(244, 67, 54, 0.15);
            color: var(--danger-color);
            border: 1px solid rgba(244, 67, 54, 0.3);
        }

        .btn-danger:hover {
            background: var(--danger-color);
            color: #ffffff;
        }

        .btn-secondary {
            background: rgba(255, 255, 255, 0.05);
            color: var(--text-color);
            border: 1px solid var(--card-border);
        }

        .btn-secondary:hover {
            background: rgba(255, 255, 255, 0.1);
        }

        /* תיבת מידע נוסף והנחיות */
        .info-box {
            background: rgba(33, 150, 243, 0.05);
            border: 1px solid rgba(33, 150, 243, 0.15);
            border-radius: 12px;
            padding: 18px;
            margin-bottom: 20px;
            font-size: 0.85rem;
            line-height: 1.5;
            color: #bbdefb;
        }

        .info-box strong {
            color: #e3f2fd;
        }

        .wallet-address {
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid var(--card-border);
            border-radius: 10px;
            padding: 12px 16px;
            margin-top: 10px;
            font-family: monospace;
            font-size: 0.85rem;
            color: var(--primary-orange);
            word-break: break-all;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .wallet-label {
            font-size: 0.8rem;
            color: var(--text-muted);
            margin-top: 15px;
        }

        .huge-pages-badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 6px;
            font-size: 0.75rem;
            font-weight: 600;
            margin-top: 5px;
        }

        .badge-success {
            background: rgba(76, 175, 80, 0.15);
            color: var(--success-color);
        }

        .badge-warning {
            background: rgba(255, 152, 0, 0.15);
            color: #ff9800;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="logo-section">
                <h1>⛏️ כריית מעבד חכמה (BTC)</h1>
                <p>ממשק ניהול ובקרה עבור XMRig & unMineable</p>
            </div>
            <div class="server-status">
                <div class="status-dot" id="status-dot"></div>
                <span id="status-text">מתחבר...</span>
            </div>
        </header>

        <!-- תיבת המלצה ל-Sudo במידה ו-Huge Pages כבוי -->
        <div class="info-box" id="hugepages-tip" style="display: none;">
            💡 <strong>שים לב: Huge Pages כבוי.</strong> כדי להגדיל את מהירות הכרייה בכ-20%-30% במעבד ה-i5 שלך, מומלץ להריץ את השרת עם הרשאות מנהל על ידי הרצת הפקודה <code>sudo node xmrig-miner.mjs</code> בטרמינל.
        </div>

        <div class="stats-grid">
            <!-- כרטיס מהירות גדול -->
            <div class="card hashrate-large accent-orange">
                <div>
                    <div class="card-title">קצב גיבוב נוכחי (Hashrate)</div>
                    <div class="card-value" id="hashrate-val">
                        0 <span class="card-unit">H/s</span>
                    </div>
                </div>
                <div class="card-footer">
                    <span>ממוצע 60 שניות: <strong id="hashrate-60s">0 H/s</strong></span>
                    <span>סוג אלגוריתם: <strong>RandomX (rx/0)</strong></span>
                </div>
            </div>

            <!-- כרטיס מעבד -->
            <div class="card accent-info">
                <div class="card-title">פרטי מעבד חומרה</div>
                <div class="card-value" id="cpu-name" style="font-size: 1.1rem; font-weight: 600; height: 50px; overflow: hidden;">
                    טוען...
                </div>
                <div id="hugepages-badge-container"></div>
            </div>

            <!-- כרטיס הישגים -->
            <div class="card accent-success">
                <div class="card-title">פתרונות שהתקבלו (Shares)</div>
                <div class="card-value" id="shares-val">
                    0 <span class="card-unit">Accepted</span>
                </div>
                <div class="card-footer">
                    <span style="color: var(--danger-color)">נדחו: <strong id="shares-rejected">0</strong></span>
                    <span>שרת: <strong id="pool-ping">0ms</strong></span>
                </div>
            </div>

            <!-- כרטיס זמנים -->
            <div class="card">
                <div class="card-title">זמן פעילות חיבור (Uptime)</div>
                <div class="card-value" id="uptime-val" style="font-size: 1.8rem;">
                    00:00:00
                </div>
                <div class="card-footer" style="width: 100%;">
                    <span>מחובר ל-Pool: <strong id="pool-name">טוען...</strong></span>
                </div>
            </div>
        </div>

        <!-- לוח בקרת הפעלה -->
        <div class="controls-section">
            <div class="controls-info">
                <h3 id="control-state-title">פעולת הכרייה פעילה</h3>
                <p id="control-state-desc">המעבד כורה ומייצר ביטקוין. לחיצה על כפתור עצירה תפסיק את פעילות הכרייה לחלוטין.</p>
            </div>
            <div class="btn-group">
                <button class="btn btn-secondary" onclick="window.open('https://unmineable.com/coins/BTC/address/bc1qwm58u3zaf63f0dx63qk5p867kps26ykf3uylcs', '_blank')">🌐 צפה ברווחים באתר</button>
                <button class="btn btn-danger" id="toggle-btn" onclick="toggleMining()">🛑 עצור כרייה</button>
            </div>
        </div>

        <div class="wallet-label">כתובת ארנק היעד לתשלום בביטקוין (BTC):</div>
        <div class="wallet-address">
            <span>bc1qwm58u3zaf63f0dx63qk5p867kps26ykf3uylcs</span>
            <span style="font-size: 0.75rem; color: var(--text-muted);">unMineable Verified</span>
        </div>
        
        <button class="btn btn-secondary" style="margin-top: 30px; width: 100%; justify-content: center; background: transparent; border-color: rgba(255,255,255,0.05)" onclick="exitServer()">❌ כבה את שרת הניהול לחלוטין</button>
    </div>

    <script>
        let currentStatus = 'stopped';

        async function updateStats() {
            try {
                const response = await fetch('/api/stats');
                const data = await response.json();
                
                // עדכון סטטוס שרת
                const dot = document.getElementById('status-dot');
                const text = document.getElementById('status-text');
                const toggleBtn = document.getElementById('toggle-btn');
                const stateTitle = document.getElementById('control-state-title');
                const stateDesc = document.getElementById('control-state-desc');
                
                currentStatus = data.status;

                if (data.status === 'running') {
                    dot.className = 'status-dot active';
                    text.innerText = 'מחובר וכורה';
                    toggleBtn.className = 'btn btn-danger';
                    toggleBtn.innerText = '🛑 עצור כרייה';
                    stateTitle.innerText = 'פעולת הכרייה פעילה';
                    stateDesc.innerText = 'המעבד כורה ומייצר ביטקוין. לחיצה על כפתור עצירה תפסיק את פעילות הכרייה לחלוטין.';
                } else if (data.status === 'starting') {
                    dot.className = 'status-dot active';
                    dot.style.background = '#ff9800';
                    dot.style.boxShadow = '0 0 10px #ff9800';
                    text.innerText = 'מתחיל עבודה...';
                    toggleBtn.className = 'btn btn-danger';
                    toggleBtn.innerText = '🛑 עצור כרייה';
                } else {
                    dot.className = 'status-dot';
                    text.innerText = 'כבוי';
                    toggleBtn.className = 'btn btn-primary';
                    toggleBtn.innerText = '⚡ הפעל כרייה';
                    stateTitle.innerText = 'פעולת הכרייה כבויה';
                    stateDesc.innerText = 'הכרייה כבויה כרגע. לחץ על הפעלה כדי להתחיל להשתמש במעבד לכרייה.';
                }

                // עדכון מהירות
                document.getElementById('hashrate-val').innerHTML = data.hashrate.toFixed(1) + ' <span class="card-unit">H/s</span>';
                document.getElementById('hashrate-60s').innerText = (data.hashrate_60s || 0).toFixed(1) + ' H/s';

                // עדכון מעבד
                document.getElementById('cpu-name').innerText = data.cpu_brand || '12th Gen Intel Core i5-1235U';
                
                // עדכון Huge Pages
                const tipBox = document.getElementById('hugepages-tip');
                const badgeContainer = document.getElementById('hugepages-badge-container');
                if (data.status === 'running' || data.status === 'starting') {
                    if (data.hugepages) {
                        tipBox.style.display = 'none';
                        badgeContainer.innerHTML = '<span class="huge-pages-badge badge-success">Huge Pages: פעיל ✔️</span>';
                    } else {
                        tipBox.style.display = 'block';
                        badgeContainer.innerHTML = '<span class="huge-pages-badge badge-warning">Huge Pages: לא פעיל (אין הרשאות)</span>';
                    }
                } else {
                    tipBox.style.display = 'none';
                    badgeContainer.innerHTML = '';
                }

                // עדכון Shares
                document.getElementById('shares-val').innerHTML = data.shares_accepted + ' <span class="card-unit">Accepted</span>';
                document.getElementById('shares-rejected').innerText = data.shares_rejected;
                document.getElementById('pool-ping').innerText = data.ping + 'ms';

                // עדכון Uptime
                if (data.uptime > 0) {
                    const sec = data.uptime;
                    const hours = Math.floor(sec / 3600).toString().padStart(2, '0');
                    const mins = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
                    const secs = (sec % 60).toString().padStart(2, '0');
                    document.getElementById('uptime-val').innerText = hours + ':' + mins + ':' + secs;
                } else {
                    document.getElementById('uptime-val').innerText = '00:00:00';
                }

                document.getElementById('pool-name').innerText = data.pool;

            } catch (e) {
                console.error('Error fetching stats:', e);
            }
        }

        async function toggleMining() {
            const endpoint = currentStatus === 'running' || currentStatus === 'starting' ? '/api/stop' : '/api/start';
            await fetch(endpoint, { method: 'POST' });
            updateStats();
        }

        async function exitServer() {
            if (confirm('האם אתה בטוח שברצונך לכבות את שרת הניהול של הכורייה? זה יכבה גם את תהליך הכרייה הנוכחי.')) {
                await fetch('/api/exit', { method: 'POST' });
                alert('שרת הניהול כובה בהצלחה. החלון ייסגר.');
                window.close();
            }
        }

        // עדכון סטטיסטיקות כל 2 שניות
        setInterval(updateStats, 2000);
        updateStats();
    </script>
</body>
</html>`);
  }

  // 4. נתיבים לא קיימים
  else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🌐 שרת ניהול כריית מעבד (BTC) עלה בהצלחה!`);
  console.log(`🖥️  לוח בקרה זמין בכתובת: http://localhost:${PORT}`);
  console.log(`====================================================`);

  // פתיחה אוטומטית של הדפדפן לעמוד הניהול
  const startUrl = `http://localhost:${PORT}`;
  const startCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(startCmd, [startUrl], { detached: true, stdio: 'ignore' }).unref();
});

// סגירה מסודרת של ה-XMRig כאשר שרת הניהול נסגר
process.on('SIGINT', () => {
  stopXMRig();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopXMRig();
  process.exit(0);
});
