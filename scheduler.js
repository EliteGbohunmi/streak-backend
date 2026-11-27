const cron = require('node-cron');
const { execFile } = require('child_process');
const path = require('path');

let isRunning = false;

function startScheduler() {
  console.log('[SCHEDULER] Scheduler started.');

  cron.schedule('*/15 * * * *', () => {
    if (isRunning) {
      console.log('[CRON] Previous runner is still running. Skipping this cycle.');
      return;
    }

    isRunning = true;

    const script = path.join(__dirname, 'scheduled-runner.js');

    console.log('[CRON] Starting scheduled notification runner.');

    execFile(
      'node',
      [script],
      {
        env: process.env,
        timeout: 10 * 60 * 1000,
        maxBuffer: 5 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        if (stdout) console.log(stdout.trim());
        if (stderr) console.error(stderr.trim());

        if (err) {
          console.error('[CRON] Runner failed:', err.message);
        } else {
          console.log('[CRON] Runner completed successfully.');
        }

        isRunning = false;
      }
    );
  });

  console.log('[SCHEDULER] All cron jobs scheduled.');
}

module.exports = { startScheduler };
