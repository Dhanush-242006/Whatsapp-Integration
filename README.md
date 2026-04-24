# 📱 WhatsApp Inactivity Monitor

Automatically monitors a WhatsApp training group and alerts the Training Lead (TL) when candidates are inactive.

---

## 🚀 Setup in 5 Steps

### Step 1 — Install Node.js
Download from: https://nodejs.org (v18 or higher)

### Step 2 — Install dependencies
```bash
npm install
```

### Step 3 — Configure the bot
Open `config.js` and update:

| Setting | What to put |
|---|---|
| `GROUP_NAME` | Exact name of your WhatsApp group |
| `TL_NUMBERS` | TL's phone number with country code (no + sign) |
| `DAILY_CHECK_TIME` | When to send daily alert (default: 6 PM weekdays) |
| `TIMEZONE` | Your timezone (default: Asia/Kolkata) |

Example:
```js
GROUP_NAME: 'Consulting Batch June 2025',
TL_NUMBERS: ['919876543210'],
DAILY_CHECK_TIME: '0 18 * * 1-5',  // 6 PM Mon-Fri
TIMEZONE: 'Asia/Kolkata',
```

### Step 4 — Run the bot
```bash
npm start
```

### Step 5 — Scan QR Code
A QR code will appear in the terminal.
Open WhatsApp on your phone → Settings → Linked Devices → Link a Device → Scan the QR code.

✅ Bot is now live!

---

## 💬 How It Works

1. Bot monitors every message in the group
2. Logs which candidates sent messages each day
3. At the configured time (e.g. 6 PM), checks who was silent
4. Sends a WhatsApp alert to the TL listing inactive candidates

---

## 🤖 TL Commands (send in the group)

| Command | What it does |
|---|---|
| `!check` | Instantly run the inactivity check |
| `!status` | See who has been active today |

---

## 📂 Project Structure

```
whatsapp-monitor/
├── src/
│   └── bot.js          ← Main bot logic
├── data/
│   └── activity.json   ← Auto-created, stores daily activity
├── config.js           ← ⚙️ Your settings go here
├── package.json
└── README.md
```

---

## ⚠️ Important Notes

- The WhatsApp account used to run the bot must be **inside the group**
- Keep the terminal/server running 24/7 (use PM2 for production)
- Activity data resets daily automatically

### Run 24/7 with PM2 (optional):
```bash
npm install -g pm2
pm2 start src/bot.js --name "wa-monitor"
pm2 save
pm2 startup
```

---

## 🔔 Sample Alert Message TL Receives

```
⚠️ Inactivity Alert - 2025-04-24

The following candidates have been inactive today and have not reported:

1. Rahul Sharma (+919876543210)
2. Priya Singh (+918765432109)
3. Arjun Reddy (+917654321098)

Please follow up with them. 🙏
```
