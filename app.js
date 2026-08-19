console.log('🚀 App starting...');
app.use('/api/notifications', require('./routes/notifications'))
app.use('/api/streaks', require('./routes/streaks'))
app.use('/api/ai', require('./routes/ai'))
app.use('/api/test', require('./routes/test'))
