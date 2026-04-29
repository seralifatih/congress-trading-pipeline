FROM apify/actor-node:20

# Copy manifests first — layer cache busts only on dep changes
COPY package*.json ./

# Install all deps (devDependencies needed for tsc)
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript → dist/
RUN npm run build

# Prune devDependencies after build
RUN npm prune --omit=dev

CMD ["node", "dist/apify.js"]
