# Build Go backend
FROM golang:1.24.5-alpine3.22 AS go-builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o main main.go
RUN apk add --no-cache curl
RUN curl -L https://github.com/golang-migrate/migrate/releases/download/v4.16.2/migrate.linux-amd64.tar.gz | tar xvz && \
    mv migrate migrate.linux-amd64

# Production runtime (API only; the web app has its own image, web/Dockerfile).
# No app.env is baked in: configuration and secrets come from the environment
# (compose `environment:` / the orchestrator). LoadConfig treats app.env as optional.
FROM alpine:3.22
WORKDIR /app
RUN apk add --no-cache netcat-openbsd

# Copy Go backend
COPY --from=go-builder /app/main .
COPY --from=go-builder /app/migrate.linux-amd64 ./migrate
COPY start.sh .
COPY wait-for.sh .
RUN chmod +x start.sh
RUN chmod +x wait-for.sh

# Copy database migrations
COPY db/migration ./migration

EXPOSE 8080
CMD ["/app/main"]
ENTRYPOINT [ "/app/start.sh" ]
