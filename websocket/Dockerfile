FROM node:24-alpine

WORKDIR /app

# Copy package.json first for better caching
COPY package.json .

# Install dependencies
RUN npm install

# Copy server script
COPY server.js .

EXPOSE 1234

CMD ["npm", "start"]