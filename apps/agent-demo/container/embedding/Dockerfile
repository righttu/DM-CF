FROM --platform=linux/amd64 python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu "torch==2.14.1+cpu" \
 && pip install --no-cache-dir -r /app/requirements.txt

COPY server.py /app/server.py
COPY model/ /model

EXPOSE 8080
CMD ["python", "/app/server.py"]
