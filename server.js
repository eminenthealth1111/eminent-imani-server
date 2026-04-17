// ═══════════════════════════════════════════════════════════════
// EMINENT HEALTH SERVICES — IMANI VAPI WEBHOOK SERVER
// Deploy to Railway.app | server.js
// ═══════════════════════════════════════════════════════════════

const express    = require('express');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const dayjs      = require('dayjs');
const app        = express();
app.use(express.json());

// ── GOOGLE AUTH ─────────────────────────────────────────────────
const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: 'v3', auth });

// ── GMAIL TRANSPORT ─────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    type: 'OAuth2',
    user: process.env.GMAIL_USER,
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN
  }
});

// ── SCHEDULING RULES ────────────────────────────────────────────
const APPT_DURATION_MIN = 60;
const BUFFER_MIN        = 45;
const MAX_PER_DAY       = 12;
const CALENDAR_ID       = process.env.GOOGLE_CALENDAR_ID || 'primary';
const INTERNAL_EMAIL    = process.env.INTERNAL_EMAIL;
const BUSINESS_START_HR = 8;
const BUSINESS_END_HR   = 20;

// ── PRICING REFERENCE ───────────────────────────────────────────
const PRICING = {
  'DOT Urine Drug Test': 95,
  'Non-DOT Urine Drug Test': 85,
  'Hair Drug Test': 325,
  'Nail Drug Test': 325,
  'Urine Alcohol Test': 125,
  'Hair Alcohol Test': 325,
  'Nail Alcohol Test': 325,
  'Mobile Phlebotomy': 95,
  'Paramedical Exam': 95,
  'Diagnostic Specimen Collection': 85,
  'CPR Certification': 50,
  'CNA Skills Training': 75
};

const ADDONS = {
  travel: 35,
  sameDay: 25,
  afterHours: 50,
  observed: 25,
  chainOfCustody: 15
};

// ── HELPER: Get booked events for a day ─────────────────────────
async function getBookedSlots(date) {
  const start = dayjs(date).startOf('day').toISOString();
  const end   = dayjs(date).endOf('day').toISOString();
  const res   = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: start,
    timeMax: end,
    singleEvents: true,
    orderBy: 'startTime'
  });
  return res.data.items || [];
}

// ── HELPER: Get available slots respecting all rules ─────────────
async function getAvailableSlots(date) {
  const events = await getBookedSlots(date);
  if (events.length >= MAX_PER_DAY) return [];

  const slots  = [];
  let cursor   = dayjs(date).hour(BUSINESS_START_HR).minute(0).second(0);
  const dayEnd = dayjs(date).hour(BUSINESS_END_HR).minute(0);

  while (cursor.isBefore(dayEnd)) {
    const slotEnd = cursor.add(APPT_DURATION_MIN, 'minute');
    const blocked = events.some(ev => {
      const eStart   = dayjs(ev.start.dateTime);
      const eEnd     = dayjs(ev.end.dateTime);
      const bufStart = eStart.subtract(BUFFER_MIN, 'minute');
      const bufEnd   = eEnd.add(BUFFER_MIN, 'minute');
      return cursor.isBefore(bufEnd) && slotEnd.isAfter(bufStart);
    });
    if (!blocked) slots.push(cursor.format('HH:mm'));
    cursor = cursor.add(APPT_DURATION_MIN + BUFFER_MIN, 'minute');
  }
  return slots;
}

