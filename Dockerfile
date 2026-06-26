FROM node:26-alpine
COPY . /app
WORKDIR /app
RUN npm ci --omit=dev  && npm cache clean --force
CMD ["npm", "start"]
