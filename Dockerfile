FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY server.js ./server.js

EXPOSE 3015
CMD ["npm", "start"]
