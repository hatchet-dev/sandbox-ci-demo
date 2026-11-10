FROM golang:1.27-alpine AS base
WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY cmd ./cmd

FROM base AS build-go
ARG SERVER_TARGET
RUN if [ "$SERVER_TARGET" != "api" ] && [ "$SERVER_TARGET" != "worker" ]; then echo "SERVER_TARGET must be api or worker"; exit 1; fi
RUN CGO_ENABLED=0 go build -ldflags="-w -s" -o /app/bin/${SERVER_TARGET} ./cmd/${SERVER_TARGET}

FROM alpine AS deployment
ARG SERVER_TARGET
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build-go /app/bin/${SERVER_TARGET} /app/server
EXPOSE 8080
CMD ["/app/server"]
