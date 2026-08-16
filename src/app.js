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

module.exports = app
