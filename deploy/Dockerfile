# Toran on the VPS: Node 24 runs the TypeScript as it is (no build step).
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production TORAN_ENV=prod TORAN_HOME=/data TORAN_LISTEN=0.0.0.0 TORAN_TRUST_PROXY=1 PORT=4710

COPY package.json package-lock.json ./
# playwright-core (the headless fallback, screenshots) is a dev dependency and stays out of the image.
RUN npm ci --omit=dev --ignore-scripts && npm rebuild onnxruntime-node sharp

COPY src ./src
COPY scripts ./scripts
COPY assets ./assets
COPY examples ./examples
COPY tsconfig.json ./

# /data holds the private folder: the embedding model cache, logs, eval transcripts, known-stores.txt.
VOLUME ["/data"]
EXPOSE 4710
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4710/healthz',{headers:{host:'127.0.0.1:4710'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "scripts/web.ts", "--worker"]
