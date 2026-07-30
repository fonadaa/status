# API + Playwright checker for Render/Railway (not Vercel)
FROM mcr.microsoft.com/playwright/python:v1.51.0-noble

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
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
