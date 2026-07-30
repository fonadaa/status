# Status Desk

Check **Passport Seva** and **GST ARN** status from one UI.

## Local

```bash
cp .env.example .env   # fill credentials
pip install -r requirements.txt
playwright install chromium
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) → **Check status**.

CLI only: `npm run check` or `python check_status.py`.

## Deploy

| Layer | Host | Notes |
|-------|------|--------|
| UI | [Vercel](https://status-desk.vercel.app) | static `public/` |
| API | [Render](https://status-hle5.onrender.com) | Docker (`Dockerfile`) |

Set `apiUrl` in `public/config.js` to your Render URL. Playwright cannot run on Vercel.

## Project layout

```
server.js          Node API + static files
check_status.py    Playwright checker (image OCR for GST captcha)
public/            UI
Dockerfile         Render image
```
