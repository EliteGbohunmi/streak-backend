const express = require('express');
const cors = require('cors');
require('dotenv').config();
const supabase = require('./supabase');
const { notifyUser, sendEmail, getRandomNudgeMessage } = require('./notificationService');
const { startScheduler } = require('./scheduler');

// ---- Global error handlers ----
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

// ---- Health endpoints ----
app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---- All API routes (nudge, unread, subscribe, etc.) ----
// ... (keep all your existing routes – they are unchanged)

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend running on port ${PORT} (0.0.0.0)`);
  startScheduler();
});

// ---- Eternal keep-alive (prevents exit) ----
setInterval(() => {
  console.log('🔄 Keep-alive ping (interval)');
}, 60000);

// Force stdin to stay open (prevents Node from exiting)
process.stdin.resume();

// ---- Ignore SIGTERM ----
process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received – ignoring');
  // Keep running; do not call process.exit()
});
process.on('SIGINT', () => {
  console.log('⚠️ SIGINT received – ignoring');
});
