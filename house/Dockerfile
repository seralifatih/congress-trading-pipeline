FROM apify/actor-node:20

# tesseract-ocr: the OCR fallback for scanned House PTR filings (see
# src/ocr/tesseractCli.ts) shells out to the native Tesseract CLI for date
# and owner-code cells instead of using tesseract.js — a byte-for-byte
# diagnosis proved tesseract.js misreads certain images the CLI reads
# correctly given identical input bytes (see that file's header comment).
# apify/actor-node is Alpine-based (node:20-alpine), so apk, not apt-get.
RUN apk add --no-cache tesseract-ocr

# Copy manifests first — layer cache busts only on dep changes
COPY package*.json ./

# Install all deps including devDependencies (tsc needed for build)
RUN npm ci --include=dev

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript → dist/
RUN npm run build

# Prune devDependencies after build
RUN npm prune --omit=dev

CMD ["node", "dist/apify.js"]
