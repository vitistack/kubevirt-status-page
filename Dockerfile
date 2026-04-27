FROM golang:1.24 AS builder

WORKDIR /kubevirt-status-page

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN go build -o kubevirt-status-page ./cmd/server

FROM gcr.io/distroless/base

WORKDIR /app

COPY --from=builder /kubevirt-status-page/kubevirt-status-page .

CMD ["/app/kubevirt-status-page"]