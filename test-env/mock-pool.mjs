import net from 'net';

const PORT = 3334;

const server = net.createServer((socket) => {
  console.log('🔌 [Mock Pool] מיינר התחבר לשרת הדמו!');

  socket.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        console.log(`📥 [Mock Pool] התקבלה הודעה מהמיינר:`, msg);

        if (msg.method === 'mining.subscribe') {
          // תגובה לחיבור ורישום
          const response = {
            id: msg.id,
            result: [
              [
                ['mining.set_difficulty', '1'],
                ['mining.notify', '1']
              ],
              'b7cf87a7', // extranonce1
              4           // extranonce2 size
            ],
            error: null
          };
          socket.write(JSON.stringify(response) + '\n');
          console.log(`📤 [Mock Pool] שולח תגובת רישום (Subscribe)`);
        } 
        
        else if (msg.method === 'mining.authorize') {
          // אישור החיבור
          const response = {
            id: msg.id,
            result: true,
            error: null
          };
          socket.write(JSON.stringify(response) + '\n');
          console.log(`📤 [Mock Pool] שולח תגובת אישור חיבור (Authorized)`);

          // מייד לאחר האישור, שולחים קושי התחלתי ועבודה ראשונה
          setTimeout(() => {
            const diffMsg = {
              id: null,
              method: 'mining.set_difficulty',
              params: [0.5] // קושי קל מאוד (0.5) כדי שהמיינר ימצא מניות בקלות!
            };
            socket.write(JSON.stringify(diffMsg) + '\n');
            console.log(`📤 [Mock Pool] שולח הגדרת קושי דמו: 0.5`);
          }, 100);

          setTimeout(() => {
            const jobMsg = {
              id: null,
              method: 'mining.notify',
              params: [
                'job_demo_123', // jobId
                '0000000000000000000000000000000000000000000000000000000000000000', // prevhash
                '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff25036b0d081f2f536c757368506f6f6c2f', // coinbase1
                'ffffffff0100f2052a010000001976a914c825a1ecf2a6830c4401620c3a16f1995057c2ab88ac00000000', // coinbase2
                [], // merkle branch
                '00000002', // version
                '1d00ffff', // bits
                '5f5e1000', // ntime
                true // clean jobs
              ]
            };
            socket.write(JSON.stringify(jobMsg) + '\n');
            console.log(`📤 [Mock Pool] שולח עבודת כרייה (Job) למיינר`);
          }, 200);
        } 
        
        else if (msg.method === 'mining.submit') {
          const [worker, jobId, extranonce2, ntime, nonce] = msg.params;
          console.log(`⛏️ [Mock Pool] התקבלה הגשת מנייה (Submit) מ-${worker}! jobId=${jobId}, nonce=${nonce}`);

          // נדמה קבלה של חלק מהמניות ודחייה של מניות עם שגיאות כדי לבדוק את כל מקרי הקצה
          const isSuccessful = Math.random() > 0.3; // 70% הצלחה, 30% דחייה לצורך בדיקה

          if (isSuccessful) {
            const response = {
              id: msg.id,
              result: true,
              error: null
            };
            socket.write(JSON.stringify(response) + '\n');
            console.log(`📤 [Mock Pool] ✅ אישרתי את המנייה (Accepted)`);
          } else {
            // נשפוך שגיאה מדומה
            const response = {
              id: msg.id,
              result: null,
              error: [21, 'Job not found (Mock Error)', null]
            };
            socket.write(JSON.stringify(response) + '\n');
            console.log(`📤 [Mock Pool] ⚠️ דחיתי את המנייה (Rejected) עם שגיאה מדומה`);
          }
        }
      } catch (e) {
        console.error('❌ [Mock Pool] שגיאה בפענוח הודעה:', e.message);
      }
    }
  });

  socket.on('end', () => {
    console.log('🔌 [Mock Pool] מיינר התנתק משרת הדמו');
  });

  socket.on('error', (err) => {
    console.log('⚠️ [Mock Pool] שגיאת תקשורת:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 [Mock Pool] שרת בריכת דמו (Stratum Server) מאזין בפורט ${PORT}...`);
});
