# Playwright + Node API (cannot run on Vercel — use Render/Railway/Fly)
# bump: 2026-07-30-nowhisper — optional whisper; image OCR on cloud
FROM mcr.microsoft.com/playwright/python:v1.51.0-noble

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs npm ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-cloud.txt ./requirements-cloud.txt
RUN pip install --no-cache-dir -r requirements-cloud.txt \
    && playwright install chromium

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY check_status.py server.js ./
COPY public ./public

ENV PORT=3000
ENV CHECK_HEADLESS=true
ENV PYTHONUNBUFFERED=1
ENV PYTHON_PATH=python3

EXPOSE 3000
CMD ["node", "server.js"]
