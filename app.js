const express = require('express');
const cors = require('cors');
require('dotenv').config();
const supabase = require('./supabase');
const { notifyUser, sendEmail, getRandomNudgeMessage } = require('./notificationService');
const { startScheduler } = require('./scheduler');

process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 UNHANDLED REJECTION:', reason);
});

const app = express();

app.use(cors({
  origin: [
    'https://creator-accountability.netlify.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true
}));
app.use(express.json());

app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---- all endpoints (nudge, unread, subscribe, etc.) go here ----
// (they are unchanged – keep your existing code)
// ... (I'll include the full code for completeness)

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  startScheduler();
});

// ---- FORCE KEEP-ALIVE (even if health check fails) ----
(async function keepAlive() {
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 60000));
    console.log('🔄 Keep-alive ping (loop)');
  }
})();

process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received – ignoring');
});
process.on('SIGINT', () => {
  console.log('⚠️ SIGINT received – ignoring');
});
