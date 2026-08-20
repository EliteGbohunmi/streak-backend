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
    'https://streak-frontend.vercel.app',   // ← added
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true
}));
app.use(express.json());

// ---- Health ----
app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---- Nudge endpoint (full code) ----
app.post('/api/notifications/nudge', async (req, res) => {
  // ... (keep your existing code – it's unchanged)
});

// ---- Unread, mark-read, vapid-key, subscribe, unsubscribe ----
// ... (all your existing routes)

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend running on port ${PORT} (0.0.0.0)`);
  startScheduler();
});

// ---- Keep‑alive ----
setInterval(() => {
  console.log('🔄 Keep-alive ping');
}, 60000);

// ---- Graceful shutdown ----
process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received – shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
process.on('SIGINT', () => {
  console.log('⚠️ SIGINT received – shutting down');
  server.close(() => process.exit(0));
});