// ── HELPER: Build fee summary string ────────────────────────────
function buildFeeSummary(serviceType, addOns = {}) {
  const base   = PRICING[serviceType] || 0;
  let total    = base;
  const lines  = [`${serviceType}: $${base}`];

  if (addOns.travel)          { total += ADDONS.travel;         lines.push(`Mobile/Travel Fee: $${ADDONS.travel}`); }
  if (addOns.sameDay)         { total += ADDONS.sameDay;        lines.push(`Same-Day Rush Fee: $${ADDONS.sameDay}`); }
  if (addOns.afterHours)      { total += ADDONS.afterHours;     lines.push(`After-Hours Fee: $${ADDONS.afterHours}`); }
  if (addOns.observed)        { total += ADDONS.observed;       lines.push(`Observed Collection Fee: $${ADDONS.observed}`); }
  if (addOns.chainOfCustody)  { total += ADDONS.chainOfCustody; lines.push(`Chain of Custody Admin Fee: $${ADDONS.chainOfCustody}`); }

  lines.push(`Total Due: $${total}`);
  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════

// ── CHECK AVAILABILITY ──────────────────────────────────────────
app.post('/vapi/check-availability', async (req, res) => {
  try {
    const { requested_date } = req.body;
    const slots  = await getAvailableSlots(requested_date);
    const events = await getBookedSlots(requested_date);
    res.json({
      result: slots.length
        ? `Available slots on ${requested_date}: ${slots.slice(0, 5).join(', ')}. (${events.length}/${MAX_PER_DAY} booked today)`
        : `No availability on ${requested_date} — calendar is full. Check the next business day.`
    });
  } catch (err) {
    res.json({ result: `Could not check calendar: ${err.message}` });
  }
});

// ── BOOK APPOINTMENT ────────────────────────────────────────────
app.post('/vapi/book-appointment', async (req, res) => {
  try {
    const {
      client_name, client_email, client_phone,
      service_type, appointment_date, appointment_time,
      service_address, notes,
      add_travel, add_same_day, add_after_hours,
      add_observed, add_chain_of_custody
    } = req.body;

    const events = await getBookedSlots(appointment_date);
    if (events.length >= MAX_PER_DAY) {
      return res.json({ result: 'That day is fully booked. Please offer the next available date.' });
    }

    const addOns = {
      travel: add_travel,
      sameDay: add_same_day,
      afterHours: add_after_hours,
      observed: add_observed,
      chainOfCustody: add_chain_of_custody
    };

    const feeSummary = buildFeeSummary(service_type, addOns);
    const start      = dayjs(`${appointment_date}T${appointment_time}`);
    const end        = start.add(APPT_DURATION_MIN, 'minute');

    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `${service_type} — ${client_name}`,
        description: `Phone: ${client_phone}\nEmail: ${client_email}\n${feeSummary}\n${notes || ''}`,
        location: service_address,
        start: { dateTime: start.toISOString() },
        end:   { dateTime: end.toISOString() },
        reminders: {
          useDefault: false,
          overrides: [{ method: 'email', minutes: 1440 }]
        }
      }
    });

    await transporter.sendMail({
      from: `"Eminent Health Services" <${process.env.GMAIL_USER}>`,
      to: client_email,
      subject: 'Your Appointment is Confirmed — Eminent Health Services',
      html: `
        <div style="font-family:sans-serif;max-width:520px;color:#1a1a1a">
          <p>Hello ${client_name.split(' ')[0]},</p>
          <p>Your appointment with <strong>Eminent Health Services</strong> has been confirmed.</p>
          <table style="font-size:14px;line-height:2;width:100%">
            <tr><td><strong>Service</strong></td><td>${service_type}</td></tr>
            <tr><td><strong>Date</strong></td><td>${dayjs(appointment_date).format('dddd, MMMM D, YYYY')}</td></tr>
            <tr><td><strong>Time</strong></td><td>${dayjs(`${appointment_date}T${appointment_time}`).format('h:mm A')}</td></tr>
            <tr><td><strong>Location</strong></td><td>We come to you at: ${service_address}</td></tr>
          </table>
          <p style="margin-top:1rem;font-size:13px;color:#555;white-space:pre-line">${feeSummary}</p>
          <hr style="border:none;border-top:1px solid #eee;margin:1.5rem 0"/>
          <p style="font-size:13px">Questions? Call <strong>888-511-1134</strong> or email
            <a href="mailto:info@eminenthealthservice.org">info@eminenthealthservice.org</a>
          </p>
          <p>With care,<br/><strong>Eminent Health Services</strong><br/>
          888-511-1134 | eminenthealthservice.org</p>
        </div>
      `
    });

    res.json({
      result: `Confirmed. ${client_name} booked for ${service_type} on ${appointment_date} at ${appointment_time}. Confirmation sent to ${client_email}. ${feeSummary}`
    });
  } catch (err) {
    res.json({ result: `Booking failed: ${err.message}` });
  }
});

// ── RESCHEDULE ──────────────────────────────────────────────────
app.post('/vapi/reschedule-appointment', async (req, res) => {
  try {
    const {
      client_name, original_date, original_time,
      new_date, new_time, client_email
    } = req.body;

    const events = await getBookedSlots(original_date);
    const match  = events.find(e =>
      e.summary?.includes(client_name) &&
      dayjs(e.start.dateTime).format('HH:mm') === original_time
    );

    if (!match) return res.json({ result: 'Could not locate that appointment. Please verify the name and original date.' });

    const newStart = dayjs(`${new_date}T${new_time}`);
    const newEnd   = newStart.add(APPT_DURATION_MIN, 'minute');

    await calendar.events.update({
      calendarId: CALENDAR_ID,
      eventId: match.id,
      requestBody: {
        ...match,
        start: { dateTime: newStart.toISOString() },
        end:   { dateTime: newEnd.toISOString() }
      }
    });

    await transporter.sendMail({
      from: `"Eminent Health Services" <${process.env.GMAIL_USER}>`,
      to: client_email,
      subject: 'Your Appointment Has Been Rescheduled — Eminent Health Services',
      html: `
        <div style="font-family:sans-serif;max-width:520px">
          <p>Hello ${client_name.split(' ')[0]},</p>
          <p>Your appointment has been rescheduled to:</p>
          <p><strong>${dayjs(new_date).format('dddd, MMMM D, YYYY')} at ${dayjs(`${new_date}T${new_time}`).format('h:mm A')}</strong></p>
          <p>888-511-1134 | eminenthealthservice.org</p>
        </div>
      `
    });

    res.json({ result: `Rescheduled for ${new_date} at ${new_time}. Updated confirmation sent to ${client_email}.` });
  } catch (err) {
    res.json({ result: `Reschedule failed: ${err.message}` });
  }
});

