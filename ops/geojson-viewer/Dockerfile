FROM python:3.12-alpine
WORKDIR /app
COPY server.py index.html ./
COPY vendor ./vendor
ENV PORT=8899 DATA_DIR=/data
EXPOSE 8899
CMD ["python", "server.py"]
