FROM node:20-slim

WORKDIR /app

COPY package*.json ./

RUN npm ci

RUN apt-get update && apt-get install -y ffmpeg

COPY . .

CMD ["npm", "start"]