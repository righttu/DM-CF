# The deliverable arch is amd64, but wrangler builds this image on an arm64 VM
# where QEMU emulation crashes node (playwright install) and apt's sqv verifier.
# The official playwright image ships the same browser revisions playwright
# 1.63.0 expects (chromium-1243, headless shell, ffmpeg-1011), all system deps,
# tzdata, and PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -- no apt or install step.
ARG BASE_PLATFORM=linux/amd64
ARG BASE_DIGEST=sha256:96b39581c89131729a7ecb8d532314af54c7f9bcc7a61fe15c7a9e77602acf59
FROM --platform=${BASE_PLATFORM} mcr.microsoft.com/playwright/python@${BASE_DIGEST}

USER root

ENV PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    EMBEDDING_MODEL_PATH=/model \
    TZ=Asia/Shanghai

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu "torch==2.14.1+cpu" \
 && pip install --no-cache-dir -r /app/requirements.txt

COPY app/ /app
COPY server.py /app/server.py
COPY model/ /model

EXPOSE 8080
CMD ["python", "/app/server.py"]
