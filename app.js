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

// ---- All your API routes (nudge, unread, subscribe) ----
// (keep them unchanged – they are already in your code)

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend running on port ${PORT} (0.0.0.0)`);
  startScheduler();
});

// ---- Keep-alive ping (just to keep event loop busy) ----
setInterval(() => {
  console.log('🔄 Keep-alive ping');
}, 60000);

// ---- Let the process exit gracefully if needed (but we keep it alive) ----
process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received – shutting down gracefully');
  // Do not exit immediately – let the health check handle it
});
