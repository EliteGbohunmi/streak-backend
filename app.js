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
    'https://creator-accountability-obv8-eight.vercel.app',
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

// ---- API Routes ----
app.use('/api/community', require('./routes/community'));
app.use('/api/ai', require('./routes/ai'));          // <-- AI route

// ---- Nudge endpoint (direct) ----
app.post('/api/notifications/nudge', async (req, res) => {
  // ... (your existing nudge code)
});

// ---- Unread notifications ----
app.get('/api/notifications/unread', async (req, res) => {
  // ... 
});

app.post('/api/notifications/mark-read', async (req, res) => {
  // ...
});

// ---- VAPID & Push Subscription ----
app.get('/api/notifications/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

app.post('/api/notifications/subscribe', async (req, res) => {
  // ...
});

app.delete('/api/notifications/subscribe', async (req, res) => {
  // ...
});

// ---- Start server ----
const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend running on port ${PORT} (0.0.0.0)`);
  startScheduler();
});

setInterval(() => {
  console.log('🔄 Keep-alive ping');
}, 60000);

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
