FROM node:26-alpine
COPY . /app
WORKDIR /app
RUN npm ci --omit=dev
CMD ["npm", "start"]
