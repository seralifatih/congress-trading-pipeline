FROM apify/actor-node:20

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
