FROM node:25-alpine
COPY . /app
WORKDIR /app
RUN npm ci --production
CMD ["npm", "start"]
