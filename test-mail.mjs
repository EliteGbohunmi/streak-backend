import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: 'nudgesender@gmail.com',
    pass: 'wgvvsrssxuhrsqyp',
  },
});

await transporter.sendMail({
  from: '"Your App" <nudgesender@gmail.com>',
  to: 'ayomidefriend5@gmail.com',
  subject: 'Hello from Nodemailer',
  html: '<h1>It works!</h1><p>This was sent with Gmail SMTP.</p>',
});

console.log('Email sent!');
