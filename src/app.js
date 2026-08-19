console.log('🚀 App starting...');

process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION:', reason);
  process.exit(1);
});

const express = require('express')
const cors = require('cors')
require('dotenv').config()

const { startScheduler } = require('./jobs/scheduler')

const app = express()

app.use(cors({
  origin: [
    'https://creator-accountability.netlify.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true
}))
app.use(express.json())

app.use('/api/notifications', require('./routes/notifications'))
app.use('/api/streaks', require('./routes/streaks'))
app.use('/api/ai', require('./routes/ai'))

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }))

const PORT = process.env.PORT || 4000
app.listen(PORT, () => {
  console.log(`Streak backend running on port ${PORT}`)
  startScheduler()
})

// Keep the process alive (Railway sometimes kills idle containers)
setInterval(() => {
  // no-op, just to keep the event loop busy
}, 60000);

process.on('SIGTERM', () => {
  console.log('⚠️ Received SIGTERM, but we are ignoring it');
  // Don't exit – keep running
});

module.exports = app