// ── CANCEL ──────────────────────────────────────────────────────
app.post('/vapi/cancel-appointment', async (req, res) => {
  try {
    const { client_name, appointment_date, appointment_time } = req.body;
    const events = await getBookedSlots(appointment_date);
    const match  = events.find(e =>
      e.summary?.includes(client_name) &&
      dayjs(e.start.dateTime).format('HH:mm') === appointment_time
    );

    if (!match) return res.json({ result: 'Appointment not found. Please verify name and date.' });

    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: match.id });
    res.json({ result: `Appointment for ${client_name} on ${appointment_date} at ${appointment_time} has been cancelled.` });
  } catch (err) {
    res.json({ result: `Cancellation failed: ${err.message}` });
  }
});

// ── CAPTURE LEAD ────────────────────────────────────────────────
app.post('/vapi/capture-lead', async (req, res) => {
  try {
    const {
      contact_name, business_name, contact_email,
      contact_phone, monthly_volume, pain_point,
      solution_needed, lead_type
    } = req.body;

    const tag = lead_type || 'GENERAL LEAD';

    await transporter.sendMail({
      from: `"Eminent Imani Lead Capture" <${process.env.GMAIL_USER}>`,
      to: INTERNAL_EMAIL,
      subject: `[${tag}] — ${contact_name || 'New Lead'} | ${business_name || 'Individual'}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px">
          <h2 style="color:#1a1a1a">${tag}</h2>
          <table style="font-size:14px;line-height:2;width:100%">
            <tr><td><strong>Name / Title</strong></td><td>${contact_name}</td></tr>
            <tr><td><strong>Business</strong></td><td>${business_name || 'N/A'}</td></tr>
            <tr><td><strong>Phone</strong></td><td>${contact_phone}</td></tr>
            <tr><td><strong>Email</strong></td><td>${contact_email || 'Not provided'}</td></tr>
            <tr><td><strong>Monthly Volume</strong></td><td>${monthly_volume || 'Not provided'}</td></tr>
            <tr><td><strong>Pain Point</strong></td><td>${pain_point || 'N/A'}</td></tr>
            <tr><td><strong>Solution Needed</strong></td><td>${solution_needed || 'N/A'}</td></tr>
          </table>
          <p style="font-size:13px;color:#888">Follow up within 1 business day.</p>
        </div>
      `
    });

    const followUp = dayjs().add(1, 'day').hour(9).minute(0).second(0);
    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `[${tag}] Follow Up — ${contact_name || 'Lead'} | ${business_name || ''}`,
        description: `Phone: ${contact_phone}\nEmail: ${contact_email || 'N/A'}\nPain Point: ${pain_point}\nSolution: ${solution_needed}`,
        start: { dateTime: followUp.toISOString() },
        end:   { dateTime: followUp.add(30, 'minute').toISOString() },
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] }
      }
    });

    res.json({ result: `Lead captured for ${contact_name}. Internal team notified and follow-up set for tomorrow at 9 AM.` });
  } catch (err) {
    res.json({ result: `Lead capture failed: ${err.message}` });
  }
});

// ── AFTER HOURS LOG ─────────────────────────────────────────────
app.post('/vapi/afterhours-log', async (req, res) => {
  try {
    const { caller_name, caller_phone, reason, is_dot_urgent } = req.body;
    const flag = is_dot_urgent ? '[DOT URGENT] ' : '[AFTER HOURS] ';

    await transporter.sendMail({
      from: `"Eminent After Hours" <${process.env.GMAIL_USER}>`,
      to: INTERNAL_EMAIL,
      subject: `${flag}Missed Call — ${caller_name}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px">
          <h2>${flag}After-Hours Caller</h2>
          <p><strong>Name:</strong> ${caller_name}</p>
          <p><strong>Phone:</strong> ${caller_phone}</p>
          <p><strong>Reason:</strong> ${reason}</p>
          <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
        </div>
      `
    });

    res.json({ result: `After-hours message logged for ${caller_name}. Team will follow up next business day.` });
  } catch (err) {
    res.json({ result: `Log failed: ${err.message}` });
  }
});

// ── HEALTH CHECK ────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('Imani webhook server is live — Eminent Health Services');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Imani server running on port ${PORT}`));
