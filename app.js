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

// ---- All your existing API routes (nudge, unread, subscribe) go here ----
// (copy them from your current app.js – they are unchanged)

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend running on port ${PORT} (0.0.0.0)`);
  startScheduler();
});

// ---- Forever keep-alive (prevents exit) ----
(async function eternal() {
  console.log('⏳ Eternal loop started');
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 60000));
    console.log('🔄 Eternal ping');
  }
})();

// Force stdin to stay open (just in case)
process.stdin.resume();

// ---- Ignore SIGTERM ----
process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received – ignoring');
});
process.on('SIGINT', () => {
  console.log('⚠️ SIGINT received – ignoring');
});
