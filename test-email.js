const emailFunctionUrl = process.env.EMAIL_FUNCTION_URL;
const emailFunctionSecret = process.env.EMAIL_FUNCTION_SECRET;
const testEmail = process.env.TEST_EMAIL;

async function main() {
  if (!emailFunctionUrl || !emailFunctionSecret || !testEmail) {
    throw new Error(
      'Missing EMAIL_FUNCTION_URL, EMAIL_FUNCTION_SECRET, or TEST_EMAIL.'
    );
  }

  console.log('Starting manual email delivery test...');

  const response = await fetch(emailFunctionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-email-secret': emailFunctionSecret
    },
    body: JSON.stringify({
      to: testEmail,
      subject: 'Creator Accountability Email Test',
      html: `
        <div style="font-family:Arial,sans-serif;padding:24px">
          <h2>Email delivery test successful!</h2>
          <p>Your Creator Accountability email notification system
          has successfully delivered a test request.</p>
          <p>This message was sent through GitHub Actions,
          Supabase Edge Functions, and Gmail SMTP.</p>
        </div>
      `
    }),
    signal: AbortSignal.timeout(30000)
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error('Email function returned status:', response.status);
    console.error('Response:', responseText);
    process.exitCode = 1;
    return;
  }

  console.log('Email function accepted the request.');
  console.log('HTTP status:', response.status);
  console.log('Check your inbox and spam folder for the test email.');
}

main().catch((error) => {
  console.error('EMAIL TEST FAILED:', error.message);
  process.exitCode = 1;
});
