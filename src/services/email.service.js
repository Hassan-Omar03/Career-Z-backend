const nodemailer = require('nodemailer');
const env = require('../config/env');

let transporter = null;
if (env.smtp.host) {
  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: Number(env.smtp.port),
    secure: Number(env.smtp.port) === 465,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined
  });
}

// In development, or until the client configures SMTP credentials, emails are logged
// to the console instead of failing the request. This keeps auth workflows testable
// without a paid email provider (see Scope of Work: client provides email/SMS services).
async function sendEmail({ to, subject, html, text }) {
  if (!transporter) {
    console.log('\n[EMAIL:DEV-MODE] ---------------------------------');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(text || html);
    console.log('-----------------------------------------------\n');
    return { simulated: true };
  }

  return transporter.sendMail({
    from: env.smtp.from,
    to,
    subject,
    html,
    text
  });
}

// Branded HTML wrapper used for all transactional emails (OTP codes, etc.)
function otpEmailTemplate({ heading, intro, code, minutes }) {
  return `
  <div style="background:#F4F1E8; padding:40px 16px; font-family:'Segoe UI',Arial,sans-serif;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 8px 24px rgba(11,20,16,0.12);">
      <div style="background:linear-gradient(120deg,#0F3D2E,#1B8A63); padding:28px 32px; text-align:center;">
        <span style="font-family:Georgia,serif; font-size:24px; font-weight:700; color:#ffffff;">Career<span style="color:#E3A23C;">Z.pk</span></span>
      </div>
      <div style="padding:32px;">
        <h1 style="font-family:Georgia,serif; font-size:20px; color:#0F3D2E; margin:0 0 12px;">${heading}</h1>
        <p style="font-size:14.5px; color:#4B5A53; line-height:1.6; margin:0 0 24px;">${intro}</p>
        <div style="background:#F4F1E8; border:1px dashed #D8CFB8; border-radius:12px; text-align:center; padding:20px; margin-bottom:24px;">
          <span style="font-family:'Courier New',monospace; font-size:32px; font-weight:700; letter-spacing:8px; color:#0F3D2E;">${code}</span>
        </div>
        <p style="font-size:13px; color:#8A9490; margin:0;">This code expires in ${minutes} minutes. If you didn't request this, you can safely ignore this email.</p>
      </div>
      <div style="background:#F4F1E8; padding:18px 32px; text-align:center; border-top:1px solid #EAE4D3;">
        <span style="font-size:12px; color:#8A9490;">© ${new Date().getFullYear()} CareerZ.pk — The Complete AI-Powered Education Ecosystem</span>
      </div>
    </div>
  </div>`;
}

module.exports = { sendEmail, otpEmailTemplate };
