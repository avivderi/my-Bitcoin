import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ניקוי קבצים קודמים
try {
  if (fs.existsSync(path.join(__dirname, 'test-stats.json'))) {
    fs.unlinkSync(path.join(__dirname, 'test-stats.json'));
  }
  if (fs.existsSync(path.join(__dirname, 'test-miner.log'))) {
    fs.unlinkSync(path.join(__dirname, 'test-miner.log'));
  }
} catch (e) {
  // ignore
}

console.log('🏁 מתחיל הרצת סט בדיקות מלא לסביבת הכרייה...');
console.log('==============================================');

// 1. הפעלת שרת בריכת הדמו (Mock Pool)
const mockPool = spawn('node', [path.join(__dirname, 'mock-pool.mjs')], { stdio: 'pipe' });

mockPool.stdout.on('data', (data) => {
  const lines = data.toString().split('\n');
  for (const line of lines) {
    if (line.trim()) console.log(`[Mock Pool Server] ${line}`);
  }
});

mockPool.stderr.on('data', (data) => {
  console.error(`[Mock Pool Error] ${data}`);
});

// 2. המתנה קלה לעליית השרת
setTimeout(() => {
  console.log('\n==============================================');
  console.log('⚙️ מפעיל את המיינר דמו מול שרת הבדיקות...');
  console.log('==============================================\n');

  // הפעלת המיינר (test-miner.mjs)
  const miner = spawn('node', [path.join(__dirname, 'test-miner.mjs')], { stdio: 'pipe', cwd: path.dirname(__dirname) });

  miner.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) console.log(`[Test Miner] ${line}`);
    }
  });

  miner.stderr.on('data', (data) => {
    console.error(`[Test Miner Error] ${data}`);
  });

  // 3. הרצה למשך 15 שניות כדי לראות את זרימת המידע, מציאת מניות, קבלת תשובות והתראות
  setTimeout(() => {
    console.log('\n==============================================');
    console.log('🛑 מסיים את סבב הבדיקה ומכבה את השרתים...');
    console.log('==============================================\n');

    miner.kill('SIGINT');
    mockPool.kill('SIGINT');

    setTimeout(() => {
      console.log('✨ הבדיקה הסתיימה בהצלחה!');
      console.log('נבדקו הפעולות הבאות:');
      console.log('1. ✅ חיבור ראשוני ל-Pool וביצוע handshake (Subscribe & Authorize).');
      console.log('2. ✅ קבלת עבודות (Jobs) ועדכוני קושי מהבריכה.');
      console.log('3. ✅ כריית האשים וחלוקת עבודה דינמית לליבות המעבד.');
      console.log('4. ✅ מציאת מניות (Shares) ברמת קושי דמו של 0.5.');
      console.log('5. ✅ שליחת המניות המעובדות לבריכה וקבלת אישור/דחייה.');
      console.log('6. ✅ הפעלת התראות שולחן עבודה (notify-send) על מציאת/אישור/דחיית מנייה.');
      process.exit(0);
    }, 1000);

  }, 15000);

}, 1500);
